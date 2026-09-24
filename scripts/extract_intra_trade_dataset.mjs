import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("📥 Extracting intra-trade bars from database...");

  const [rows] = await conn.query(`
    SELECT 
        t.id AS trade_id,
        t.symbol,
        t.action,
        t.entry_price,
        t.exit_price,
        t.is_win,
        t.pips AS final_pips,
        t.profit_loss AS final_pnl,
        t.exit_reason,
        t.entry_time,
        t.exit_time,
        b.time AS bar_time,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.rsi,
        b.atr
    FROM trade_results t
    JOIN market_bars b 
        ON t.symbol = b.symbol 
        AND b.time >= t.entry_time 
        AND b.time <= t.exit_time
    WHERE t.id >= 8500 
      AND t.exit_time IS NOT NULL 
      AND t.market_type IN ('forex', 'forex_shadow')
      AND t.entry_price > 0
    ORDER BY t.id ASC, b.time ASC;
  `);

  console.log(`✅ Extracted ${rows.length} intra-trade bars.`);
  
  const outPath = path.resolve('data/intra_trade_progression.json');
  fs.writeFileSync(outPath, JSON.stringify(rows));
  console.log(`💾 Saved dataset to ${outPath}`);

  await conn.end();
}

run().catch(console.error);
