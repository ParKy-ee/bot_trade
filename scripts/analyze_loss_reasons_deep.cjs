const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'ai_trading_db'
  });

  const [rows] = await pool.query(`
    SELECT 
      id, symbol, action, market_type, model_source, model_version, 
      ai_confidence, entry_price, sl_price, tp_price, exit_price, pips, 
      profit_loss, exit_reason, rsi, adx, atr, filter_reasons, 
      DATE(created_at) as dt, HOUR(created_at) as hr
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) >= '2026-09-24'
      AND exit_reason IN ('CLOSED_SL', 'CLOSED_TIME_STOP')
    ORDER BY id ASC
  `);

  console.log(`Total CLOSED_SL + CLOSED_TIME_STOP: ${rows.length}`);

  // Breakdown by model_version
  const byModel = {};
  // Breakdown by market_type
  const byMarket = {};
  // Breakdown by action (BUY vs SELL)
  const byAction = { BUY: 0, SELL: 0 };
  // Breakdown by symbol
  const bySymbol = {};
  // ADX & RSI stats
  let adxSum = 0;
  let rsiSum = 0;
  let adxLowCount = 0; // ADX < 20 (Chop/Sideway)

  rows.forEach(r => {
    byModel[r.model_version] = (byModel[r.model_version] || 0) + 1;
    byMarket[r.market_type] = (byMarket[r.market_type] || 0) + 1;
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    bySymbol[r.symbol] = (bySymbol[r.symbol] || 0) + 1;
    
    const adx = Number(r.adx || 0);
    const rsi = Number(r.rsi || 50);
    adxSum += adx;
    rsiSum += rsi;
    if (adx < 20) adxLowCount++;
  });

  console.log('\n--- By Model Version ---');
  console.table(byModel);

  console.log('\n--- By Market Type ---');
  console.table(byMarket);

  console.log('\n--- By Action (BUY vs SELL) ---');
  console.table(byAction);

  console.log('\n--- Top Losing Symbols ---');
  const sortedSyms = Object.entries(bySymbol).sort((a,b) => b[1] - a[1]);
  console.table(sortedSyms.slice(0, 10));

  console.log('\n--- Technical Indicators at Entry ---');
  console.log(`Average ADX: ${(adxSum / rows.length).toFixed(1)}`);
  console.log(`Trades with ADX < 20 (Choppy/No Trend): ${adxLowCount} / ${rows.length} (${((adxLowCount / rows.length)*100).toFixed(1)}%)`);
  console.log(`Average RSI: ${(rsiSum / rows.length).toFixed(1)}`);

  await pool.end();
})();
