import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ai_trading_db'
  });

  const [overall] = await conn.query(`
    SELECT 
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) as closed_orders,
      SUM(CASE WHEN exit_reason = 'OPEN' OR exit_price IS NULL THEN 1 ELSE 0 END) as open_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) as win_rate_pct,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) as loss_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as total_pnl_usd,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 2) as total_pips
    FROM trade_results
    WHERE DATE(CONVERT_TZ(created_at, '+00:00', '+07:00')) = '2026-09-14'
  `);
  console.log("=== 1. YESTERDAY (2026-09-14) OVERALL SUMMARY ===");
  console.table(overall);

  const [byModel] = await conn.query(`
    SELECT 
      COALESCE(decision_mode, 'LIVE') as mode,
      COALESCE(model_source, 'unspecified') as model,
      COALESCE(model_version, '-') as version,
      COUNT(*) as total,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN exit_reason = 'OPEN' OR exit_price IS NULL THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 2) as net_pips
    FROM trade_results
    WHERE DATE(CONVERT_TZ(created_at, '+00:00', '+07:00')) = '2026-09-14'
    GROUP BY decision_mode, model_source, model_version
    ORDER BY net_usd DESC
  `);
  console.log("\n=== 2. YESTERDAY BREAKDOWN BY MODEL & MODE ===");
  console.table(byModel);

  const [bySymbol] = await conn.query(`
    SELECT 
      symbol,
      COUNT(*) as total,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 2) as net_pips
    FROM trade_results
    WHERE DATE(CONVERT_TZ(created_at, '+00:00', '+07:00')) = '2026-09-14'
    GROUP BY symbol
    ORDER BY net_usd DESC
  `);
  console.log("\n=== 3. YESTERDAY PERFORMANCE BY SYMBOL ===");
  console.table(bySymbol);

  await conn.end();
}

run().catch(console.error);
