import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=== CHECKING DATABASE SCHEMA & DATA SINCE PATCH ===");

  // 1. Describe trade_results
  const [cols] = await conn.query("DESCRIBE trade_results");
  console.log("trade_results columns:", cols.map(c => c.Field).join(", "));

  // 2. Fetch trade_results since 2026-09-24 10:00:00
  const [trades] = await conn.query(`
    SELECT *
    FROM trade_results
    WHERE (exit_time >= '2026-09-24 10:00:00' OR entry_time >= '2026-09-24 10:00:00')
    ORDER BY id DESC
    LIMIT 50
  `);
  console.log(`\n--- trade_results (Count: ${trades.length}) ---`);
  console.table(trades);

  // 3. Describe & Fetch active_positions
  const [activeCols] = await conn.query("DESCRIBE active_positions");
  console.log("\nactive_positions columns:", activeCols.map(c => c.Field).join(", "));
  const [active] = await conn.query("SELECT * FROM active_positions");
  console.log("--- Current active_positions ---");
  console.table(active);

  // 4. Forex observations summary since 10:30
  const [obsSummary] = await conn.query(`
    SELECT 
      symbol,
      COUNT(*) as total_obs,
      SUM(CASE WHEN pocket_eval = 'MT5_LIVE_READY' THEN 1 ELSE 0 END) as live_ready,
      SUM(CASE WHEN pocket_eval = 'SHADOW_ONLY' THEN 1 ELSE 0 END) as shadow_only,
      SUM(CASE WHEN pocket_eval = 'EXPLORE_SHADOW' THEN 1 ELSE 0 END) as explore_shadow,
      SUM(CASE WHEN pocket_eval = 'REJECTED' THEN 1 ELSE 0 END) as rejected
    FROM forex_ml_observations
    WHERE created_at >= '2026-09-24 10:30:00'
    GROUP BY symbol
  `);
  console.log("\n--- forex_ml_observations since 10:30:00 ---");
  console.table(obsSummary);

  // 5. Total counts of win/loss in trade_results today
  const [todaySummary] = await conn.query(`
    SELECT 
      source,
      COUNT(*) as total_trades,
      SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(CASE WHEN win = 1 THEN 1 ELSE 0 END) * 100, 1) as win_rate_pct,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE DATE(exit_time) = '2026-09-24'
    GROUP BY source
  `);
  console.log("\n--- Today's Performance by Source (Live vs Shadow) ---");
  console.table(todaySummary);

  await conn.end();
}

run().catch(console.error);
