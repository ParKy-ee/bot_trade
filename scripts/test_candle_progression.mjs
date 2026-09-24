import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  const [trades] = await conn.query(`
    SELECT t.id, t.symbol, t.action, t.entry_price, t.exit_price, t.pips, t.is_win, t.exit_reason, t.entry_time, t.exit_time
    FROM trade_results t
    WHERE t.id >= 9700 AND t.exit_time IS NOT NULL
    ORDER BY t.id DESC
    LIMIT 5
  `);
  console.log("Recent trades:", trades);

  // Check matching bars
  const [rows] = await conn.query(`
    SELECT 
      t.id as trade_id,
      t.symbol,
      t.action,
      t.entry_price,
      t.exit_price,
      t.is_win,
      t.exit_reason,
      b.time as bar_time,
      b.open,
      b.high,
      b.low,
      b.close,
      ROUND(b.rsi, 1) as rsi,
      ROUND(b.atr, 4) as atr,
      CASE 
        WHEN t.action = 'BUY' THEN ROUND((b.close - t.entry_price) * 10000, 1)
        ELSE ROUND((t.entry_price - b.close) * 10000, 1)
      END as floating_pips,
      CASE 
        WHEN t.action = 'BUY' THEN ROUND((b.high - t.entry_price) * 10000, 1)
        ELSE ROUND((t.entry_price - b.low) * 10000, 1)
      END as mfe_pips,
      CASE 
        WHEN t.action = 'BUY' THEN ROUND((b.low - t.entry_price) * 10000, 1)
        ELSE ROUND((t.entry_price - b.high) * 10000, 1)
      END as mae_pips
    FROM trade_results t
    JOIN market_bars b 
      ON t.symbol = b.symbol 
      AND b.time >= t.entry_time 
      AND b.time <= t.exit_time
    WHERE t.id >= 9700 AND t.exit_time IS NOT NULL
    ORDER BY t.id DESC, b.time ASC
    LIMIT 30
  `);

  console.log("Sample Intra-Trade Candle Progression (Count: " + rows.length + "):");
  console.table(rows);

  await conn.end();
}

run().catch(console.error);
