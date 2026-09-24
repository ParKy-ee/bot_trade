import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log('=== TABLE 1: Model Comparison (Source, Version, Decision Mode) ===');
  const [modelStats] = await pool.query(`
    SELECT 
      COALESCE(model_source, 'legacy') AS source,
      COALESCE(model_version, 'unknown') AS version,
      decision_mode,
      COUNT(*) AS total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(AVG(profit_loss), 2) AS avg_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS pf,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY model_source, model_version, decision_mode
    ORDER BY total DESC
  `);
  console.table(modelStats);

  console.log('\n=== TABLE 2: Session Performance (Bangkok Time GMT+7) ===');
  const [sessionStats] = await pool.query(`
    SELECT 
      CASE 
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 7 AND 13 THEN '1. Asian Session (07:00-14:00)'
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 14 AND 18 THEN '2. London Session (14:00-19:00)'
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 19 AND 23 THEN '3. NY Overlap/Peak (19:00-00:00)'
        ELSE '4. Late Night/Pacific (00:00-07:00)'
      END AS session,
      COUNT(*) AS trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(AVG(profit_loss), 2) AS avg_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS pf,
      ROUND(SUM(pips), 1) AS total_pips,
      ROUND(AVG(hold_duration_minutes), 0) AS avg_hold_m
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY session
    ORDER BY session ASC
  `);
  console.table(sessionStats);

  console.log('\n=== TABLE 3: Hourly Breakdown (Bangkok Time GMT+7) ===');
  const [hourlyStats] = await pool.query(`
    SELECT 
      HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) AS hour_bkk,
      COUNT(*) AS trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY hour_bkk
    ORDER BY hour_bkk ASC
  `);
  console.table(hourlyStats);

  console.log('\n=== TABLE 4: Pair / Symbol Performance Ranking ===');
  const [symbolPerformance] = await pool.query(`
    SELECT 
      symbol,
      market_type,
      COUNT(*) AS trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS pf,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY symbol, market_type
    ORDER BY net_pnl DESC
  `);
  console.table(symbolPerformance);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
