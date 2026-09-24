import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log('===============================================================');
  console.log('📊 1. Performance Summary by Model Source & Model Version');
  console.log('===============================================================');
  const [modelStats] = await pool.query(`
    SELECT 
      COALESCE(model_source, 'legacy') AS model_source,
      COALESCE(model_version, 'unknown') AS model_version,
      decision_mode,
      COUNT(*) AS total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END) AS closed_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS profit_factor,
      ROUND(AVG(pips), 2) AS avg_pips,
      ROUND(SUM(pips), 2) AS total_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    GROUP BY model_source, model_version, decision_mode
    ORDER BY total_trades DESC
  `);
  console.table(modelStats);

  console.log('\n===============================================================');
  console.log('📊 2. Today (2026-09-15) Detailed Performance Breakdown');
  console.log('===============================================================');
  const [todayStats] = await pool.query(`
    SELECT 
      market_type,
      decision_mode,
      exit_reason,
      COUNT(*) AS count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(pips), 2) AS total_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE DATE(entry_time) = '2026-09-15'
    GROUP BY market_type, decision_mode, exit_reason
    ORDER BY market_type, count DESC
  `);
  console.table(todayStats);

  console.log('\n===============================================================');
  console.log('🕒 3. Performance by Hour of Day (Bangkok Time GMT+7)');
  console.log('===============================================================');
  const [hourlyStats] = await pool.query(`
    SELECT 
      HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) AS bkk_hour,
      COUNT(*) AS total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(pips), 2) AS total_pips,
      ROUND(AVG(pips), 2) AS avg_pips,
      ROUND(AVG(ai_confidence), 3) AS avg_conf
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY bkk_hour
    ORDER BY bkk_hour ASC
  `);
  console.table(hourlyStats);

  console.log('\n===============================================================');
  console.log('🌍 4. Performance by Market Trading Session (Bangkok Time)');
  console.log('===============================================================');
  const [sessionStats] = await pool.query(`
    SELECT 
      CASE 
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 7 AND 13 THEN '1. Asian Session (07:00 - 14:00)'
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 14 AND 18 THEN '2. London Open / European (14:00 - 19:00)'
        WHEN HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 19 AND 23 THEN '3. NY Overlap / US Peak (19:00 - 00:00)'
        ELSE '4. Late Night / Pacific Rollover (00:00 - 07:00)'
      END AS market_session,
      COUNT(*) AS closed_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS profit_factor,
      ROUND(SUM(pips), 2) AS total_pips,
      ROUND(AVG(pips), 2) AS avg_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY market_session
    ORDER BY market_session ASC
  `);
  console.table(sessionStats);

  console.log('\n===============================================================');
  console.log('🪙 5. Profitability & Win Rate by Currency Pair / Symbol');
  console.log('===============================================================');
  const [symbolPerformance] = await pool.query(`
    SELECT 
      symbol,
      market_type,
      COUNT(*) AS closed_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS profit_factor,
      ROUND(SUM(pips), 2) AS total_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY symbol, market_type
    ORDER BY total_pnl_usd DESC
  `);
  console.table(symbolPerformance);

  console.log('\n===============================================================');
  console.log('⚡ 6. Exit Reason Performance (All Closed Trades)');
  console.log('===============================================================');
  const [exitStats] = await pool.query(`
    SELECT 
      exit_reason,
      COUNT(*) AS count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(pips), 2) AS total_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY exit_reason
    ORDER BY total_pnl_usd DESC
  `);
  console.table(exitStats);

  // 7. Recent 15 Closed Trades Sample
  console.log('\n===============================================================');
  console.log('📝 7. Latest 15 Closed Trades Log');
  console.log('===============================================================');
  const [recentTrades] = await pool.query(`
    SELECT 
      id,
      mt5_ticket,
      symbol,
      action,
      decision_mode,
      model_version,
      entry_time,
      exit_time,
      exit_reason,
      pips,
      profit_loss,
      is_win,
      hold_duration_minutes,
      ROUND(ai_confidence * 100, 1) AS conf_pct
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    ORDER BY id DESC
    LIMIT 15
  `);
  console.table(recentTrades);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
