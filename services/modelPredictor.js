import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.join(ROOT_DIR, 'python', 'predict_bridge.py');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

const FOREX_BRIDGE_PATH = path.join(ROOT_DIR, 'python', 'predict_forex_bridge.py');
const FOREX_CHALLENGER_BRIDGE_PATH = path.join(ROOT_DIR, 'python', 'predict_forex_challenger_bridge.py');
const FOREX_RANGE_BRIDGE_PATH = path.join(ROOT_DIR, 'python', 'predict_forex_range_bridge.py');
const CRYPTO_BRIDGE_PATH = path.join(ROOT_DIR, 'python', 'predict_crypto_bridge.py');
const GOLD_BRIDGE_PATH = path.join(ROOT_DIR, 'python', 'predict_gold_bridge.py');

/**
 * Predicts AI Swing confidence for US Stocks using Python ML Bridge or quantitative heuristic fallback.
 * @param {Object|Array} featuresObj Feature dictionary or array of dictionaries
 * @returns {Promise<Object|Array>}
 */
export async function predictConfidence(featuresObj) {
  try {
    const output = await runPythonPredict(featuresObj);
    return output;
  } catch (err) {
    console.warn('⚠️ Python Stock ML bridge execution failed, using quantitative fallback scorer:', err.message);
    if (Array.isArray(featuresObj)) {
      return featuresObj.map(f => fallbackScore(f));
    }
    return fallbackScore(featuresObj);
  }
}

/**
 * Predicts Forex M5 Scalping AI confidence using the dedicated Forex M5 LightGBM/RF model.
 * @param {Object|Array} featuresObj Feature dictionary or array of dictionaries
 * @returns {Promise<Object|Array>}
 */
export async function predictForexConfidence(featuresObj) {
  try {
    const output = await runPythonForexPredict(featuresObj);
    return output;
  } catch (err) {
    console.warn('⚠️ Python Forex ML bridge execution failed, using quantitative fallback scorer:', err.message);
    if (Array.isArray(featuresObj)) {
      return featuresObj.map(f => fallbackForexScore(f));
    }
    return fallbackForexScore(featuresObj);
  }
}

/** Predicts with the independent Forex Challenger model. The engine decides
 * whether this model is used for live execution or shadow comparison. */
export async function predictForexChallengerConfidence(featuresObj) {
  return runPythonModelPredict(featuresObj, FOREX_CHALLENGER_BRIDGE_PATH, 'Forex Challenger');
}

/** Predicts a range mean-reversion setup using the independent range expert. */
export async function predictForexRangeConfidence(featuresObj) {
  return runPythonModelPredict(featuresObj, FOREX_RANGE_BRIDGE_PATH, 'Forex Range');
}

/**
 * Predicts Gold (GOLD/XAUUSD) AI confidence using the dedicated Gold M5 ML LightGBM Model.
 * @param {Object} featuresObj Feature dictionary
 * @returns {Promise<Object>}
 */
export async function predictGoldConfidence(featuresObj) {
  try {
    const output = await runPythonModelPredict(featuresObj, GOLD_BRIDGE_PATH, 'Gold M5');
    return output;
  } catch (err) {
    console.warn('⚠️ Python Gold ML bridge execution failed, using quantitative fallback scorer:', err.message);
    return goldFallbackScore(featuresObj);
  }
}

function goldFallbackScore(featuresObj) {
  const f = featuresObj;
  let score = 0.30;
  const isBuy = (f.direction || 'BUY').toUpperCase() === 'BUY';

  // 1. Session alignment (London/NY overlap is highest quality)
  if (f.session === 'LONDON_NY_OVERLAP' || f.session_num === 3) score += 0.15;
  else if (f.session === 'LONDON_OPEN' || f.session_num === 2) score += 0.10;
  else if (f.session === 'ASIAN' || f.session_num === 1) score += 0.02;

  // 2. Liquidity sweep / Pinbar setup
  if (f.has_sweep || f.asian_sweep !== 0) score += 0.18;

  // 3. Dynamic Trend Pullback
  if (f.ema_pullback || Math.abs(f.ema_spread_21_50 || 0) > 0.5) score += 0.12;

  // 4. DXY inverse alignment
  if (isBuy && (f.dxy_trend === 'DOWN' || (f.dxy_slope_5 || 0) < 0)) score += 0.10;
  if (!isBuy && (f.dxy_trend === 'UP' || (f.dxy_slope_5 || 0) > 0)) score += 0.10;

  // 5. RSI confirmation
  if (isBuy && f.rsi_14 >= 30 && f.rsi_14 <= 55) score += 0.08;
  if (!isBuy && f.rsi_14 >= 45 && f.rsi_14 <= 70) score += 0.08;

  const confidence = Number(Math.min(0.95, Math.max(0.15, score)).toFixed(4));
  return {
    confidence,
    prob_buy: isBuy ? confidence : 0.2,
    prob_sell: isBuy ? 0.2 : confidence,
    direction: f.direction || (isBuy ? 'BUY' : 'SELL'),
    model: 'gold_quantitative_fallback'
  };
}

