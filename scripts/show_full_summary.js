import { getPool } from '../config/database.js';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('========================================================================================');
  console.log('🏆 AI TRADING BOT - COMPREHENSIVE PERFORMANCE & SCORE SUMMARY');
  console.log('========================================================================================\n');

  // 1. Model Registry ML Benchmark Scores
  console.log('----------------------------------------------------------------------------------------');
  console.log('🧠 1. ML MODEL REGISTRY SCORES (All Versions Benchmark)');
  console.log('----------------------------------------------------------------------------------------');

  const champRegistryPath = './python/models/model_registry.json';
  if (fs.existsSync(champRegistryPath)) {
    const champReg = JSON.parse(fs.readFileSync(champRegistryPath, 'utf-8'));
    console.log(`\n👑 [Champion Tri-Ensemble Models] (Active: ${champReg.active_version})`);
    const champRows = (champReg.versions || []).map(v => ({
      Version: v.version,
      Samples: v.dataset?.total_samples?.toLocaleString() || '-',
      LiveTrades: v.dataset?.live_trade_samples || 0,
      Observations: v.dataset?.observation_samples || 0,
      'AUC BUY': v.metrics?.roc_auc_buy ? (v.metrics.roc_auc_buy * 100).toFixed(2) + '%' : '-',
      'AUC SELL': v.metrics?.roc_auc_sell ? (v.metrics.roc_auc_sell * 100).toFixed(2) + '%' : '-',
      'Acc BUY': v.metrics?.accuracy_buy ? (v.metrics.accuracy_buy * 100).toFixed(1) + '%' : '-',
      'Acc SELL': v.metrics?.accuracy_sell ? (v.metrics.accuracy_sell * 100).toFixed(1) + '%' : '-',
      'Prec SELL': v.metrics?.precision_sell ? (v.metrics.precision_sell * 100).toFixed(1) + '%' : '-',
      'F0.5 SELL': v.metrics?.f05_sell ? v.metrics.f05_sell.toFixed(3) : '-'
    }));
    console.table(champRows);
  }

  const chalRegistryPath = './python/models/challenger_registry.json';
  if (fs.existsSync(chalRegistryPath)) {
    const chalReg = JSON.parse(fs.readFileSync(chalRegistryPath, 'utf-8'));
    console.log(`\n🧪 [Challenger GradientBoosting Model] (Active: ${chalReg.active_version})`);
    const chalRow = [{
      Version: chalReg.active_version,
      Samples: chalReg.dataset?.total_samples?.toLocaleString() || '-',
      LiveTrades: chalReg.dataset?.live_trade_samples || 0,
      ShadowTrades: chalReg.dataset?.shadow_trade_samples || 0,
      Observations: chalReg.dataset?.observation_samples || 0,
      'AUC BUY': chalReg.metrics?.buy?.roc_auc ? (chalReg.metrics.buy.roc_auc * 100).toFixed(2) + '%' : '-',
      'AUC SELL': chalReg.metrics?.sell?.roc_auc ? (chalReg.metrics.sell.roc_auc * 100).toFixed(2) + '%' : '-',
      'Acc BUY': chalReg.metrics?.buy?.accuracy ? (chalReg.metrics.buy.accuracy * 100).toFixed(1) + '%' : '-',
      'Acc SELL': chalReg.metrics?.sell?.accuracy ? (chalReg.metrics.sell.accuracy * 100).toFixed(1) + '%' : '-',
      'Prec SELL': chalReg.metrics?.sell?.precision ? (chalReg.metrics.sell.precision * 100).toFixed(1) + '%' : '-',
      'F0.5 SELL': chalReg.metrics?.sell?.f05 ? chalReg.metrics.sell.f05.toFixed(3) : '-'
    }];
    console.table(chalRow);
  }

  // 2. Realized Database Trading Results
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('📊 2. DATABASE REALIZED TRADE RESULTS (By Bot Model & Version)');
  console.log('----------------------------------------------------------------------------------------');
  const pool = await getPool();
  const [dbScores] = await pool.query(`
    SELECT 
      COALESCE(market_type, 'unknown') AS market,
      COALESCE(model_source, 'legacy') AS bot_model,
      COALESCE(model_version, '-') AS version,
      COALESCE(decision_mode, 'LIVE') AS mode,
      COUNT(*) AS total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0), 1) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS total_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) AS profit_factor,
      ROUND(SUM(pips), 1) AS total_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    GROUP BY market_type, model_source, model_version, decision_mode
    HAVING closed > 0
    ORDER BY market, total_trades DESC
  `);
  console.table(dbScores);

  // 3. Exit Reason Summary
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('⚡ 3. EXIT REASONS & PROFITABILITY DISTRIBUTION');
  console.log('----------------------------------------------------------------------------------------');
  const [exitStats] = await pool.query(`
    SELECT 
      exit_reason,
      COUNT(*) AS total_count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS win_count,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS win_rate_pct,
      ROUND(SUM(profit_loss), 2) AS sum_pnl_usd,
      ROUND(AVG(profit_loss), 2) AS avg_pnl_usd,
      ROUND(SUM(pips), 1) AS sum_pips,
      ROUND(AVG(hold_duration_minutes), 1) AS avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND exit_price IS NOT NULL
    GROUP BY exit_reason
    ORDER BY total_count DESC
  `);
  console.table(exitStats);

  // 4. Active Configuration in .env
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('⚙️ 4. CURRENT ACTIVE CONFIGURATION (.env)');
  console.log('----------------------------------------------------------------------------------------');
  console.log(`• FOREX_MODEL_VERSION:           ${process.env.FOREX_MODEL_VERSION}`);
  console.log(`• FOREX_CHALLENGER_MODEL_VERSION: ${process.env.FOREX_CHALLENGER_MODEL_VERSION}`);
  console.log(`• FOREX_DYNAMIC_EXIT_ENABLED:     ${process.env.FOREX_DYNAMIC_EXIT_ENABLED}`);
  console.log(`• FOREX_DYNAMIC_MIN_RR:           ${process.env.FOREX_DYNAMIC_MIN_RR} (Target Minimum R:R)`);
  console.log(`• FOREX_DYNAMIC_TP_ATR_MULT:      ${process.env.FOREX_DYNAMIC_TP_ATR_MULT}x ATR`);
  console.log(`• FOREX_DYNAMIC_MIN_TP_MAJOR:     ${process.env.FOREX_DYNAMIC_MIN_TP_MAJOR} Pips (Min TP Target)`);
  console.log(`• FOREX_MAX_HOLD_MINUTES:         ${process.env.FOREX_MAX_HOLD_MINUTES} Minutes (Max Trade Hold)`);
  console.log(`• CRYPTO_MAX_HOLD_MINUTES:        ${process.env.CRYPTO_MAX_HOLD_MINUTES} Minutes`);
  console.log('========================================================================================\n');

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
