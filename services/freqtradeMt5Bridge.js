import crypto from 'crypto';
import dotenv from 'dotenv';

import { getPool } from '../config/database.js';
import { getOpenPositions, placeOrder } from './mt5Broker.js';
import { recordTradeEntry } from './tradeResultTracker.js';

dotenv.config();

export const FREQTRADE_MT5_SOURCE_TAG = 'freqtrade_mt5';
export const FREQTRADE_MT5_SUPPORTED_SYMBOLS = ['XAUUSD', 'EURUSD', 'BTCUSD'];

const INSTRUMENTS = {
  XAUUSD: { marketType: 'gold', defaultLot: 0.01, maxLotEnv: 'FREQTRADE_MT5_XAUUSD_MAX_LOT' },
  EURUSD: { marketType: 'forex', defaultLot: 0.01, maxLotEnv: 'FREQTRADE_MT5_EURUSD_MAX_LOT' },
  BTCUSD: { marketType: 'crypto', defaultLot: 0.01, maxLotEnv: 'FREQTRADE_MT5_BTCUSD_MAX_LOT' }
};

function normalizeSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase().replace('=X', '');
  if (!INSTRUMENTS[normalized]) {
    throw new Error(`Unsupported symbol '${symbol}'. Allowed: ${FREQTRADE_MT5_SUPPORTED_SYMBOLS.join(', ')}`);
  }
  return normalized;
}

function parseLot(symbol, requestedLot) {
  const instrument = INSTRUMENTS[symbol];
  const lot = requestedLot === undefined || requestedLot === null ? instrument.defaultLot : Number(requestedLot);
  const maxLot = Number(process.env[instrument.maxLotEnv] || process.env.FREQTRADE_MT5_MAX_LOT || instrument.defaultLot);
  if (!Number.isFinite(lot) || lot <= 0) throw new Error('lot must be a positive number');
  if (!Number.isFinite(maxLot) || maxLot <= 0 || lot > maxLot) {
    throw new Error(`lot ${lot} exceeds the bridge limit for ${symbol} (${maxLot})`);
  }
  return lot;
}

function goldAliases(symbol) {
  return symbol === 'XAUUSD' ? ['XAUUSD', 'GOLD'] : [symbol];
}

export function getFreqtradeMt5Status() {
  return {
    sourceTag: FREQTRADE_MT5_SOURCE_TAG,
    supportedSymbols: FREQTRADE_MT5_SUPPORTED_SYMBOLS,
    executionEnabled: process.env.FREQTRADE_MT5_EXECUTION_ENABLED === 'true',
    mt5Enabled: process.env.MT5_ENABLED === 'true',
    webhookTokenConfigured: Boolean(process.env.FREQTRADE_MT5_WEBHOOK_TOKEN)
  };
}

export function isFreqtradeMt5Authorized(token) {
  const expected = process.env.FREQTRADE_MT5_WEBHOOK_TOKEN;
  if (!expected || !token) return false;
  const actualBuffer = Buffer.from(String(token));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * Accept a signal from an external Freqtrade strategy and, only when explicitly
 * enabled, execute a market order on MT5.  Shadow mode still logs the signal
 * but cannot create an order.
 */
export async function processFreqtradeMt5Signal(input = {}) {
  const symbol = normalizeSymbol(input.symbol);
  const action = String(input.action || '').trim().toUpperCase();
  if (!['BUY', 'SELL'].includes(action)) throw new Error('action must be BUY or SELL');

  const lot = parseLot(symbol, input.lot);
  const marketType = INSTRUMENTS[symbol].marketType;
  const sl = Number(input.sl || 0);
  const tp = Number(input.tp || 0);
  const confidence = Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.5;
  const signalId = String(input.signalId || input.idempotencyKey || crypto.randomUUID()).slice(0, 64);
  const pool = await getPool();
  const aliases = goldAliases(symbol);

  // Never let an imported signal increase exposure when the existing engines
  // or an operator already hold the same underlying instrument.
  const [dbOpen] = await pool.query(
    `SELECT mt5_ticket, source_tag FROM active_positions
     WHERE symbol IN (?) AND status_note NOT LIKE 'CLOSED%' LIMIT 1`,
    [aliases]
  );
  if (dbOpen.length > 0) {
    return { accepted: false, executed: false, reason: 'ALREADY_OPEN_DATABASE', symbol, sourceTag: FREQTRADE_MT5_SOURCE_TAG };
  }

  const mt5Open = await getOpenPositions();
  if (Array.isArray(mt5Open) && mt5Open.some(p => aliases.includes(String(p.symbol).toUpperCase()))) {
    return { accepted: false, executed: false, reason: 'ALREADY_OPEN_MT5', symbol, sourceTag: FREQTRADE_MT5_SOURCE_TAG };
  }

  const executionEnabled = process.env.FREQTRADE_MT5_EXECUTION_ENABLED === 'true' && process.env.MT5_ENABLED === 'true';
  let order = null;
  if (executionEnabled) {
    order = await placeOrder({
      symbol,
      action,
      lot,
      sl,
      tp,
      comment: `FTMT5:${signalId.slice(0, 20)}`
    });
    if (!order?.success) {
      return { accepted: false, executed: false, reason: order?.error || 'MT5_ORDER_REJECTED', symbol, sourceTag: FREQTRADE_MT5_SOURCE_TAG };
    }
  }

  const executionPrice = Number(order?.price || input.price || 0);
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
    throw new Error('price is required for shadow signals and must be positive');
  }
  const brokerSymbol = order?.symbol || symbol;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const mode = executionEnabled ? 'LIVE' : 'SHADOW';
  const metadata = {
    signalId,
    requestedSymbol: symbol,
    source: FREQTRADE_MT5_SOURCE_TAG,
    mode,
    externalMeta: input.meta || null
  };

  await pool.query(
    `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket, source_tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nowStr, brokerSymbol, executionPrice, confidence, sl, tp, action, marketType, order?.ticket || null, FREQTRADE_MT5_SOURCE_TAG]
  );

  if (executionEnabled) {
    await pool.query(
      `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note, market_type, mt5_ticket, source_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [brokerSymbol, nowStr, executionPrice, executionPrice, sl, tp, `FREQTRADE_MT5_${action}_OPEN`, marketType, order.ticket, FREQTRADE_MT5_SOURCE_TAG]
    );
    await recordTradeEntry({
      ticket: order.ticket,
      symbol: brokerSymbol,
      marketType,
      action,
      lotSize: lot,
      entryPrice: executionPrice,
      confidence,
      sl,
      tp,
      indicators: input.indicators || {},
      reasons: ['Freqtrade-MT5 bridge', `signal_id:${signalId}`],
      modelSource: FREQTRADE_MT5_SOURCE_TAG,
      modelVersion: String(input.strategyVersion || 'external'),
      strategyVersion: String(input.strategyName || 'freqtrade_signal'),
      decisionMode: 'FREQTRADE_MT5_LIVE',
      predictionMeta: metadata,
      sourceTag: FREQTRADE_MT5_SOURCE_TAG
    });
  }

  return {
    accepted: true,
    executed: executionEnabled,
    mode,
    sourceTag: FREQTRADE_MT5_SOURCE_TAG,
    signalId,
    symbol: brokerSymbol,
    requestedSymbol: symbol,
    action,
    lot,
    ticket: order?.ticket || null
  };
}
