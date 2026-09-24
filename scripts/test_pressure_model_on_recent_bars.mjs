import mysql from 'mysql2/promise';
import { spawn } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

function runPythonBridge(bars, symbol) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve('python/predict_market_pressure_bridge.py');
    const child = spawn('python', [scriptPath, JSON.stringify(bars), symbol], {
      env: process.env,
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Bridge failed (code ${code}): ${stderr || stdout}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Failed to parse bridge output: ${stdout}`));
      }
    });
  });
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=========================================================================================");
  console.log("🔍 TESTING MARKET PRESSURE & DYNAMIC PIP PROJECTIONS ON LIVE BARS");
  console.log("=========================================================================================\n");

  const symbols = [
    'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X',
    'USDCAD=X', 'USDCHF=X', 'NZDUSD=X', 'EURJPY=X', 'GBPJPY=X'
  ];

  const results = [];

  for (const sym of symbols) {
    const [bars] = await conn.query(`
      SELECT open, high, low, close, volume, rsi, atr, time
      FROM market_bars
      WHERE symbol = ?
      ORDER BY time DESC
      LIMIT 15
    `, [sym]);

    if (bars.length < 11) {
      console.log(`⚠️ Not enough bars for ${sym}`);
      continue;
    }

    const chron = bars.reverse();
    const prediction = await runPythonBridge(chron, sym);
    const pips = prediction.pip_projections || {};

    results.push({
      symbol: sym.replace('=X', ''),
      state: prediction.state,
      p_indecision: (prediction.probabilities.indecision * 100).toFixed(0) + '%',
      p_buy: (prediction.probabilities.buy_pressure * 100).toFixed(0) + '%',
      p_sell: (prediction.probabilities.sell_pressure * 100).toFixed(0) + '%',
      atr_pips: pips.atr_pips + 'p',
      exp_pips: (pips.expected_net_pips > 0 ? '+' : '') + pips.expected_net_pips + 'p',
      dyn_tp: pips.dynamic_tp_pips + 'p (' + pips.recommended_tp_atr_mult + 'x)',
      dyn_sl: pips.dynamic_sl_pips + 'p (' + pips.recommended_sl_atr_mult + 'x)',
      rr: '1:' + pips.projected_rr_ratio
    });
  }

  console.table(results);

  console.log("\n💡 Dynamic Pip Calculation Rules:");
  console.log("  1. Expected Net Pips: Calculated directly from (P_buy - P_sell) * KER_5 * ATR_pips");
  console.log("  2. Dynamic TP: Scales up to 1.8x ATR when Pressure is strong (Run Trend), scales down to 0.75x in Indecision (Micro-Scalp)");
  console.log("  3. Dynamic SL: Tightens to 0.65x ATR when Counter-Pressure is near zero, expanding R:R ratio!");

  await conn.end();
}

run().catch(console.error);
