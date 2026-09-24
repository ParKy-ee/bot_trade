import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log('=== Signals Summary by Market Type ===');
  const [sigSummary] = await pool.query(`
    SELECT 
      market_type,
      COUNT(*) AS total_signals,
      MIN(time) AS first_signal,
      MAX(time) AS last_signal,
      AVG(ai_confidence) AS avg_conf,
      SUM(CASE WHEN action = 'BUY' THEN 1 ELSE 0 END) AS buy_signals,
      SUM(CASE WHEN action = 'SELL' THEN 1 ELSE 0 END) AS sell_signals
    FROM signals
    GROUP BY market_type
  `);
  console.table(sigSummary);

  console.log('\n=== Crypto Signals by Symbol ===');
  const [cryptoBySym] = await pool.query(`
    SELECT 
      symbol,
      action,
      COUNT(*) AS count,
      AVG(ai_confidence) AS avg_conf,
      AVG(price) AS avg_price
    FROM signals
    WHERE market_type = 'crypto'
    GROUP BY symbol, action
  `);
  console.table(cryptoBySym);

  console.log('\n=== Recent Crypto Signals (Last 15) ===');
  const [recentCryptoSignals] = await pool.query(`
    SELECT id, time, symbol, price, ai_confidence, sl_price, tp_price, action, source_tag
    FROM signals
    WHERE market_type = 'crypto'
    ORDER BY id DESC
    LIMIT 15
  `);
  console.table(recentCryptoSignals);

  // Let's also check cryptoEngine.js and how crypto signals are processed vs forex signals
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
