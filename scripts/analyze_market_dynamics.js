import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log('=== Deep Analysis: Signals & Market Dynamics ===');
  
  // 1. Check confidence distributions of signals
  const [confStats] = await pool.query(`
    SELECT 
      market_type,
      action,
      COUNT(*) as signal_count,
      ROUND(AVG(ai_confidence), 4) as avg_confidence,
      ROUND(MIN(ai_confidence), 4) as min_confidence,
      ROUND(MAX(ai_confidence), 4) as max_confidence,
      ROUND(STD(ai_confidence), 4) as std_confidence
    FROM signals
    GROUP BY market_type, action
  `);
  console.table(confStats);

  // 2. Check bars count and average ATR relative to price (Volatility %)
  const [volatilityStats] = await pool.query(`
    SELECT 
      market_type,
      symbol,
      COUNT(*) as total_bars,
      ROUND(AVG(close), 2) as avg_price,
      ROUND(AVG(atr), 4) as avg_atr,
      ROUND(AVG(atr / close) * 100, 4) as atr_pct_of_price,
      ROUND(AVG(rsi), 2) as avg_rsi
    FROM market_bars
    GROUP BY market_type, symbol
  `);
  console.log('\n=== Market Volatility & ATR Characteristics ===');
  console.table(volatilityStats);

  // 3. Compare SL/TP reward:risk ratios generated in signals
  const [rrStats] = await pool.query(`
    SELECT 
      market_type,
      action,
      COUNT(*) as signals_count,
      ROUND(AVG(ABS(tp_price - price) / NULLIF(ABS(sl_price - price), 0)), 2) as avg_reward_to_risk,
      ROUND(AVG(ABS(tp_price - price) / price * 100), 3) as avg_tp_pct,
      ROUND(AVG(ABS(sl_price - price) / price * 100), 3) as avg_sl_pct
    FROM signals
    WHERE sl_price IS NOT NULL AND tp_price IS NOT NULL AND price > 0
    GROUP BY market_type, action
  `);
  console.log('\n=== Signal Risk:Reward (SL/TP) Geometry ===');
  console.table(rrStats);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
