const mysql = require('mysql2/promise');

(async () => {
  const pool = mysql.createPool({ host: '127.0.0.1', user: 'root', password: '', database: 'ai_trading_db' });
  
  console.log("=== 1. CHECK forex_ml_observations ===");
  const [counts] = await pool.query("SELECT outcome_status, sample_kind, COUNT(id) as cnt FROM forex_ml_observations GROUP BY outcome_status, sample_kind");
  console.table(counts);

  const [featuresCheck] = await pool.query("SELECT id, symbol, ret_1, ret_5, rsi_14, adx_14, atr_pct, target_buy, target_sell, outcome_status, observed_at FROM forex_ml_observations ORDER BY id DESC LIMIT 5");
  console.log("Latest 5 observations in forex_ml_observations:");
  console.table(featuresCheck);

  // Check for any hardcoded zeros or corruptions
  const [corruptRet1] = await pool.query("SELECT COUNT(id) as cnt FROM forex_ml_observations WHERE ret_1 = 0");
  const [corruptRet5] = await pool.query("SELECT COUNT(id) as cnt FROM forex_ml_observations WHERE ret_5 = 0");
  const [totalObs] = await pool.query("SELECT COUNT(id) as total FROM forex_ml_observations");
  console.log(`Total Observations: ${totalObs[0].total}`);
  console.log(`ret_1 == 0 count: ${corruptRet1[0].cnt} (${((corruptRet1[0].cnt/totalObs[0].total)*100).toFixed(2)}%)`);
  console.log(`ret_5 == 0 count: ${corruptRet5[0].cnt} (${((corruptRet5[0].cnt/totalObs[0].total)*100).toFixed(2)}%)`);

  console.log("\n=== 2. CHECK trade_results ===");
  const [recentTradeResults] = await pool.query("SELECT id, symbol, action, entry_price, exit_price, pips, profit_loss, exit_reason, is_win, created_at FROM trade_results ORDER BY id DESC LIMIT 5");
  console.table(recentTradeResults);

  await pool.end();
})();
