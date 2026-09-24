import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { exec, spawn } from 'child_process';

import { initDatabase, getPool } from './config/database.js';
import { executeScanCycle, checkUSStockMarket } from './services/tradingEngine.js';
import { executeForexScanCycle } from './services/forexEngine.js';
import { executeGoldScanCycle } from './services/goldEngine.js';
import { executeCryptoScanCycle } from './services/cryptoEngine.js';
import { seedHistoricalData } from './services/historicalSeeder.js';
import { UNIVERSE, FOREX_UNIVERSE, GOLD_UNIVERSE, CRYPTO_UNIVERSE } from './services/marketData.js';
import { getAccountInfo, getOpenPositions, placeOrder, closePosition } from './services/mt5Broker.js';
import { recordTradeEntry, recordTradeExit, getTradeResults, getTradeStats, syncMt5PositionsWithDatabase } from './services/tradeResultTracker.js';
import { reviewTradeWithGemini } from './services/geminiReviewer.js';
import { getTradingModeStatus } from './services/tradingMode.js';
import {
  getFreqtradeMt5Status,
  isFreqtradeMt5Authorized,
  processFreqtradeMt5Signal
} from './services/freqtradeMt5Bridge.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SCAN_INTERVAL_MINUTES = Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES || 5));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Bot state
let botRunning = true;
let scanTimer = null;
let forexTimer = null;
let goldTimer = null;
let cryptoTimer = null;
let barSyncTimeout = null;
let isScanning = false;
let isForexScanning = false;
let isGoldScanning = false;
let isCryptoScanning = false;
let lastScanTime = null;
let lastScanResult = null;
let lastForexScanTime = null;
let lastForexScanResult = null;
let lastGoldScanTime = null;
let lastGoldScanResult = null;
let lastCryptoScanTime = null;
let lastCryptoScanResult = null;

