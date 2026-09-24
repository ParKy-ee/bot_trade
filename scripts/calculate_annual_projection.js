import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log('=== Daily Trade Frequency & Volume Analysis ===');
  const [dailyStats] = await pool.query(`
    SELECT 
      DATE(entry_time) AS trade_date,
      COUNT(*) AS total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl_usd,
      ROUND(SUM(pips), 1) AS total_pips,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(AVG(pips), 2) AS avg_pips_per_trade
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY trade_date
    ORDER BY trade_date DESC
    LIMIT 10
  `);
  console.table(dailyStats);

  // Calculate Best Performing Models Expectancy (Forex Champion v1.2/v1.3 + Crypto)
  const [championStats] = await pool.query(`
    SELECT 
      COALESCE(model_version, 'all') AS model_version,
      COUNT(*) AS trades,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(AVG(CASE WHEN is_win = 1 THEN profit_loss ELSE NULL END), 2) AS avg_win_usd,
      ROUND(AVG(CASE WHEN is_win = 0 THEN profit_loss ELSE NULL END), 2) AS avg_loss_usd,
      ROUND(AVG(CASE WHEN is_win = 1 THEN pips ELSE NULL END), 2) AS avg_win_pips,
      ROUND(AVG(CASE WHEN is_win = 0 THEN pips ELSE NULL END), 2) AS avg_loss_pips,
      ROUND(AVG(profit_loss), 2) AS expectancy_usd_per_trade,
      ROUND(AVG(pips), 2) AS expectancy_pips_per_trade
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND model_source IN ('forex_champion', 'forex_challenger')
    GROUP BY model_version
  `);
  console.log('\n=== Model Expectancy Statistics ===');
  console.table(championStats);

  // Calculate Golden Hours Expectancy (14:00 - 23:30 BKK)
  const [goldenHourStats] = await pool.query(`
    SELECT 
      COUNT(*) AS total_trades,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(AVG(profit_loss), 3) AS avg_pnl_usd,
      ROUND(AVG(pips), 2) AS avg_pips,
      ROUND(SUM(profit_loss), 2) AS net_pnl_usd,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' 
      AND (
        HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 14 AND 23
        OR HOUR(CONVERT_TZ(entry_time, '+00:00', '+07:00')) BETWEEN 5 AND 6
      )
  `);
  console.log('\n=== Golden Hours Expectancy ===');
  console.table(goldenHourStats);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
