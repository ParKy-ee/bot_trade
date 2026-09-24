import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();
  const [m] = await pool.query(`
    SELECT 
      COALESCE(model_source, 'legacy') AS source,
      COALESCE(model_version, 'unknown') AS version,
      decision_mode,
      COUNT(*) AS total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS pf,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY model_source, model_version, decision_mode
    ORDER BY net_pnl DESC
  `);
  console.log('=== Model Breakdown ===');
  console.table(m);

  const [s] = await pool.query(`
    SELECT 
      CASE 
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 7 AND 13 THEN '1. Asian Session (07:00-14:00)'
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 14 AND 18 THEN '2. London Session (14:00-19:00)'
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 19 AND 23 THEN '3. NY Overlap/Peak (19:00-00:00)'
        ELSE '4. Late Night/Pacific (00:00-07:00)'
      END AS session,
      COUNT(*) AS trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS pf,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY session
    ORDER BY session ASC
  `);
  console.log('\n=== Session Breakdown ===');
  console.table(s);

  // Let's also check trades closed TODAY (2026-09-15) after 12:45 when micro-scalper was enabled
  const [recentMicro] = await pool.query(`
    SELECT 
      id, mt5_ticket, symbol, action, decision_mode, exit_reason, pips, profit_loss, is_win, hold_duration_minutes, entry_time, exit_time
    FROM trade_results
    WHERE exit_time >= '2026-09-15 12:45:00' OR created_at >= '2026-09-15 12:45:00'
    ORDER BY id DESC
  `);
  console.log('\n=== Trades Closed after Micro-Scalper Activation ===');
  console.table(recentMicro);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
