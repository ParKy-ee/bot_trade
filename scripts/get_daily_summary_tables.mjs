import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getOpenPositions } from '../services/mt5Broker.js';

dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=========================================================================");
  console.log("📊 1. LIVE MT5 OPEN POSITIONS (ณ เวลาปัจจุบัน 11:26 BKK)");
  console.log("=========================================================================");
  try {
    const pos = await getOpenPositions();
    console.table(pos);
  } catch (err) {
    console.error("Error fetching MT5 positions:", err.message);
  }

  console.log("\n=========================================================================");
  console.log("📈 2. TODAY CLOSED TRADES SUMMARY BY MARKET (2026-09-25)");
  console.log("=========================================================================");
  const [summary] = await conn.query(`
    SELECT 
      market_type,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as win_count,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as loss_count,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-25 00:00:00'
      AND exit_reason != 'OPEN'
    GROUP BY market_type
  `);
  console.table(summary);

  console.log("\n=========================================================================");
  console.log("🎯 3. TODAY LIVE MT5 TRADES DETAILS (CLOSED + OPEN)");
  console.log("=========================================================================");
  const [liveTrades] = await conn.query(`
    SELECT id, mt5_ticket, symbol, action, market_type,
           ROUND(entry_price, 5) as entry,
           ROUND(exit_price, 5) as exit_price,
           ROUND(pips, 1) as pips,
           ROUND(profit_loss, 2) as pnl,
           is_win, exit_reason,
           DATE_FORMAT(entry_time, '%H:%i') as entry_bkk,
           DATE_FORMAT(exit_time, '%H:%i') as exit_bkk
    FROM trade_results
    WHERE entry_time >= '2026-09-25 00:00:00'
      AND decision_mode = 'LIVE'
    ORDER BY id ASC
  `);
  console.table(liveTrades);

  console.log("\n=========================================================================");
  console.log("🧭 4. LATEST MARKET PRESSURE OBSERVATIONS ACROSS ASSETS (M5)");
  console.log("=========================================================================");
  const [latestPressure] = await conn.query(`
    SELECT t1.symbol,
           DATE_FORMAT(t1.bar_time, '%H:%i') as bar_bkk,
           ROUND(t1.close_price, 4) as price,
           t1.predicted_state,
           ROUND(t1.prob_buy*100, 1) as buy_pct,
           ROUND(t1.prob_sell*100, 1) as sell_pct,
           ROUND(t1.prob_indecision*100, 1) as chop_pct,
           ROUND(t1.expected_net_pips, 2) as exp_pts
    FROM market_pressure_observations t1
    INNER JOIN (
      SELECT symbol, MAX(id) as max_id
      FROM market_pressure_observations
      GROUP BY symbol
    ) t2 ON t1.id = t2.max_id
    ORDER BY t1.symbol ASC
  `);
  console.table(latestPressure);

  await conn.end();
}

main().catch(console.error);
