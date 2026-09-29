import mysql from 'mysql2/promise';
import fs from 'fs';

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  // 1. Live forex trades breakdown by exit_reason
  const [liveExits] = await conn.query(`
    SELECT 
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(AVG(pips), 2) as avg_pips,
      ROUND(AVG(TIMESTAMPDIFF(MINUTE, entry_time, exit_time)), 1) as avg_hold_minutes
    FROM trade_results
    WHERE decision_mode = 'LIVE' AND market_type = 'forex' AND entry_time >= '2026-09-20 00:00:00'
    GROUP BY exit_reason
    ORDER BY count DESC
  `);

  // 2. Sample trades that exited via CLOSED_PRESSURE_EARLY_CUT or CLOSED_PRESSURE_PROFIT_LOCK
  const [pressureExits] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action,
      ROUND(entry_price, 5) as entry,
      ROUND(exit_price, 5) as exit_p,
      ROUND(pips, 2) as pips,
      ROUND(profit_loss, 2) as pnl,
      exit_reason,
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i:%s') as entry_bkk,
      DATE_FORMAT(CONVERT_TZ(exit_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i:%s') as exit_bkk,
      TIMESTAMPDIFF(MINUTE, entry_time, exit_time) as hold_minutes
    FROM trade_results
    WHERE decision_mode = 'LIVE' 
      AND exit_reason LIKE '%PRESSURE%'
    ORDER BY id DESC
    LIMIT 20
  `);

  // 3. Inspect recent losses in LIVE Forex (CLOSED_SL) to see if they were entered by Challenger
  const [recentSL] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action,
      ROUND(entry_price, 5) as entry,
      ROUND(exit_price, 5) as exit_p,
      ROUND(pips, 2) as pips,
      ROUND(profit_loss, 2) as pnl,
      exit_reason,
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i:%s') as entry_bkk,
      DATE_FORMAT(CONVERT_TZ(exit_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i:%s') as exit_bkk,
      TIMESTAMPDIFF(MINUTE, entry_time, exit_time) as hold_minutes
    FROM trade_results
    WHERE decision_mode = 'LIVE' AND market_type = 'forex' AND exit_reason = 'CLOSED_SL'
    ORDER BY id DESC
    LIMIT 20
  `);

  // 4. Check market_pressure_observations around those trades
  const [obsSummary] = await conn.query(`
    SELECT 
      predicted_state,
      COUNT(*) as count,
      ROUND(AVG(prob_buy), 3) as avg_prob_buy,
      ROUND(AVG(prob_sell), 3) as avg_prob_sell,
      ROUND(AVG(prob_indecision), 3) as avg_prob_indecision,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct_count,
      ROUND(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(is_correct), 0), 1) as accuracy_pct
    FROM market_pressure_observations
    GROUP BY predicted_state
  `);

  const out = { liveExits, pressureExits, recentSL, obsSummary };
  fs.writeFileSync('scripts/analyze_combo_res.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('ANALYZE_COMBO_DONE');
  await conn.end();
}

main().catch(console.error);
