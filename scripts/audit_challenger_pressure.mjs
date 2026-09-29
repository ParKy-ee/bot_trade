import mysql from 'mysql2/promise';
import fs from 'fs';

async function audit() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  // 1. Group by decision_mode & exit_reason
  const [combos] = await conn.query(`
    SELECT 
      decision_mode,
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(AVG(pips), 2) as avg_pips
    FROM trade_results
    WHERE (
      decision_mode LIKE '%CHALLENGER%' 
      OR exit_reason LIKE '%CHALLENGER%' 
      OR exit_reason LIKE '%PRESSURE%'
    )
    GROUP BY decision_mode, exit_reason
    ORDER BY count DESC
  `);

  // 2. Specific sample trades of CLOSED_PRESSURE_EARLY_CUT and EXIT_CHALLENGER_EARLY_CUT
  const [samples] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action, decision_mode,
      ROUND(entry_price, 5) as entry,
      ROUND(exit_price, 5) as exit_p,
      ROUND(pips, 2) as pips,
      ROUND(profit_loss, 2) as pnl,
      exit_reason,
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i:%s') as entry_bkk,
      DATE_FORMAT(CONVERT_TZ(exit_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i:%s') as exit_bkk,
      TIMESTAMPDIFF(MINUTE, entry_time, exit_time) as hold_minutes
    FROM trade_results
    WHERE exit_reason IN ('CLOSED_PRESSURE_EARLY_CUT', 'EXIT_CHALLENGER_EARLY_CUT', 'CLOSED_PRESSURE_PROFIT_LOCK', 'EXIT_CHALLENGER_STALL_HARVEST')
       OR (decision_mode LIKE '%CHALLENGER%' AND exit_reason LIKE '%PRESSURE%')
    ORDER BY id DESC
    LIMIT 30
  `);

  // 3. Compare Challenger decisions vs Champion decisions in LIVE trades
  const [liveModes] = await conn.query(`
    SELECT 
      decision_mode,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(AVG(pips), 2) as avg_pips
    FROM trade_results
    WHERE entry_time >= '2026-09-20 00:00:00'
    GROUP BY decision_mode
    ORDER BY count DESC
  `);

  // 4. Look at what happens to prices AFTER Early Cut (did the price reverse back into profit or continue to SL?)
  // We can look at the latest 10 samples
  fs.writeFileSync('scripts/audit_challenger_pressure_res.json', JSON.stringify({ combos, samples, liveModes }, null, 2), 'utf8');
  console.log('AUDIT_COMPLETE');
  await conn.end();
}

audit().catch(console.error);
