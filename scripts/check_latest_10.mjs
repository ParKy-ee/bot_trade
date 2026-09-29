import mysql from 'mysql2/promise';

async function checkLatestTrades() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  const [trades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action, market_type,
      ROUND(entry_price, 5) as entry,
      ROUND(exit_price, 5) as exit_p,
      ROUND(pips, 2) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win,
      exit_reason,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_time_bkk,
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_time_bkk,
      TIMESTAMPDIFF(MINUTE, entry_time, exit_time) as hold_min
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 12:16:00'
      AND exit_reason != 'OPEN'
    ORDER BY id DESC
    LIMIT 20
  `);

  console.log("=== LATEST 15 LIVE TRADES ===");
  console.table(trades);

  // Also check active open positions right now
  const [openTrades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action, market_type,
      ROUND(entry_price, 5) as entry,
      exit_reason,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_time_bkk
    FROM trade_results
    WHERE decision_mode = 'LIVE' AND exit_reason = 'OPEN'
    ORDER BY id DESC
  `);
  console.log("=== CURRENT OPEN LIVE TRADES ===");
  console.table(openTrades);

  const [todaySummary] = await conn.query(`
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_pnl,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 00:00:00'
      AND exit_reason != 'OPEN'
  `);
  console.log("=== FULL DAY TODAY LIVE SUMMARY ===");
  console.table(todaySummary);

  await conn.end();
}

checkLatestTrades().catch(console.error);
