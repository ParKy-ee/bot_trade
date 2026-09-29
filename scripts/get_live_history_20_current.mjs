import mysql from 'mysql2/promise';
import fs from 'fs';

async function queryLive() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  // Daily by Market
  const [daily] = await conn.query(`
    SELECT 
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%Y-%m-%d') as trade_date,
      market_type,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE entry_time >= '2026-09-19 17:00:00'
      AND decision_mode = 'LIVE'
      AND exit_reason != 'OPEN'
    GROUP BY trade_date, market_type
    ORDER BY trade_date ASC, market_type ASC
  `);

  // Overall Daily (All Live Markets combined)
  const [overallDaily] = await conn.query(`
    SELECT 
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%Y-%m-%d') as trade_date,
      DAYNAME(CONVERT_TZ(entry_time, '+00:00', '+07:00')) as day_name,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE entry_time >= '2026-09-19 17:00:00'
      AND decision_mode = 'LIVE'
      AND exit_reason != 'OPEN'
    GROUP BY trade_date, day_name
    ORDER BY trade_date ASC
  `);

  // Total Summary by Market (20 Sept - Current)
  const [totalByMarket] = await conn.query(`
    SELECT 
      market_type,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE entry_time >= '2026-09-19 17:00:00'
      AND decision_mode = 'LIVE'
      AND exit_reason != 'OPEN'
    GROUP BY market_type
    ORDER BY total_trades DESC
  `);

  // Grand Total
  const [grandTotal] = await conn.query(`
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE entry_time >= '2026-09-19 17:00:00'
      AND decision_mode = 'LIVE'
      AND exit_reason != 'OPEN'
  `);

  // Exit reasons across the period
  const [exitReasons] = await conn.query(`
    SELECT 
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-19 17:00:00'
      AND decision_mode = 'LIVE'
      AND exit_reason != 'OPEN'
    GROUP BY exit_reason
    ORDER BY count DESC
  `);

  // Crypto details
  const [cryptoSymbols] = await conn.query(`
    SELECT 
      symbol,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-19 17:00:00'
      AND decision_mode = 'LIVE'
      AND market_type = 'crypto'
      AND exit_reason != 'OPEN'
    GROUP BY symbol
    ORDER BY total_trades DESC
  `);

  const results = { daily, overallDaily, totalByMarket, grandTotal, exitReasons, cryptoSymbols };
  fs.writeFileSync('scripts/live_history_20_current.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('QUERY_SUCCESS');
  await conn.end();
}

queryLive().catch(console.error);
