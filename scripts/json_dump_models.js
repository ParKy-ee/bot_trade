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
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS win_rate,
      ROUND(SUM(profit_loss), 2) AS net_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS pf,
      ROUND(SUM(pips), 1) AS total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND profit_loss IS NOT NULL
    GROUP BY model_source, model_version, decision_mode
    ORDER BY net_pnl DESC
  `);
  console.log(JSON.stringify(m, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
