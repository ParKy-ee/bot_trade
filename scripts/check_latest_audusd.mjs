import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ai_trading_db'
});

async function main() {
  const [bars] = await pool.query(`
    SELECT time, open, high, low, close, volume, created_at
    FROM market_bars
    WHERE symbol IN ('AUDUSD', 'AUDUSD=X')
    ORDER BY time DESC
    LIMIT 10
  `);
  console.log('=== Latest AUDUSD Bars ===');
  console.table(bars);

  const [obs] = await pool.query(`
    SELECT id, bar_time, created_at, close_price, forward_close_3,
           predicted_state, prob_buy, prob_sell, prob_indecision,
           actual_state, is_correct, outcome_status
    FROM market_pressure_observations
    WHERE symbol = 'AUDUSD'
    ORDER BY id DESC
    LIMIT 10
  `);
  console.log('=== Latest AUDUSD Observations ===');
  console.table(obs);

  const [trades] = await pool.query(`
    SELECT id, ticket, symbol, type, lots, open_price, current_price, profit, sl, tp, status, created_at
    FROM trades
    WHERE symbol LIKE '%AUDUSD%' AND status = 'OPEN'
  `);
  console.log('=== Active AUDUSD Trades ===');
  console.table(trades);

  await pool.end();
}
main();
