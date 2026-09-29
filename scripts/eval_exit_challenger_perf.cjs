const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: process.env.DB_NAME || 'ai_trading_db'
  });

  // 1. Overall breakdown of exit reasons since Sep 24
  const [rows] = await pool.query(`
    SELECT
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as net_pips,
      ROUND(AVG(pips), 2) as avg_pips_per_trade,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins
    FROM trade_results
    WHERE created_at >= '2026-09-24 14:35:00'
      AND exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
      AND exit_price IS NOT NULL
    GROUP BY exit_reason
    ORDER BY count DESC
  `);
  console.log('=== PERFORMANCE OF EXITS SINCE CHALLENGER-EXIT-V1.1.0 DEPLOYMENT (SEP 24) ===');
  console.table(rows);

  // 2. Head-to-Head Comparison:
  // Before Challenger-Exit (Trades closed before Sep 24 14:35) vs After Challenger-Exit (Trades closed after Sep 24 14:35)
  // for Forex Shadow
  const [beforeAfter] = await pool.query(`
    SELECT
      CASE
        WHEN created_at < '2026-09-24 14:35:00' THEN 'BEFORE v1.1.0 (Legacy Hard Exit / Fixed Rules)'
        ELSE 'AFTER v1.1.0 (Active Challenger Exit AI)'
      END as period,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as net_pips,
      ROUND(
        ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) /
        NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0),
        2
      ) as profit_factor,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins
    FROM trade_results
    WHERE market_type IN ('forex', 'forex_shadow')
      AND exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
      AND exit_price IS NOT NULL
      AND created_at >= '2026-09-17 00:00:00'
    GROUP BY period
    ORDER BY period DESC
  `);
  console.log('\n=== FOREX BEFORE vs AFTER CHALLENGER-EXIT-V1.1.0 ===');
  console.table(beforeAfter);

  await pool.end();
})();
