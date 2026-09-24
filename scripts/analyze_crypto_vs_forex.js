import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log('=== 1. Summary by Market Type ===');
  const [byMarket] = await pool.query(`
    SELECT 
      market_type,
      COUNT(*) AS total_trades,
      SUM(CASE WHEN exit_reason = 'OPEN' THEN 1 ELSE 0 END) AS open_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END) AS closed_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(AVG(return_pct), 4) AS avg_return_pct,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_minutes
    FROM trade_results
    GROUP BY market_type
  `);
  console.table(byMarket);

  console.log('\n=== 2. Detailed Crypto vs Forex by Symbol ===');
  const [bySymbol] = await pool.query(`
    SELECT 
      market_type,
      symbol,
      COUNT(*) AS total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END) AS closed_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_minutes
    FROM trade_results
    GROUP BY market_type, symbol
    ORDER BY market_type, total_trades DESC
  `);
  console.table(bySymbol);

  console.log('\n=== 3. Exit Reason Breakdown by Market Type ===');
  const [byExitReason] = await pool.query(`
    SELECT 
      market_type,
      exit_reason,
      COUNT(*) AS count,
      ROUND(AVG(profit_loss), 2) AS avg_pnl,
      ROUND(SUM(profit_loss), 2) AS sum_pnl,
      ROUND(AVG(return_pct), 4) AS avg_ret_pct,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    GROUP BY market_type, exit_reason
    ORDER BY market_type, count DESC
  `);
  console.table(byExitReason);

  console.log('\n=== 4. Indicator & Feature Comparison: Wins vs Losses across Crypto vs Forex ===');
  const [featureStats] = await pool.query(`
    SELECT 
      market_type,
      is_win,
      COUNT(*) AS count,
      ROUND(AVG(ai_confidence), 4) AS avg_conf,
      ROUND(AVG(rsi), 2) AS avg_rsi,
      ROUND(AVG(adx), 2) AS avg_adx,
      ROUND(AVG(atr), 5) AS avg_atr,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    GROUP BY market_type, is_win
    ORDER BY market_type, is_win DESC
  `);
  console.table(featureStats);

  console.log('\n=== 5. Action (BUY vs SELL) Comparison ===');
  const [actionStats] = await pool.query(`
    SELECT 
      market_type,
      action,
      COUNT(*) AS total_closed,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    GROUP BY market_type, action
    ORDER BY market_type, action
  `);
  console.table(actionStats);

  console.log('\n=== 6. Recent Crypto Trades Sample ===');
  const [recentCrypto] = await pool.query(`
    SELECT id, symbol, action, entry_time, exit_time, exit_reason, ai_confidence, rsi, adx, return_pct, profit_loss, is_win, hold_duration_minutes, filter_reasons
    FROM trade_results
    WHERE market_type = 'crypto'
    ORDER BY id DESC
    LIMIT 20
  `);
  console.log(JSON.stringify(recentCrypto, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
