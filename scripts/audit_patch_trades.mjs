import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=== DETAILED PATCH AUDIT (SINCE ~10:30 TO CURRENT 13:45) ===");

  // 1. Closed trades after 10:30 today
  const [closedSincePatch] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, market_type, action, decision_mode,
      entry_time, exit_time, entry_price, exit_price,
      ROUND(pips, 1) as pips, 
      ROUND(profit_loss, 2) as pnl, 
      is_win, exit_reason, hold_duration_minutes
    FROM trade_results
    WHERE exit_time >= '2026-09-24 10:30:00'
    ORDER BY exit_time DESC
  `);
  console.log(`\n1. Closed Trades since Patch (Count: ${closedSincePatch.length}):`);
  console.table(closedSincePatch);

  // 2. Open Trades right now
  const [openTrades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, market_type, action, decision_mode,
      entry_time, entry_price, sl_price, tp_price,
      ROUND(ai_confidence * 100, 1) as conf_pct,
      exit_reason
    FROM trade_results
    WHERE exit_time IS NULL OR exit_reason = 'OPEN'
    ORDER BY entry_time DESC
  `);
  console.log(`\n2. Currently Open Trades (Count: ${openTrades.length}):`);
  console.table(openTrades);

  // 3. Summary of all closed trades today (by market_type)
  const [closedTodaySummary] = await conn.query(`
    SELECT 
      market_type,
      decision_mode,
      COUNT(*) as total_closed,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100, 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 1) as avg_pips
    FROM trade_results
    WHERE exit_time >= '2026-09-24 00:00:00'
    GROUP BY market_type, decision_mode
  `);
  console.log(`\n3. All Closed Trades Today by Type:`);
  console.table(closedTodaySummary);

  // 4. Check active_positions table
  const [activePos] = await conn.query(`SELECT * FROM active_positions`);
  console.log(`\n4. active_positions table (Count: ${activePos.length}):`);
  console.table(activePos);

  // 5. Check if any crypto / gold trades occurred
  const [otherMarkets] = await conn.query(`
    SELECT market_type, COUNT(*) as cnt, MAX(entry_time) as latest_entry
    FROM trade_results
    WHERE entry_time >= '2026-09-24 10:30:00'
    GROUP BY market_type
  `);
  console.log(`\n5. Trade Distribution across markets since 10:30:`);
  console.table(otherMarkets);

  await conn.end();
}

run().catch(console.error);