function cryptoFallbackScore(featuresObj) {
  const f = featuresObj;
  let score = 0.25;
  const isBuy = (f.direction || 'BUY').toUpperCase() === 'BUY';

  // 1. Bollinger Band Squeeze & Expansion
  if (f.bb_squeeze) score += 0.16;

  // 2. Volume Spike confirmation (Institutions entering)
  if (f.volume_ratio >= 1.4) score += 0.15;
  else if (f.volume_ratio >= 1.05) score += 0.08;

  // 3. ADX Trend Strength
  if (f.adx_14 >= 25) score += 0.12;
  else if (f.adx_14 >= 20) score += 0.06;

  // 4. Pattern Retest (Bull Flag / Triangle / W-Bottom)
  if (f.pattern_confirmed) score += 0.15;

  // 5. EMA Confluence
  if (isBuy && f.price_above_ema50) score += 0.08;
  if (!isBuy && !f.price_above_ema50) score += 0.08;

  const confidence = Number(Math.min(0.95, Math.max(0.15, score)).toFixed(4));
  return {
    confidence,
    prob_buy: isBuy ? confidence : 0.2,
    prob_sell: isBuy ? 0.2 : confidence,
    direction: f.direction || 'BUY',
    model: 'crypto_quantitative_fallback'
  };
}

/**
 * Predicts Crypto (BTC, ETH, SOL) AI confidence using the dedicated Crypto Tri-Ensemble ML model.
 * @param {Object|Array} featuresObj Feature dictionary or array of dictionaries
 * @returns {Promise<Object|Array>}
 */
export async function predictCryptoConfidence(featuresObj) {
  try {
    const output = await runPythonCryptoPredict(featuresObj);
    return output;
  } catch (err) {
    console.warn('⚠️ Python Crypto ML bridge execution failed, using quantitative fallback scorer:', err.message);
    if (Array.isArray(featuresObj)) {
      return featuresObj.map(f => cryptoFallbackScore(f));
    }
    return cryptoFallbackScore(featuresObj);
  }
}

function runPythonCryptoPredict(featuresObj) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_PATH, [CRYPTO_BRIDGE_PATH], {
      cwd: ROOT_DIR,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Python Crypto bridge exited with code ${code}: ${stderr || stdout}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          return reject(new Error(parsed.error));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`JSON parse error from Crypto bridge output: ${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(featuresObj));
    child.stdin.end();
  });
}

function runPythonForexPredict(featuresObj) {
  return runPythonModelPredict(featuresObj, FOREX_BRIDGE_PATH, 'Forex');
}

function runPythonModelPredict(featuresObj, bridgePath, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_PATH, [bridgePath], {
      cwd: ROOT_DIR,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Python ${label} bridge exited with code ${code}: ${stderr || stdout}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          return reject(new Error(parsed.error));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`JSON parse error from ${label} bridge output: ${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(featuresObj));
    child.stdin.end();
  });
}

function fallbackForexScore(f) {
  let score = 0.25;
  const isBuy = (f.direction || 'BUY').toUpperCase() === 'BUY';

  if (f.adx_14 >= 25) score += 0.12;
  else if (f.adx_14 >= 18) score += 0.06;

  if (isBuy) {
    if (f.rsi_14 >= 45 && f.rsi_14 <= 65) score += 0.10;
    if (f.ret_1 > 0) score += 0.05;
    if (f.ema_spread_20_50 > 0) score += 0.08;
  } else {
    if (f.rsi_14 >= 35 && f.rsi_14 <= 55) score += 0.10;
    if (f.ret_1 < 0) score += 0.05;
    if (f.ema_spread_20_50 < 0) score += 0.08;
  }

  const confidence = Math.min(0.95, Math.max(0.10, score));
  return {
    confidence: Number(confidence.toFixed(4)),
    prob_buy: isBuy ? confidence : 0.2,
    prob_sell: isBuy ? 0.2 : confidence,
    direction: f.direction || 'BUY',
    model: 'forex_m5_fallback'
  };
}

function runPythonPredict(featuresObj) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_PATH, [BRIDGE_PATH], {
      cwd: ROOT_DIR,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Python bridge exited with code ${code}: ${stderr || stdout}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          return reject(new Error(parsed.error));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`JSON parse error from bridge output: ${stdout}`));
      }
    });

    // Write input JSON to stdin
    child.stdin.write(JSON.stringify(featuresObj));
    child.stdin.end();
  });
}

/**
 * Robust quantitative scoring fallback if Python LightGBM is not available.
 * Evaluates trend, momentum, RS, and volume confirmation.
 */
function fallbackScore(f) {
  let score = 0.20;

  // Relative Strength
  if (f.rs_20d > 0.05) score += 0.15;
  else if (f.rs_20d > 0) score += 0.08;

  // Trend
  if (f.dist_ema_20 > 0 && f.dist_ema_50 > 0) score += 0.12;
  if (f.ema_trend_ratio > 1.01) score += 0.08;

  // Momentum (RSI & MACD)
  if (f.rsi_14 >= 50 && f.rsi_14 <= 70) score += 0.10;
  if (f.macd_hist > 0) score += 0.08;

  // Volume confirmation
  if (f.rvol > 1.2) score += 0.07;

  // Distance to 20d high (pullback setup)
  if (f.dist_to_20d_high >= 0.02 && f.dist_to_20d_high <= 0.08) score += 0.08;

  const confidence = Math.min(0.95, Math.max(0.05, score));
  return {
    confidence: Number(confidence.toFixed(4)),
    lgb_prob: Number(confidence.toFixed(4)),
    rf_prob: Number(confidence.toFixed(4)),
    fallback: true
  };
}
