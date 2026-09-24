import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  // Find id of first trade after 11:10:00 AM Bangkok
  const [firstAfterPatch] = await conn.query(`
    SELECT id, created_at, entry_time
    FROM trade_results
    WHERE created_at >= '2026-09-24 04:10:00' OR created_at >= '2026-09-24 11:10:00'
    ORDER BY id ASC
    LIMIT 1
  `);
  console.log("First record after 11:10:", firstAfterPatch);

  const startId = firstAfterPatch.length > 0 ? firstAfterPatch[0].id : 9650;
  console.log("Filtering from ID:", startId);

  // Closed trades since patch
  const [closed] = await conn.query(`
    SELECT 
      id, symbol, market_type, action, decision_mode,
      created_at,
      exit_time,
      entry_price, exit_price,
      ROUND(pips, 1) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win, exit_reason
    FROM trade_results
    WHERE id >= ? AND exit_time IS NOT NULL AND exit_reason != 'OPEN'
    ORDER BY id DESC
  `, [startId]);
  console.log(`\n=== CLOSED TRADES SINCE 11:10 PATCH (Count: ${closed.length}) ===`);
  console.table(closed.slice(0, 30));

  // Summary by market_type & decision_mode
  const [summary] = await conn.query(`
    SELECT 
      market_type,
      decision_mode,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100, 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 1) as avg_pips
    FROM trade_results
    WHERE id >= ? AND exit_time IS NOT NULL AND exit_reason != 'OPEN'
    GROUP BY market_type, decision_mode
  `, [startId]);
  console.log(`\n=== PERFORMANCE SUMMARY SINCE PATCH ===`);
  console.table(summary);

  // Summary by Symbol
  const [symSummary] = await conn.query(`
    SELECT 
      symbol,
      market_type,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100, 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE id >= ? AND exit_time IS NOT NULL AND exit_reason != 'OPEN'
    GROUP BY symbol, market_type
    ORDER BY market_type, total_pnl DESC
  `, [startId]);
  console.log(`\n=== PERFORMANCE BY SYMBOL ===`);
  console.table(symSummary);

  // Open Trades
  const [open] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, market_type, action, decision_mode,
      created_at, entry_price, sl_price, tp_price,
      ROUND(ai_confidence * 100, 1) as conf_pct
    FROM trade_results
    WHERE exit_time IS NULL OR exit_reason = 'OPEN'
    ORDER BY id DESC
  `);
  console.log(`\n=== CURRENT OPEN TRADES (Count: ${open.length}) ===`);
  console.table(open);

  await conn.end();
}

run().catch(console.error);
