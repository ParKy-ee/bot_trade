import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const FETCH_SCRIPT = path.join(ROOT_DIR, 'python', 'fetch_data.py');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

export const UNIVERSE = [
  'NVDA', 'AMD', 'TSLA', 'MSFT', 'AVGO',
  'NFLX', 'AMZN', 'META', 'GOOGL', 'SPY'
];

export const FOREX_UNIVERSE = [
  'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'USDCHF=X', 'AUDUSD=X',
  'USDCAD=X', 'NZDUSD=X', 'EURJPY=X', 'GBPJPY=X', 'DX-Y.NYB'
];

export const GOLD_UNIVERSE = ['GOLD'];
export const CRYPTO_UNIVERSE = process.env.CRYPTO_SYMBOLS
  ? process.env.CRYPTO_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)
  : ['BTCUSD', 'ETHUSD'];

export const BINANCE_SYMBOL_MAP = {
  'BTCUSD': 'BTCUSDT',
  'ETHUSD': 'ETHUSDT',
  'SOLUSD': 'SOLUSDT'
};

const BINANCE_ENDPOINTS = [
  'https://api.binance.com/api/v3/klines',
  'https://data-api.binance.vision/api/v3/klines',
  'https://api1.binance.com/api/v3/klines'
];

/**
 * Fetch latest OHLCV bars for symbols via Yahoo Finance bridge.
 * @param {string[]} symbols Array of ticker symbols (defaults to UNIVERSE)
 * @param {string} period '1y', '6mo', '1mo', '5d', '1d'
 * @param {string} interval '1d', '1h', '5m', '15m'
 * @returns {Promise<Object>} Map of symbol -> array of bars
 */
export async function fetchMarketData(symbols = UNIVERSE, period = '1y', interval = '1d') {
  return new Promise((resolve, reject) => {
    const tickersArg = symbols.join(',');
    const child = spawn(PYTHON_PATH, [
      FETCH_SCRIPT,
      tickersArg,
      `--period=${period}`,
      `--interval=${interval}`
    ], {
      cwd: ROOT_DIR,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Fetch script exited with code ${code}: ${stderr || stdout}`));
      }
      try {
        const data = JSON.parse(stdout.trim());
        if (data.error) {
          return reject(new Error(data.error));
        }
        resolve(data);
      } catch (err) {
        reject(new Error(`Failed to parse market data JSON: ${err.message}`));
      }
    });
  });
}

/**
 * Fetch single crypto pair klines from Binance Public REST API with auto-fallback.
 */
async function fetchSingleBinanceKlines(binanceSymbol, interval = '5m', limit = 100) {
  for (const endpoint of BINANCE_ENDPOINTS) {
    try {
      const url = `${endpoint}?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) continue;
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) continue;

      // Map Binance raw array to standardized bar format
      // [open_time, open, high, low, close, volume, close_time, quote_vol, trades_count, ...]
      return raw.map(k => ({
        time: new Date(k[0]).toISOString().replace('T', ' ').substring(0, 19),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: k[6],
        tradesCount: k[8]
      }));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * High-speed Concurrent / Parallel Crypto Data Fetcher directly from Binance Public REST API.
 * @param {string[]} symbols Array of crypto symbols e.g. ['BTCUSD', 'ETHUSD', 'SOLUSD']
 * @param {string} interval '5m', '15m', '1h'
 * @param {number} limit Number of bars (default 100)
 * @returns {Promise<Object>} Map of symbol -> array of bars
 */
export async function fetchBinanceCryptoDataParallel(symbols = CRYPTO_UNIVERSE, interval = '5m', limit = 100) {
  const fetchTasks = symbols.map(async (sym) => {
    const binanceSym = BINANCE_SYMBOL_MAP[sym] || sym.replace('USD', 'USDT');
    const bars = await fetchSingleBinanceKlines(binanceSym, interval, limit);
    return { symbol: sym, bars };
  });

  const results = await Promise.all(fetchTasks);
  const dataMap = {};
  for (const r of results) {
    if (r.bars && r.bars.length > 0) {
      dataMap[r.symbol] = r.bars;
    }
  }
  return dataMap;
}