// Helper: Check if US market is open / weekend check
function isWeekendUS() {
  const nyTimeStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const nyDate = new Date(nyTimeStr);
  const day = nyDate.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

// Forex is not closed for the whole of Sunday in New York time. The usual
// weekly closure is Friday 17:00 ET through Sunday 17:00 ET. Therefore,
// Monday 08:48 in Bangkok (Sunday 21:48 ET) must remain tradable.
function isForexMarketClosed(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const day = values.weekday;
  const totalMinutes = Number(values.hour) * 60 + Number(values.minute);

  if (day === 'Sat') return true;
  if (day === 'Sun' && totalMinutes < 17 * 60) return true;
  if (day === 'Fri' && totalMinutes >= 17 * 60) return true;
  return false;
}

// Background scheduler for Stocks (Regular Trading Hours: 09:30 - 16:00 ET / 20:30 - 03:00 THA)
async function runScheduledScan() {
  if (!botRunning || isScanning) return;

  const marketCheck = checkUSStockMarket();
  const enforceMarketHours = process.env.STOCK_MARKET_HOURS_ONLY !== 'false';

  if (enforceMarketHours && !marketCheck.isOpen) {
    console.log(`[*] [${new Date().toISOString()}] ⏸️ ตลาดหุ้นสหรัฐปิดทำการ (${marketCheck.reason}) -> ข้ามรอบการสแกนหุ้น`);
    lastScanResult = { success: true, skipped: true, reason: marketCheck.reason, marketCheck };
    return;
  }

  isScanning = true;
  try {
    lastScanTime = new Date().toISOString();
    lastScanResult = await executeScanCycle({ force: true });
  } catch (err) {
    console.error('❌ ข้อผิดพลาดในรอบการสแกนหุ้นอัตโนมัติ:', err);
    lastScanResult = { success: false, error: err.message };
  } finally {
    isScanning = false;
  }
}

// Background scheduler for Forex
async function runScheduledForexScan() {
  if (!botRunning || isForexScanning) return;

  if (isForexMarketClosed()) {
    console.log(`[*] [${new Date().toISOString()}] ตลาด Forex ปิดช่วงสุดสัปดาห์ (ข้ามรอบสแกน)`);
    return;
  }

  isForexScanning = true;
  try {
    lastForexScanTime = new Date().toISOString();
    lastForexScanResult = await executeForexScanCycle();
  } catch (err) {
    console.error('❌ ข้อผิดพลาดในรอบการสแกน Forex อัตโนมัติ:', err);
    lastForexScanResult = { success: false, error: err.message };
  } finally {
    isForexScanning = false;
  }
}

// Background scheduler for Gold
async function runScheduledGoldScan() {
  if (!botRunning || isGoldScanning) return;

  if (isForexMarketClosed()) {
    console.log(`[*] [${new Date().toISOString()}] ตลาดทองคำปิดช่วงสุดสัปดาห์ (ข้ามรอบสแกน)`);
    return;
  }

  isGoldScanning = true;
  try {
    lastGoldScanTime = new Date().toISOString();
    lastGoldScanResult = await executeGoldScanCycle();
  } catch (err) {
    console.error('❌ ข้อผิดพลาดในรอบการสแกน Gold อัตโนมัติ:', err);
    lastGoldScanResult = { success: false, error: err.message };
  } finally {
    isGoldScanning = false;
  }
}

// Background scheduler for Crypto (24/7 Engine - Runs through weekends!)
async function runScheduledCryptoScan() {
  if (!botRunning || isCryptoScanning) return;

  isCryptoScanning = true;
  try {
    lastCryptoScanTime = new Date().toISOString();
    lastCryptoScanResult = await executeCryptoScanCycle();
  } catch (err) {
    console.error('❌ ข้อผิดพลาดในรอบการสแกน Crypto อัตโนมัติ:', err);
    lastCryptoScanResult = { success: false, error: err.message };
  } finally {
    isCryptoScanning = false;
  }
}

// SSE Clients list & broadcast
let sseClients = [];

export function broadcastSSE(eventType, data) {
  if (sseClients.length === 0) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}

// Real-Time Telemetry State Builder
export async function getRealtimeState() {
  const forexStats = await getTradeStats('forex');
  const stockStats = await getTradeStats('stock');
  const goldStats = await getTradeStats('gold');
  const cryptoStats = await getTradeStats('crypto');
  let openPositions = [];

  if (process.env.MT5_ENABLED === 'true') {
    try {
      const pos = await getOpenPositions();
      if (Array.isArray(pos)) {
        openPositions = pos.map(p => {
          const isJpy = String(p.symbol).includes('JPY');
          const isGold = String(p.symbol).includes('GOLD') || String(p.symbol).includes('XAU');
          const isCrypto = String(p.symbol).includes('BTC') || String(p.symbol).includes('ETH');
          const pipSize = isJpy ? 0.01 : (isGold ? 0.10 : (isCrypto ? 1.0 : 0.0001));
          const openPrice = Number(p.priceOpen);
          const currPrice = Number(p.priceCurrent);
          const priceDiff = p.type === 'BUY' ? (currPrice - openPrice) : (openPrice - currPrice);
          const livePips = Number((priceDiff / pipSize).toFixed(1));
          return {
            ticket: p.ticket,
            symbol: p.symbol,
            type: p.type,
            volume: p.volume,
            priceOpen: openPrice,
            priceCurrent: currPrice,
            sl: Number(p.sl),
            tp: Number(p.tp),
            profit: Number(p.profit),
            livePips,
            comment: p.comment,
            time: p.time
          };
        });
      }
    } catch (err) {}
  }

  const totalFloatingPnl = Number(openPositions.reduce((sum, p) => sum + (p.profit || 0), 0).toFixed(2));
  const totalFloatingPips = Number(openPositions.reduce((sum, p) => sum + (p.livePips || 0), 0).toFixed(1));

  const pool = await getPool();
  const [recentTradesForex] = await pool.query(
    `SELECT id, mt5_ticket, symbol, market_type, action, entry_price, exit_price, sl_price, tp_price, exit_reason, pips, profit_loss, return_pct, is_win, ai_confidence, created_at 
     FROM trade_results 
     WHERE market_type = 'forex'
     ORDER BY id DESC LIMIT 25`
  );

  const [recentTradesStock] = await pool.query(
    `SELECT id, mt5_ticket, symbol, market_type, action, entry_price, exit_price, sl_price, tp_price, exit_reason, pips, profit_loss, return_pct, is_win, ai_confidence, created_at 
     FROM trade_results 
     WHERE market_type = 'stock'
     ORDER BY id DESC LIMIT 25`
  );

  const [recentTradesGold] = await pool.query(
    `SELECT id, mt5_ticket, symbol, market_type, action, entry_price, exit_price, sl_price, tp_price, exit_reason, pips, profit_loss, return_pct, is_win, ai_confidence, created_at 
     FROM trade_results 
     WHERE market_type = 'gold'
     ORDER BY id DESC LIMIT 25`
  );

  const [recentTradesCrypto] = await pool.query(
    `SELECT id, mt5_ticket, symbol, market_type, action, entry_price, exit_price, sl_price, tp_price, exit_reason, pips, profit_loss, return_pct, is_win, ai_confidence, created_at 
     FROM trade_results 
     WHERE market_type = 'crypto'
     ORDER BY id DESC LIMIT 25`
  );

  const [stockPositions] = await pool.query(
    `SELECT * FROM active_positions WHERE market_type = 'stock' AND status_note NOT LIKE 'CLOSED%'`
  );

  const [goldPositions] = await pool.query(
    `SELECT * FROM active_positions WHERE market_type = 'gold' AND status_note NOT LIKE 'CLOSED%'`
  );

  const [cryptoPositions] = await pool.query(
    `SELECT * FROM active_positions WHERE market_type = 'crypto' AND status_note NOT LIKE 'CLOSED%'`
  );

  return {
    timestamp: new Date().toISOString(),
    stats: {
      ...forexStats,
      totalFloatingPnl,
      totalFloatingPips,
      activeOpenCount: openPositions.length,
      forex: {
        ...forexStats,
        totalFloatingPnl,
        totalFloatingPips,
        activeOpenCount: openPositions.length
      },
      stock: {
        ...stockStats,
        activeOpenCount: stockPositions.length
      },
      gold: {
        ...goldStats,
        activeOpenCount: goldPositions.length
      },
      crypto: {
        ...cryptoStats,
        activeOpenCount: cryptoPositions.length
      }
    },
    openPositions,
    recentTrades: recentTradesForex,
    recentTradesForex,
    recentTradesStock,
    recentTradesGold,
    recentTradesCrypto,
    stockPositions,
    goldPositions,
    cryptoPositions,
    usMarketStatus: checkUSStockMarket(),
    botRunning
  };
}

let fastSyncTimer = null;
function startFastSync() {
  if (fastSyncTimer) clearInterval(fastSyncTimer);
  fastSyncTimer = setInterval(async () => {
    if (process.env.MT5_ENABLED === 'true') {
      try {
        await syncMt5PositionsWithDatabase();
        if (sseClients.length > 0) {
          const state = await getRealtimeState();
          broadcastSSE('telemetry', state);
        }
      } catch (err) {}
    }
  }, 2500); // Sync MT5 every 2.5 seconds
}

function stopFastSync() {
  if (fastSyncTimer) {
    clearInterval(fastSyncTimer);
    fastSyncTimer = null;
  }
}

function getMsUntilNextBarClose(intervalMinutes = 5, offsetSeconds = 2) {
  const now = new Date();
  const msInPeriod = ((now.getMinutes() % intervalMinutes) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  const periodMs = intervalMinutes * 60 * 1000;
  const targetOffsetMs = offsetSeconds * 1000;
  let remainingMs = periodMs - msInPeriod + targetOffsetMs;
  if (remainingMs <= 0) remainingMs += periodMs;
  return remainingMs;
}

function startDaemon() {
  if (scanTimer) clearInterval(scanTimer);
  if (forexTimer) clearInterval(forexTimer);
  if (goldTimer) clearInterval(goldTimer);
  if (cryptoTimer) clearInterval(cryptoTimer);
  if (barSyncTimeout) clearTimeout(barSyncTimeout);
  botRunning = true;
  console.log(`🚀 AI Trading Daemon เริ่มต้นทำงาน (สแกนทุก ${SCAN_INTERVAL_MINUTES} นาที: หุ้น, Forex, Gold, Crypto 24/7)`);
  
  // Start Fast 2.5-second Real-Time MT5 Position Sync
  startFastSync();

  // First runs after server starts smoothly (staggered verification)
  setTimeout(() => {
    runScheduledScan();
  }, 4000);

  setTimeout(() => {
    runScheduledForexScan();
  }, 10000);

  setTimeout(() => {
    runScheduledGoldScan();
  }, 16000);

  setTimeout(() => {
    runScheduledCryptoScan();
  }, 22000);

  // Bar-Close Synchronization: Align recurring scan intervals precisely at closed candles (:02s)
  const delayUntilBarClose = getMsUntilNextBarClose(SCAN_INTERVAL_MINUTES, 2);
  console.log(`⏱️ [BAR-CLOSE SYNC] ซิงค์รอบสแกนแท่งเทียน M${SCAN_INTERVAL_MINUTES}: รอบถัดไปจะเริ่มใน ${(delayUntilBarClose / 1000).toFixed(0)} วินาที (ณ วินาทีที่ 02 หลังปิดแท่ง)`);

  barSyncTimeout = setTimeout(() => {
    console.log(`⏱️ [BAR-CLOSE SYNC TRIGGERED] แท่งเทียนปิดตัวลงอย่างเป็นทางการ -> เริ่มรอบสแกนที่ซิงค์กับแท่งเทียน`);
    runScheduledForexScan();
    runScheduledGoldScan();
    runScheduledCryptoScan();
    runScheduledScan();

    // Now maintain synchronized recurring intervals
    forexTimer = setInterval(runScheduledForexScan, SCAN_INTERVAL_MINUTES * 60 * 1000);
    goldTimer = setInterval(runScheduledGoldScan, SCAN_INTERVAL_MINUTES * 60 * 1000);
    cryptoTimer = setInterval(runScheduledCryptoScan, SCAN_INTERVAL_MINUTES * 60 * 1000);
    scanTimer = setInterval(runScheduledScan, SCAN_INTERVAL_MINUTES * 60 * 1000);
  }, delayUntilBarClose);
}

function stopDaemon() {
  botRunning = false;
  stopFastSync();
  if (barSyncTimeout) {
    clearTimeout(barSyncTimeout);
    barSyncTimeout = null;
  }
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (forexTimer) {
    clearInterval(forexTimer);
    forexTimer = null;
  }
  if (goldTimer) {
    clearInterval(goldTimer);
    goldTimer = null;
  }
  if (cryptoTimer) {
    clearInterval(cryptoTimer);
    cryptoTimer = null;
  }
  console.log('⏸️ AI Trading Daemon ถูกหยุดการทำงานชั่วคราว');
}

// =================== REST API ROUTES ===================

// SSE Real-Time Stream Endpoint
app.get('/api/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  sseClients.push(res);

  try {
    const initialPayload = await getRealtimeState();
    res.write(`event: telemetry\ndata: ${JSON.stringify(initialPayload)}\n\n`);
  } catch (err) {
    console.warn('⚠️ Error sending initial SSE state:', err.message);
  }

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Realtime Telemetry State REST API (Snapshot)
app.get('/api/realtime-state', async (_req, res) => {
  try {
    const state = await getRealtimeState();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.query('SELECT 1');
    res.json({
      status: 'online',
      database: process.env.DB_NAME || 'ai_trading_db',
       botRunning,
       isScanning,
       tradingMode: getTradingModeStatus(),
       lastScanTime,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Bot Status & Config
app.get('/api/status', (_req, res) => {
  res.json({
    botRunning,
    isScanning,
    tradingMode: getTradingModeStatus(),
    scanIntervalMinutes: SCAN_INTERVAL_MINUTES,
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD || 0.45),
    universe: UNIVERSE,
    lastScanTime,
    lastScanResult,
    isWeekend: isWeekendUS()
  });
});

// Toggle Bot Daemon
app.post('/api/bot/toggle', (req, res) => {
  const { action } = req.body;
  if (action === 'start') {
    startDaemon();
  } else if (action === 'stop') {
    stopDaemon();
  } else {
    botRunning = !botRunning;
    if (botRunning) startDaemon();
    else stopDaemon();
  }
  res.json({ botRunning });
});

// Trigger Manual Stock Scan
app.post('/api/scan', async (req, res) => {
  if (isScanning) {
    return res.status(409).json({ error: 'รอบการสแกนหุ้นกำลังทำงานอยู่แล้ว' });
  }

  const force = req.query.force === 'true' || req.body?.force === true;
  const marketCheck = checkUSStockMarket();
  const enforceMarketHours = process.env.STOCK_MARKET_HOURS_ONLY !== 'false';

  if (!force && enforceMarketHours && !marketCheck.isOpen) {
    return res.json({
      status: 'SKIPPED',
      message: `${marketCheck.reason} (ส่ง force=true หากต้องการสแกนนอกเวลาทำการ)`,
      marketCheck
    });
  }

  isScanning = true;
  try {
    lastScanTime = new Date().toISOString();
    lastScanResult = await executeScanCycle({ force: true });
    res.json({ status: 'OK', result: lastScanResult });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  } finally {
    isScanning = false;
  }
});

// Trigger Manual Forex Scan
app.post('/api/forex/scan', async (_req, res) => {
  if (isForexScanning) {
    return res.status(409).json({ error: 'รอบการสแกน Forex กำลังทำงานอยู่แล้ว' });
  }
  isForexScanning = true;
  try {
    lastForexScanTime = new Date().toISOString();
    lastForexScanResult = await executeForexScanCycle();
    res.json({ status: 'OK', result: lastForexScanResult });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  } finally {
    isForexScanning = false;
  }
});

// Trigger Manual Gold Scan
app.post('/api/gold/scan', async (_req, res) => {
  if (isGoldScanning) {
    return res.status(409).json({ error: 'รอบการสแกน Gold กำลังทำงานอยู่แล้ว' });
  }
  isGoldScanning = true;
  try {
    lastGoldScanTime = new Date().toISOString();
    lastGoldScanResult = await executeGoldScanCycle();
    res.json({ status: 'OK', result: lastGoldScanResult });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  } finally {
    isGoldScanning = false;
  }
});

// Trigger Manual Crypto Scan
app.post('/api/crypto/scan', async (_req, res) => {
  if (isCryptoScanning) {
    return res.status(409).json({ error: 'รอบการสแกน Crypto กำลังทำงานอยู่แล้ว' });
  }
  isCryptoScanning = true;
  try {
    lastCryptoScanTime = new Date().toISOString();
    lastCryptoScanResult = await executeCryptoScanCycle();
    res.json({ status: 'OK', result: lastCryptoScanResult });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  } finally {
    isCryptoScanning = false;
  }
});

// Trigger Unified Multi-Market Scan (Forex, Gold, Crypto, Stocks) Concurrently
app.post('/api/scan-all', async (_req, res) => {
  console.log(`[*] [${new Date().toISOString()}] 🌐 เริ่มรอบการสแกนทุกตลาดพร้อมกัน (Forex, Gold, Crypto, Stock)...`);
  const results = await Promise.allSettled([
    (async () => {
      if (isForexScanning) return { skipped: true, reason: 'Already scanning' };
      isForexScanning = true;
      try {
        lastForexScanTime = new Date().toISOString();
        lastForexScanResult = await executeForexScanCycle();
        return lastForexScanResult;
      } finally {
        isForexScanning = false;
      }
    })(),
    (async () => {
      if (isGoldScanning) return { skipped: true, reason: 'Already scanning' };
      isGoldScanning = true;
      try {
        lastGoldScanTime = new Date().toISOString();
        lastGoldScanResult = await executeGoldScanCycle();
        return lastGoldScanResult;
      } finally {
        isGoldScanning = false;
      }
    })(),
    (async () => {
      if (isCryptoScanning) return { skipped: true, reason: 'Already scanning' };
      isCryptoScanning = true;
      try {
        lastCryptoScanTime = new Date().toISOString();
        lastCryptoScanResult = await executeCryptoScanCycle();
        return lastCryptoScanResult;
      } finally {
        isCryptoScanning = false;
      }
    })(),
    (async () => {
      if (isScanning) return { skipped: true, reason: 'Already scanning' };
      isScanning = true;
      try {
        lastScanTime = new Date().toISOString();
        lastScanResult = await executeScanCycle({ force: true });
        return lastScanResult;
      } finally {
        isScanning = false;
      }
    })()
  ]);

  res.json({
    status: 'OK',
    scannedAt: new Date().toISOString(),
    markets: {
      forex: results[0].status === 'fulfilled' ? results[0].value : { error: results[0].reason?.message },
      gold: results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason?.message },
      crypto: results[2].status === 'fulfilled' ? results[2].value : { error: results[2].reason?.message },
      stock: results[3].status === 'fulfilled' ? results[3].value : { error: results[3].reason?.message }
    }
  });
});

// Trigger Forex ML Model Retraining from Trade Results
app.post('/api/ml/retrain', async (_req, res) => {
  const pythonPath = process.env.PYTHON_PATH || 'python';
  const scriptPath = path.join(__dirname, 'scripts', 'retrain_from_trade_results.py');

  exec(`"${pythonPath}" "${scriptPath}"`, { cwd: __dirname }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ success: false, error: error.message, details: stderr });
    }
    res.json({ success: true, output: stdout.trim() });
  });
});

// Test Gemini Trade Review
app.post('/api/gemini/test-review', async (req, res) => {
  try {
    const {
      symbol = 'EURUSD',
      action = 'SELL',
      price = 1.1624,
      mlConfidence = 0.65
    } = req.body || {};

    const review = await reviewTradeWithGemini({
      symbol,
      cleanName: symbol.replace('=X', ''),
      action,
      price,
      atr: 0.00035,
      ema9: 1.1623,
      ema21: 1.1625,
      ema50: 1.1629,
      rsi: 42.5,
      adx: 24.8,
      macd_hist: -0.00004,
      dxyTrend: 'BULLISH',
      slPrice: 1.1638,
      tpPrice: 1.1602,
      slPips: 14,
      tpPips: 22,
      rrRatio: '1.57',
      mlConfidence
    });

    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Forex Status
app.get('/api/forex/status', (_req, res) => {
  res.json({
    botRunning,
    isForexScanning,
    tradingMode: getTradingModeStatus(),
    scanIntervalMinutes: SCAN_INTERVAL_MINUTES,
    confidenceThreshold: process.env.FOREX_DATA_HARVEST_LIVE_MODE === 'true'
      ? Number(process.env.FOREX_DATA_HARVEST_CONFIDENCE_THRESHOLD || 0.20)
      : Number(process.env.FOREX_CONFIDENCE_THRESHOLD || 0.58),
    dataHarvestLiveMode: process.env.FOREX_DATA_HARVEST_LIVE_MODE === 'true',
    dataHarvestConfidenceThreshold: Number(process.env.FOREX_DATA_HARVEST_CONFIDENCE_THRESHOLD || 0.20),
    dataHarvestMinConfluenceScore: Number(process.env.FOREX_DATA_HARVEST_MIN_CONFLUENCE_SCORE || 55),
    costAwareExits: {
      costBufferPipsMajor: Number(process.env.FOREX_COST_BUFFER_PIPS_MAJOR || 0.5),
      costBufferPipsJpy: Number(process.env.FOREX_COST_BUFFER_PIPS_JPY || 0.5),
      minNetTargetPips: Number(process.env.FOREX_MIN_NET_TARGET_PIPS || 0.5)
    },
    championModelVersion: process.env.FOREX_MODEL_VERSION || 'v1.2.0',
    challengerModelVersion: process.env.FOREX_CHALLENGER_MODEL_VERSION || 'challenger-v1.0.0',
    primaryModelRole: process.env.FOREX_PRIMARY_MODEL_ROLE || 'champion',
    shadowModelRole: process.env.FOREX_SHADOW_MODEL_ROLE || 'challenger',
    liveProductionGuard: process.env.FOREX_LIVE_PRODUCTION_GUARD === 'true',
    cryptoLiveEnabled: process.env.CRYPTO_LIVE_ENABLED === 'true',
    pocketEvaluation: {
      enabled: process.env.FOREX_POCKET_EVAL_ENABLED === 'true',
      expiryMinutes: Number(process.env.FOREX_POCKET_EVAL_EXPIRY_MINUTES || 5),
      productionBuyThreshold: Number(process.env.FOREX_POCKET_EVAL_PROD_BUY_THRESHOLD || 0.3721),
      productionSellThreshold: Number(process.env.FOREX_POCKET_EVAL_PROD_SELL_THRESHOLD || 0.1939),
      explorationThreshold: Number(process.env.FOREX_POCKET_EVAL_EXPLORE_THRESHOLD || 0.20)
    },
    rangeModelEnabled: process.env.FOREX_RANGE_MODEL_ENABLED === 'true',
    rangeLiveEnabled: process.env.FOREX_RANGE_LIVE_ENABLED === 'true',
    rangeModelVersion: process.env.FOREX_RANGE_MODEL_VERSION || 'range-v1.0.0',
    rangeConfidenceThreshold: Number(process.env.FOREX_RANGE_CONFIDENCE_THRESHOLD || 0.58),
    scaleIn: {
      enabled: process.env.FOREX_SCALE_IN_ENABLED === 'true',
      maxPositionsPerSymbol: Math.max(1, Number(process.env.FOREX_SCALE_IN_MAX_POSITIONS_PER_SYMBOL || 4)),
      minDistanceAtr: Number(process.env.FOREX_SCALE_IN_MIN_DISTANCE_ATR || 0.20),
      cooldownMinutes: Number(process.env.FOREX_SCALE_IN_COOLDOWN_MINUTES || 5),
      lotMultiplier: Number(process.env.FOREX_SCALE_IN_LOT_MULTIPLIER || 0.5)
    },
    reentry: {
      enabled: process.env.FOREX_REENTRY_ENABLED === 'true',
      maxPositionsPerSymbol: Math.max(2, Number(process.env.FOREX_REENTRY_MAX_POSITIONS_PER_SYMBOL || 4)),
      minConfidence: Number(process.env.FOREX_REENTRY_MIN_CONFIDENCE || 0.45)
    },
    universe: FOREX_UNIVERSE,
    lastForexScanTime,
    lastForexScanResult,
    isWeekend: isWeekendUS()
  });
});

// Challenger v1.7 Pocket-style fixed-expiry evaluation statistics.
// Kept separate from the normal Forex shadow/MT5 statistics so the result
// can be judged on the same 5-minute binary outcome that Pocket uses.
app.get('/api/forex/pocket-evaluation', async (req, res) => {
  try {
    const pool = await getPool();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const [summary] = await pool.query(
      `SELECT decision_mode,
              model_version,
              COUNT(*) AS total,
              SUM(CASE WHEN exit_reason = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN exit_reason <> 'OPEN' THEN 1 ELSE 0 END) AS closed_count,
              SUM(CASE WHEN exit_reason <> 'OPEN' AND is_win = 1 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN exit_reason <> 'OPEN' AND is_win = 0 THEN 1 ELSE 0 END) AS losses,
              ROUND(
                100 * SUM(CASE WHEN exit_reason <> 'OPEN' AND is_win = 1 THEN 1 ELSE 0 END)
                / NULLIF(SUM(CASE WHEN exit_reason <> 'OPEN' THEN 1 ELSE 0 END), 0),
                2
              ) AS win_rate_pct,
              ROUND(SUM(CASE WHEN exit_reason <> 'OPEN' THEN COALESCE(pips, 0) ELSE 0 END), 2) AS total_pips,
              ROUND(AVG(CASE WHEN exit_reason <> 'OPEN' THEN pips END), 2) AS avg_pips,
              ROUND(SUM(CASE WHEN exit_reason <> 'OPEN' THEN COALESCE(profit_loss, 0) ELSE 0 END), 2) AS total_pnl,
              MAX(entry_time) AS latest_entry_time,
              MAX(exit_time) AS latest_exit_time
       FROM trade_results
       WHERE market_type = 'forex_shadow'
         AND decision_mode IN ('POCKET_PROD_SHADOW', 'POCKET_EXPLORE_SHADOW')
       GROUP BY decision_mode, model_version
       ORDER BY decision_mode, model_version`
    );
    const [recent] = await pool.query(
      `SELECT id, decision_mode, model_version, symbol, action,
              entry_time, entry_price, exit_time, exit_price,
              exit_reason, is_win, pips, profit_loss, ai_confidence,
              prediction_meta
       FROM trade_results
       WHERE market_type = 'forex_shadow'
         AND decision_mode IN ('POCKET_PROD_SHADOW', 'POCKET_EXPLORE_SHADOW')
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );

    res.json({
      success: true,
      modelVersion: process.env.FOREX_CHALLENGER_MODEL_VERSION || 'challenger-v1.10.0',
      criteria: {
        expiryMinutes: Number(process.env.FOREX_POCKET_EVAL_EXPIRY_MINUTES || 5),
        production: {
          rawBuyThreshold: Number(process.env.FOREX_POCKET_EVAL_PROD_BUY_THRESHOLD || 0.3721),
          rawSellThreshold: Number(process.env.FOREX_POCKET_EVAL_PROD_SELL_THRESHOLD || 0.1939),
          minConfluence: Number(process.env.FOREX_POCKET_EVAL_PROD_MIN_CONFLUENCE || 55)
        },
        exploration: {
          rawDirectionalThreshold: Number(process.env.FOREX_POCKET_EVAL_EXPLORE_THRESHOLD || 0.20),
          minConfluence: Number(process.env.FOREX_POCKET_EVAL_EXPLORE_MIN_CONFLUENCE || 30)
        }
      },
      summary,
      recent
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// MetaTrader 5 (MT5) Account Status
app.get('/api/mt5/account', async (_req, res) => {
  try {
    const acc = await getAccountInfo();
    res.json(acc);
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// MetaTrader 5 (MT5) Open Positions
app.get('/api/mt5/positions', async (_req, res) => {
  try {
    const pos = await getOpenPositions();
    res.json(pos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MetaTrader 5 (MT5) Place Order API
app.post('/api/mt5/order', async (req, res) => {
  try {
    const {
      symbol = 'EURUSD',
      action = 'BUY',
      lot = 0.01,
      sl = 0.0,
      tp = 0.0,
      comment = 'API Manual Order'
    } = req.body;

    const normalizedSymbol = String(symbol).toUpperCase().replace(/=X$/, '');
    const isAllowedForex = FOREX_UNIVERSE.some(item => String(item).replace(/=X$/, '').toUpperCase() === normalizedSymbol);
    const isAllowedCrypto = CRYPTO_UNIVERSE.some(item => String(item).toUpperCase() === normalizedSymbol);
    if (!isAllowedForex && !isAllowedCrypto) {
      return res.status(403).json({
        success: false,
        error: 'MT5 live orders are currently limited to Forex and Crypto'
      });
    }

    console.log(`[*] [API /api/mt5/order] คำขอส่งออเดอร์: ${action} ${symbol} (Lot: ${lot}, SL: ${sl}, TP: ${tp})`);
    const orderRes = await placeOrder({ symbol, action, lot, sl, tp, comment });

    if (orderRes && orderRes.success) {
      // Record into database
      try {
        const pool = await getPool();
        const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const cleanSym = symbol.replace('=X', '');
        const isStock = ['NVDA', 'TSLA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AAPL', 'SPY'].includes(cleanSym);
        const isCryptoSymbol = CRYPTO_UNIVERSE.some(item => String(item).toUpperCase() === String(cleanSym).toUpperCase());
        const mType = isStock ? 'stock' : (isCryptoSymbol ? 'crypto' : 'forex');

        await pool.query(
          `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [nowStr, symbol, orderRes.price, 0.99, sl, tp, action.toUpperCase(), mType, orderRes.ticket]
        );

        await pool.query(
          `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note, market_type, mt5_ticket)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             entry_price = VALUES(entry_price),
             highest_price = VALUES(highest_price),
             sl_price = VALUES(sl_price),
             tp_price = VALUES(tp_price),
             status_note = VALUES(status_note),
             market_type = VALUES(market_type),
             mt5_ticket = VALUES(mt5_ticket)`,
          [symbol, nowStr, orderRes.price, orderRes.price, sl, tp, `API_${action.toUpperCase()}_OPEN`, mType, orderRes.ticket]
        );

        // Record initial feature snapshot into trade_results
        await recordTradeEntry({
          ticket: orderRes.ticket,
          symbol,
          marketType: mType,
          action,
          lotSize: lot,
          entryPrice: orderRes.price,
          confidence: 0.99,
          sl,
          tp,
          indicators: {},
          reasons: ['Manual API Order']
        });
      } catch (dbErr) {
        console.warn('⚠️ ไม่สามารถบันทึกลง Database ได้:', dbErr.message);
      }

      return res.json({ status: 'OK', order: orderRes });
    } else {
      return res.status(400).json({ status: 'ERROR', error: orderRes?.error || 'Order failed' });
    }
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Dedicated Freqtrade-to-MT5 integration. It uses a separate secret and is not
// coupled to the dashboard's manual-order API.
app.get('/api/integrations/freqtrade-mt5/status', (_req, res) => {
  res.json(getFreqtradeMt5Status());
});

app.post('/api/integrations/freqtrade-mt5/signal', async (req, res) => {
  const authorization = String(req.get('authorization') || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : req.get('x-freqtrade-token');
  if (!isFreqtradeMt5Authorized(token)) {
    return res.status(401).json({ error: 'Unauthorized Freqtrade-MT5 bridge request' });
  }

  try {
    const result = await processFreqtradeMt5Signal(req.body || {});
    return res.status(result.accepted ? 200 : 409).json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// MetaTrader 5 (MT5) Close Position API
app.post('/api/mt5/close', async (req, res) => {
  try {
    const { ticket } = req.body;
    if (!ticket) {
      return res.status(400).json({ status: 'ERROR', error: 'Missing ticket parameter' });
    }

    console.log(`[*] [API /api/mt5/close] คำขอปิดออเดอร์ Ticket #${ticket}`);
    const closeRes = await closePosition(ticket);

    if (closeRes && closeRes.success) {
      try {
        const pool = await getPool();
        await pool.query(
          `UPDATE active_positions 
           SET status_note = 'CLOSED_MANUAL' 
           WHERE mt5_ticket = ?`,
          [ticket]
        );

        // Record closed outcome in trade_results
        await recordTradeExit({
          ticket,
          symbol: closeRes.symbol,
          exitPrice: closeRes.price,
          exitReason: 'CLOSED_MANUAL'
        });
      } catch (dbErr) {
        console.warn('⚠️ ไม่สามารถอัปเดต Database ได้:', dbErr.message);
      }

      return res.json({ status: 'OK', result: closeRes });
    } else {
      return res.status(400).json({ status: 'ERROR', error: closeRes?.error || 'Close position failed' });
    }
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// AI Model Retrain API (One-Click Tri-Ensemble Retraining)
app.post(['/api/model/retrain', '/api/ml/retrain'], async (_req, res) => {
  try {
    console.log('[*] [API /api/model/retrain] กำลังเริ่มการ Retrain โมเดล Tri-Ensemble...');
    const pythonPath = process.env.PYTHON_PATH || 'python';
    const scriptPath = path.join(__dirname, 'scripts', 'retrain_from_trade_results.py');

    const child = spawn(pythonPath, [scriptPath, '--json'], {
      cwd: __dirname,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('close', code => {
      if (code !== 0) {
        console.error('❌ Model retrain process failed:', stderr || stdout);
        return res.status(500).json({ success: false, error: stderr || stdout });
      }

      try {
        const lines = stdout.trim().split('\n');
        const jsonLine = lines.find(l => l.trim().startsWith('{')) || lines[lines.length - 1];
        const result = JSON.parse(jsonLine);
        return res.json({ success: true, ...result });
      } catch (e) {
        return res.json({ success: true, message: 'Retrain completed', output: stdout });
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI Model Info API
app.get('/api/model/info', async (_req, res) => {
  try {
    const modelPath = path.join(__dirname, 'python', 'models', 'forex_m5_model.joblib');
    const pythonPath = process.env.PYTHON_PATH || 'python';
    
    const child = spawn(pythonPath, ['-c', `
import joblib, json, os
if os.path.exists(r'${modelPath}'):
    b = joblib.load(r'${modelPath}')
    print(json.dumps({
        'architecture': b.get('architecture', 'LightGBM + Random Forest'),
        'features': b.get('features', []),
        'auc_buy': b.get('auc_buy', 0.75),
        'auc_sell': b.get('auc_sell', 0.75),
        'live_samples_count': b.get('live_samples_count', 0),
        'total_samples_count': b.get('total_samples_count', 0),
        'trained_at': b.get('trained_at')
    }))
else:
    print(json.dumps({'error': 'not_found'}))
    `], { cwd: __dirname, windowsHide: true });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', code => {
      if (code === 0 && stdout.trim()) {
        try {
          return res.json({ success: true, ...JSON.parse(stdout.trim()) });
        } catch {}
      }
      res.json({ success: false, message: 'Could not read model info' });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trade Results & ML Features Log API (supports ?market=forex or ?market=stock or ?market=all)
app.get('/api/trade-results', async (req, res) => {
  try {
    const readyForRetrain = ['1', 'true', 'yes'].includes(String(req.query.ready_for_retrain || '').toLowerCase());
    const defaultLimit = readyForRetrain ? 5000 : 100;
    const limit = Math.min(5000, Number(req.query.limit || defaultLimit));
    const market = req.query.market ? String(req.query.market) : null;
    const results = await getTradeResults(limit, market, { readyForRetrain });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade Performance Statistics Summary API (supports ?market=forex or ?market=stock or ?market=all)
app.get('/api/trade-results/stats', async (req, res) => {
  try {
    const market = req.query.market ? String(req.query.market) : null;
    const stats = await getTradeStats(market);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Isolated Forex ML observation dataset. This endpoint never reads or mutates
// the legacy trade_results dataset.
app.get('/api/forex-ml-observations', async (req, res) => {
  try {
    const pool = await getPool();
    const ready = ['1', 'true', 'yes'].includes(String(req.query.ready_for_retrain || '').toLowerCase());
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit || 100)));
    const where = ready ? "WHERE outcome_status = 'LABELED'" : '';
    const [rows] = await pool.query(
      `SELECT * FROM forex_ml_observations ${where} ORDER BY bar_time DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed Historical Data (Stock)
app.post('/api/seed', async (_req, res) => {
  try {
    console.log('[*] ได้รับคำสั่ง Seed ข้อมูลย้อนหลังจาก API...');
    const result = await seedHistoricalData();
    res.json({ status: 'OK', result });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Signals List (supports ?market=stock or ?market=forex or ?market=all)
app.get('/api/signals', async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit || 50));
    const market = req.query.market ? String(req.query.market) : null;
    const pool = await getPool();

    let sql = 'SELECT * FROM signals';
    const params = [];

    if (market && market !== 'all') {
      sql += ' WHERE market_type = ?';
      params.push(market);
    }
    sql += ' ORDER BY time DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active Positions List (supports ?market=stock or ?market=forex, ?all=true)
app.get('/api/positions', async (req, res) => {
  try {
    const market = req.query.market ? String(req.query.market) : null;
    const showAll = req.query.all === 'true';
    const pool = await getPool();

    // Auto-sync database with MT5 reality (detects closed SL/TP)
    try {
      await syncMt5PositionsWithDatabase();
    } catch (syncErr) {
      console.warn('⚠️ Auto-sync warning:', syncErr.message);
    }

    let sql = 'SELECT * FROM active_positions';
    const params = [];
    const conditions = [];

    if (!showAll) {
      conditions.push("status_note NOT LIKE 'CLOSED%'");
    }

    if (market && market !== 'all') {
      conditions.push('market_type = ?');
      params.push(market);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY updated_at DESC';

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Market Bars for Symbol Chart
app.get('/api/bars', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'SPY');
    const limit = Math.min(250, Number(req.query.limit || 120));
    const pool = await getPool();
    const [rows] = await pool.query(
      'SELECT * FROM market_bars WHERE symbol = ? ORDER BY time ASC LIMIT ?',
      [symbol, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monitor Server compatibility endpoints
app.get('/api/tables', async (_req, res) => {
  try {
    const pool = await getPool();
    const dbName = process.env.DB_NAME || 'ai_trading_db';
    const [rows] = await pool.execute(
      `SELECT TABLE_NAME, TABLE_ROWS, UPDATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [dbName]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const pool = await getPool();
    const dbName = process.env.DB_NAME || 'ai_trading_db';
    const table = String(req.query.table || 'signals');

    const allowed = ['signals', 'active_positions', 'market_bars', 'trade_results', 'forex_ml_observations'];
    if (!allowed.includes(table)) {
      return res.status(400).json({ error: 'ตารางไม่ถูกต้อง' });
    }

    const [columnInfo] = await pool.execute(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [dbName, table]
    );

    const columns = columnInfo.map(c => c.COLUMN_NAME);
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY 1 DESC LIMIT 100`);

    res.json({
      table,
      columns,
      rows,
      numericColumns: columnInfo
        .filter(c => ['decimal', 'int', 'bigint', 'float', 'double'].includes(c.DATA_TYPE.toLowerCase()))
        .map(c => c.COLUMN_NAME)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log('='.repeat(60));
      console.log(`🤖 AI Swing Trading Bot Service (Node.js + XAMPP MySQL)`);
      console.log(`📡 Server URL: http://localhost:${PORT}`);
      console.log(`📊 Dashboard UI: http://localhost:${PORT}/`);
      console.log(`🗄️ MySQL Database: ${process.env.DB_NAME || 'ai_trading_db'}`);
      console.log('='.repeat(60));

      if (process.env.BOT_AUTO_START !== 'false') {
        startDaemon();
      } else {
        botRunning = false;
        console.log('[*] BOT_AUTO_START=false -> daemon remains stopped until explicitly started');
      }
    });
  } catch (err) {
    console.error('❌ ไม่สามารถเริ่มต้นเซิร์ฟเวอร์ได้:', err);
    process.exit(1);
  }
}

startServer();
