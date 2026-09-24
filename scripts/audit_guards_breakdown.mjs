import { getPool } from '../config/database.js';

async function audit() {
  const pool = await getPool();

  console.log("=== DETAIL GUARD BREAKDOWN ===");
  const [rows] = await pool.query(`
    SELECT filter_reasons, COUNT(*) as c
    FROM forex_ml_observations
    WHERE DATE(created_at) = CURRENT_DATE() AND sample_kind = 'REJECTED'
    GROUP BY filter_reasons
    ORDER BY c DESC LIMIT 15
  `);
  
  for (const r of rows) {
    console.log(`Count: ${r.c}`);
    try {
      const parsed = JSON.parse(r.filter_reasons);
      console.log('Reasons:', parsed);
    } catch {
      console.log('Raw:', r.filter_reasons);
    }
    console.log('-'.repeat(50));
  }

  // Also check since server restart time (~09:55 AM)
  const [restartRows] = await pool.query(`
    SELECT sample_kind, COUNT(*) as c
    FROM forex_ml_observations
    WHERE created_at >= '2026-09-23 09:55:00'
    GROUP BY sample_kind
  `);
  console.log("\nForex Since Restart (09:55:00 AM):", restartRows);

  const [cryptoTrades] = await pool.query(`
    SELECT id, symbol, action, profit_loss, is_win, exit_reason, created_at, updated_at
    FROM trade_results
    WHERE market_type = 'crypto' AND created_at >= '2026-09-23 09:00:00'
    ORDER BY id DESC
  `);
  console.log("\nCrypto Trades Since 09:00 AM:", cryptoTrades);

  const [allOpen] = await pool.query(`
    SELECT id, symbol, market_type, entry_price, highest_price, sl_price, tp_price, status_note, created_at
    FROM active_positions
  `);
  console.log("\nCurrent Active Positions in DB:", allOpen);

  process.exit(0);
}

audit();
