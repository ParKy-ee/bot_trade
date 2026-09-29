import mysql from 'mysql2/promise';
import fs from 'fs';

async function run() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  // 1. By Symbol Today Live
  const [symbols] = await conn.query(`
    SELECT 
      symbol,
      market_type,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 00:00:00'
      AND exit_reason != 'OPEN'
    GROUP BY symbol, market_type
    ORDER BY pnl_usd DESC
  `);

  // 2. By Exit Reason Today Live
  const [exits] = await conn.query(`
    SELECT 
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 2) as avg_pips
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 00:00:00'
      AND exit_reason != 'OPEN'
    GROUP BY exit_reason
    ORDER BY count DESC
  `);

  // 3. Hourly Performance Today Live
  const [hourly] = await conn.query(`
    SELECT 
      CONCAT(LPAD(HOUR(entry_time), 2, '0'), ':00 - ', LPAD(HOUR(entry_time), 2, '0'), ':59') as time_slot,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 00:00:00'
      AND exit_reason != 'OPEN'
    GROUP BY HOUR(entry_time)
    ORDER BY HOUR(entry_time) ASC
  `);

  // 4. Grand Total Today
  const [grand] = await conn.query(`
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_pnl,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 00:00:00'
      AND exit_reason != 'OPEN'
  `);

  // 5. Market Pressure specific impact today
  const [pressureImpact] = await conn.query(`
    SELECT 
      exit_reason,
      COUNT(*) as count,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 2) as avg_pips
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND entry_time >= '2026-09-25 00:00:00'
      AND exit_reason LIKE '%PRESSURE%'
    GROUP BY exit_reason
  `);

  fs.writeFileSync('scripts/today_orders_report.json', JSON.stringify({ symbols, exits, hourly, grand, pressureImpact }, null, 2), 'utf8');
  console.log('REPORT_GENERATED');
  await conn.end();
}

run().catch(console.error);
