import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getOpenPositions, getRates } from '../services/mt5Broker.js';
dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=== 1. MT5 Open Positions ===");
  try {
    const pos = await getOpenPositions();
    console.table(pos);
  } catch (err) {
    console.error("Error fetching MT5 positions:", err.message);
  }

  console.log("=== 2. Latest AUDUSD Rates from MT5 ===");
  try {
    const rates = await getRates('AUDUSD#', 5);
    console.table(rates.slice(-5));
  } catch (err) {
    try {
      const rates2 = await getRates('AUDUSD', 5);
      console.table(rates2.slice(-5));
    } catch (e) {
      console.error("Error fetching rates:", e.message);
    }
  }

  console.log("=== 3. Latest Market Pressure Observations for AUDUSD (Past 10) ===");
  const [obs] = await conn.query(`
    SELECT 
      id,
      symbol,
      DATE_FORMAT(bar_time, '%H:%i:%s') as bar_time,
      DATE_FORMAT(observed_at, '%H:%i:%s') as observed_at,
      ROUND(close_price, 5) as close_t0,
      ROUND(forward_close_3, 5) as forward_t3,
      ROUND((forward_close_3 - close_price) * 10000, 1) as delta_pips,
      predicted_state,
      ROUND(prob_buy * 100, 1) as buy_pct,
      ROUND(prob_sell * 100, 1) as sell_pct,
      ROUND(prob_indecision * 100, 1) as chop_pct,
      actual_state,
      outcome_status,
      is_correct
    FROM market_pressure_observations
    WHERE symbol LIKE '%AUDUSD%'
    ORDER BY id DESC
    LIMIT 10
  `);
  console.table(obs.reverse());

  await conn.end();
}
main().catch(console.error);
