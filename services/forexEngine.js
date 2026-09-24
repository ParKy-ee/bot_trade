import { getPool } from '../config/database.js';
import { fetchMarketData, FOREX_UNIVERSE } from './marketData.js';
import { evaluateForexFirstStageFilter } from './forexFilter.js';
import { sendTelegramAlert } from './telegramAlert.js';
import { placeOrder, placePendingOrder, getPendingOrders, cancelPendingOrder, modifyStopLoss, closePosition, getRates, getOpenPositions } from './mt5Broker.js';
import { recordTradeEntry, recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';
import { predictForexConfidence, predictForexChallengerConfidence, predictForexRangeConfidence, predictForexExitChallenger, predictForexMarketPressure } from './modelPredictor.js';
import { reviewTradeWithGemini } from './geminiReviewer.js';
import { calculateDynamicForexExit, validateForexExitGeometry } from './forexExitEngine.js';
import { calculateCurrencyStrength, getPairCsmSpread } from './currencyStrength.js';
import { checkOverextension, checkRejectionCandle, checkCompressionBreakout, calculatePullbackLevel } from './forexPriceAction.js';
import { evaluateRangeExpertSetup } from './forexRangeExpert.js';
import { buildForexFeatures, recordForexMlObservation, labelForexMlObservations } from './forexMlObservationTracker.js';
import { createHash } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Explicit exploration policy for collecting more real, labelled trade outcomes.
// It relaxes performance/frequency throttles only; broker/duplicate/geometry
// guards remain active below.
const DATA_HARVEST_LIVE_MODE = process.env.FOREX_DATA_HARVEST_LIVE_MODE === 'true';
const DATA_HARVEST_CONFIDENCE_THRESHOLD = Number(
  process.env.FOREX_DATA_HARVEST_CONFIDENCE_THRESHOLD || 0.20
);
const DATA_HARVEST_MIN_CONFLUENCE_SCORE = Number(
  process.env.FOREX_DATA_HARVEST_MIN_CONFLUENCE_SCORE || 55
);
const FOREX_COST_BUFFER_PIPS_MAJOR = Math.max(
  0,
  Number(process.env.FOREX_COST_BUFFER_PIPS_MAJOR || 0.5)
);
const FOREX_COST_BUFFER_PIPS_JPY = Math.max(
  0,
  Number(process.env.FOREX_COST_BUFFER_PIPS_JPY || 0.5)
);
const FOREX_MIN_NET_TARGET_PIPS = Math.max(
  0,
  Number(process.env.FOREX_MIN_NET_TARGET_PIPS || 0.5)
);
const CONFIDENCE_THRESHOLD = DATA_HARVEST_LIVE_MODE
  ? DATA_HARVEST_CONFIDENCE_THRESHOLD
  : Number(process.env.FOREX_CONFIDENCE_THRESHOLD || 0.58);
const CHALLENGER_ENABLED = process.env.FOREX_CHALLENGER_ENABLED === 'true';
const CHAMPION_MODEL_SOURCE = 'forex_champion';
const CHAMPION_MODEL_VERSION = process.env.FOREX_MODEL_VERSION || 'v1.2.0';
const STRATEGY_VERSION = process.env.FOREX_STRATEGY_VERSION || 'ver.beta.5.4';
const CHALLENGER_MODEL_SOURCE = 'forex_challenger';
const CHALLENGER_MODEL_VERSION = process.env.FOREX_CHALLENGER_MODEL_VERSION || 'challenger-v1.0.0';
const CHALLENGER_THRESHOLD = Number(process.env.FOREX_CHALLENGER_CONFIDENCE_THRESHOLD || 0.52);
const normalizeModelRole = value => String(value || '').trim().toLowerCase() === 'challenger' ? 'challenger' : 'champion';
const PRIMARY_MODEL_ROLE = normalizeModelRole(process.env.FOREX_PRIMARY_MODEL_ROLE || 'champion');
const SHADOW_MODEL_ROLE = normalizeModelRole(process.env.FOREX_SHADOW_MODEL_ROLE || (PRIMARY_MODEL_ROLE === 'challenger' ? 'champion' : 'challenger'));
const PRIMARY_MODEL_SOURCE = PRIMARY_MODEL_ROLE === 'challenger' ? CHALLENGER_MODEL_SOURCE : CHAMPION_MODEL_SOURCE;
const PRIMARY_MODEL_VERSION = PRIMARY_MODEL_ROLE === 'challenger' ? CHALLENGER_MODEL_VERSION : CHAMPION_MODEL_VERSION;
const SHADOW_MODEL_SOURCE = SHADOW_MODEL_ROLE === 'challenger' ? CHALLENGER_MODEL_SOURCE : CHAMPION_MODEL_SOURCE;
const SHADOW_MODEL_VERSION = SHADOW_MODEL_ROLE === 'challenger' ? CHALLENGER_MODEL_VERSION : CHAMPION_MODEL_VERSION;
const predictPrimaryForex = PRIMARY_MODEL_ROLE === 'challenger'
  ? predictForexChallengerConfidence
  : predictForexConfidence;
const predictShadowForex = SHADOW_MODEL_ROLE === 'challenger'
  ? predictForexChallengerConfidence
  : predictForexConfidence;
const LIVE_PRODUCTION_GUARD = process.env.FOREX_LIVE_PRODUCTION_GUARD === 'true';
const POCKET_EVAL_ENABLED = process.env.FOREX_POCKET_EVAL_ENABLED === 'true';
const POCKET_EVAL_EXPIRY_MINUTES = Math.max(1, Number(process.env.FOREX_POCKET_EVAL_EXPIRY_MINUTES || 5));
const POCKET_EVAL_PROD_BUY_THRESHOLD = Number(process.env.FOREX_POCKET_EVAL_PROD_BUY_THRESHOLD || 0.3721);
const POCKET_EVAL_PROD_SELL_THRESHOLD = Number(process.env.FOREX_POCKET_EVAL_PROD_SELL_THRESHOLD || 0.1939);
const POCKET_EVAL_PROD_MIN_CONFLUENCE = Number(process.env.FOREX_POCKET_EVAL_PROD_MIN_CONFLUENCE || 55);
const POCKET_EVAL_EXPLORE_THRESHOLD = Number(process.env.FOREX_POCKET_EVAL_EXPLORE_THRESHOLD || 0.20);
const POCKET_EVAL_EXPLORE_MIN_CONFLUENCE = Number(process.env.FOREX_POCKET_EVAL_EXPLORE_MIN_CONFLUENCE || 30);
const POCKET_PROD_DECISION_MODE = 'POCKET_PROD_SHADOW';
const POCKET_EXPLORE_DECISION_MODE = 'POCKET_EXPLORE_SHADOW';

// The Challenger bridge exposes both relative confidence and raw directional
// probabilities. Registry thresholds were calibrated on raw probabilities,
// so use those for eligibility and keep relative confidence as the reported
// trade metric.
function getDirectionalModelScore(modelMeta, action) {
  const direction = String(action || '').toUpperCase();
  const rawKey = direction === 'SELL' ? 'raw_sell' : 'raw_buy';
  const rawScore = Number(modelMeta?.[rawKey]);
  if (Number.isFinite(rawScore)) return rawScore;
  const fallback = Number(modelMeta?.confidence);
  return Number.isFinite(fallback) ? fallback : 0;
}

function getRawDirectionalThreshold(action) {
  return String(action || '').toUpperCase() === 'BUY'
    ? POCKET_EVAL_PROD_BUY_THRESHOLD
    : POCKET_EVAL_PROD_SELL_THRESHOLD;
}

const RANGE_MODEL_ENABLED = process.env.FOREX_RANGE_MODEL_ENABLED === 'true';
const RANGE_LIVE_ENABLED = process.env.FOREX_RANGE_LIVE_ENABLED === 'true';
const RANGE_MODEL_SOURCE = 'forex_range';
const RANGE_MODEL_VERSION = process.env.FOREX_RANGE_MODEL_VERSION || 'range-v1.0.0';
const RANGE_THRESHOLD = Number(process.env.FOREX_RANGE_CONFIDENCE_THRESHOLD || 0.58);
// Entry-policy-only scale-in lane. This does not change the Forex feature
// vector or the champion/challenger model decision; it only permits one
// additional, smaller entry after an existing position has moved in favor.
const SCALE_IN_ENABLED = process.env.FOREX_SCALE_IN_ENABLED === 'true';
const SCALE_IN_MAX_POSITIONS_PER_SYMBOL = Math.max(1, Number(process.env.FOREX_SCALE_IN_MAX_POSITIONS_PER_SYMBOL || 4));
const SCALE_IN_MIN_DISTANCE_ATR = Math.max(0.05, Number(process.env.FOREX_SCALE_IN_MIN_DISTANCE_ATR || 0.20));
const SCALE_IN_COOLDOWN_MINUTES = Math.max(1, Number(process.env.FOREX_SCALE_IN_COOLDOWN_MINUTES || 5));
const SCALE_IN_LOT_MULTIPLIER = Math.min(1, Math.max(0.1, Number(process.env.FOREX_SCALE_IN_LOT_MULTIPLIER || 0.5)));
// Optional second-entry lane: permits a fresh high-confidence signal to add
// up to MAX_POSITIONS tickets while an existing same-symbol position is still open.
const REENTRY_ENABLED = process.env.FOREX_REENTRY_ENABLED === 'true';
const REENTRY_MAX_POSITIONS_PER_SYMBOL = Math.max(
  2,
  Number(process.env.FOREX_REENTRY_MAX_POSITIONS_PER_SYMBOL || 4)
);
const REENTRY_MIN_CONFIDENCE = Math.min(
  0.95,
  Math.max(0, Number(process.env.FOREX_REENTRY_MIN_CONFIDENCE || 0.45))
);
const MODEL_CONFIG_HASH = createHash('sha256').update(JSON.stringify({
  strategy: STRATEGY_VERSION,
  champion: CHAMPION_MODEL_VERSION,
  challenger: CHALLENGER_MODEL_VERSION,
  primaryRole: PRIMARY_MODEL_ROLE,
  shadowRole: SHADOW_MODEL_ROLE,
  liveProductionGuard: LIVE_PRODUCTION_GUARD,
  pocketEvalExpiryMinutes: POCKET_EVAL_EXPIRY_MINUTES,
  pocketProdBuyThreshold: POCKET_EVAL_PROD_BUY_THRESHOLD,
  pocketProdSellThreshold: POCKET_EVAL_PROD_SELL_THRESHOLD,
  pocketExploreThreshold: POCKET_EVAL_EXPLORE_THRESHOLD,
  range: RANGE_MODEL_VERSION,
  dataHarvestLiveMode: DATA_HARVEST_LIVE_MODE,
  dataHarvestConfidenceThreshold: DATA_HARVEST_CONFIDENCE_THRESHOLD,
  dataHarvestMinConfluenceScore: DATA_HARVEST_MIN_CONFLUENCE_SCORE,
  costBufferPipsMajor: FOREX_COST_BUFFER_PIPS_MAJOR,
  costBufferPipsJpy: FOREX_COST_BUFFER_PIPS_JPY,
  minNetTargetPips: FOREX_MIN_NET_TARGET_PIPS,
  confidenceThreshold: CONFIDENCE_THRESHOLD,
  challengerThreshold: CHALLENGER_THRESHOLD,
  tpMultiplier: process.env.FOREX_TP_MULTIPLIER || '0.5',
  minRiskReward: process.env.FOREX_DYNAMIC_MIN_RR || '1.0',
  dynamicConfidenceThreshold: process.env.FOREX_DYNAMIC_CONFIDENCE_THRESHOLD || '0.58',
  gating: process.env.FOREX_GATING_ENABLED || 'true',
  scaleIn: {
    enabled: SCALE_IN_ENABLED,
    maxPositionsPerSymbol: SCALE_IN_MAX_POSITIONS_PER_SYMBOL,
    minDistanceAtr: SCALE_IN_MIN_DISTANCE_ATR,
    cooldownMinutes: SCALE_IN_COOLDOWN_MINUTES,
    lotMultiplier: SCALE_IN_LOT_MULTIPLIER
  },
  reentry: {
    enabled: REENTRY_ENABLED,
    maxPositionsPerSymbol: REENTRY_MAX_POSITIONS_PER_SYMBOL,
    minConfidence: REENTRY_MIN_CONFIDENCE
  }
})).digest('hex').slice(0, 16);

/**
 * Checks if current time falls within statistically dangerous Forex transition periods (GMT+7).
 * - London Fix / Transition: 16:00 - 17:00 (15 losses out of 15 trades observed on 2026-09-08)
 * - Pre-US Open Choppiness: 19:00 - 20:15 (8 losses out of 8 trades observed on 2026-09-08)
 */
export function checkForexSessionGuard(date = new Date()) {
  const utcHours = date.getUTCHours();
  const utcMinutes = date.getUTCMinutes();
  const bangkokTotalMinutes = ((utcHours + 7) % 24) * 60 + utcMinutes;

  // Window 1: 16:00 - 17:00 (960 to 1020 minutes)
  if (bangkokTotalMinutes >= 16 * 60 && bangkokTotalMinutes < 17 * 60) {
    return {
      blocked: true,
      reason: `ช่วงเวลาผันผวนสูง London Fix (16:00 - 17:00 น. เวลาไทย) มีความเสี่ยง False Breakout สูง`
    };
  }

  // Window 2: 19:00 - 20:15 (1140 to 1215 minutes)
  if (bangkokTotalMinutes >= 19 * 60 && bangkokTotalMinutes < 20 * 60 + 15) {
    return {
      blocked: true,
      reason: `ช่วงเวลาก่อนตลาดสหรัฐเปิด (19:00 - 20:15 น. เวลาไทย) ตลาด M5 สวิงไร้ทิศทาง`
    };
  }

  return { blocked: false };
}

function evaluatePocketProductionGuard({
  bars,
  symbol,
  qualified,
  bias,
  activeTrack,
  confluenceScore,
  indicators,
  csmSpread,
  atr,
  isJpy,
  isPressureBypass = false,
  isCounterPressure = false
} = {}) {
  const reasons = [];
  const direction = String(bias || '').toUpperCase();

  if (isCounterPressure) {
    reasons.push('market pressure detected strong opposite push (Counter-Pressure Shield)');
  }

  if (!qualified || !['BUY', 'SELL'].includes(direction)) {
    reasons.push('first-stage filter did not qualify the setup');
  }
  if (activeTrack === 'RANGE_MEAN_REVERSION') {
    reasons.push('range mean-reversion track is excluded from Pocket evaluation');
  }
  if (Number(confluenceScore || 0) < POCKET_EVAL_PROD_MIN_CONFLUENCE) {
    reasons.push(`confluence ${Number(confluenceScore || 0)} < ${POCKET_EVAL_PROD_MIN_CONFLUENCE}`);
  }

  const minAdx = isJpy
    ? Number(process.env.FOREX_GATING_MIN_ADX_JPY || 14)
    : Number(process.env.FOREX_GATING_MIN_ADX_MAJOR || 12);
  const configuredMinCsm = isJpy
    ? Number(process.env.FOREX_GATING_MIN_CSM_JPY || 0.3)
    : Number(process.env.FOREX_GATING_MIN_CSM_MAJOR || 0.2);
  const currentAdx = Number(indicators?.adx14 || 0);
  const absCsm = Math.abs(Number(csmSpread || 0));
  const isConfluenceBypass = ((activeTrack === 'SQUEEZE_BREAKOUT' || activeTrack === 'PULLBACK_DIP')
    && Number(confluenceScore || 0) >= 60) || isPressureBypass;

  if (currentAdx < minAdx && !isConfluenceBypass) {
    reasons.push(`ADX ${currentAdx.toFixed(1)} < ${minAdx}`);
  }
  if (absCsm < configuredMinCsm && !isConfluenceBypass) {
    reasons.push(`|CSM| ${absCsm.toFixed(2)} < ${configuredMinCsm}`);
  }

  if (bars && ['BUY', 'SELL'].includes(direction)) {
    const rejectionCheck = checkRejectionCandle(bars, direction, atr);
    if (rejectionCheck.hasRejection && !isPressureBypass) {
      reasons.push(`rejection candle: ${rejectionCheck.reason}`);
    }
  }

  const sessionGuard = checkForexSessionGuard();
  if (sessionGuard.blocked) reasons.push(sessionGuard.reason);

  return {
    passed: reasons.length === 0,
    reasons
  };
}

async function recordPocketEvaluationSignal({
  pool,
  symbol,
  barTime,
  bias,
  entryPrice,
  slPrice,
  tpPrice,
  confidence,
  directionalScore,
  modelMeta,
  decisionMode,
  confluenceScore,
  guardResult
} = {}) {
  const modelVersion = modelMeta?.model_version || CHALLENGER_MODEL_VERSION;
  const pairId = createHash('sha256')
    .update(`${symbol}|${String(barTime || '')}|${bias}|${decisionMode}`)
    .digest('hex')
    .slice(0, 32);
  const [existing] = await pool.query(
    `SELECT id FROM trade_results
     WHERE symbol = ?
       AND market_type = 'forex_shadow'
       AND model_source = ?
       AND model_version = ?
       AND decision_mode = ?
       AND exit_reason = 'OPEN'
     LIMIT 1`,
    [symbol, CHALLENGER_MODEL_SOURCE, modelVersion, decisionMode]
  );
  if (existing.length > 0) return existing[0].id;

  return recordTradeEntry({
    ticket: null,
    symbol,
    marketType: 'forex_shadow',
    pairId,
    action: bias,
    lotSize: 0.01,
    entryPrice,
    confidence,
    sl: slPrice,
    tp: tpPrice,
    indicators: {},
    reasons: [
      `[${decisionMode}] Challenger ${modelVersion}`,
      `Pocket expiry ${POCKET_EVAL_EXPIRY_MINUTES}m`,
      `Confluence ${confluenceScore}`,
      ...(guardResult?.reasons || [])
    ],
    modelSource: CHALLENGER_MODEL_SOURCE,
    modelVersion,
    strategyVersion: STRATEGY_VERSION,
    configHash: MODEL_CONFIG_HASH,
    decisionMode,
    predictionMeta: {
      evaluation: 'POCKET_FIXED_EXPIRY',
      expiry_minutes: POCKET_EVAL_EXPIRY_MINUTES,
      confluence_score: confluenceScore,
      directional_score: directionalScore,
      guard_reasons: guardResult?.reasons || [],
      threshold_type: 'raw_directional_probability',
      prediction: modelMeta
    },
    sourceTag: 'forex_pocket_eval'
  });
}

async function evaluatePocketShadowTrades({ pool, rawData } = {}) {
  if (!POCKET_EVAL_ENABLED) return;
  try {
    const [openPocketTrades] = await pool.query(
      `SELECT * FROM trade_results
       WHERE market_type = 'forex_shadow'
         AND decision_mode IN (?, ?)
         AND exit_reason = 'OPEN'`,
      [POCKET_PROD_DECISION_MODE, POCKET_EXPLORE_DECISION_MODE]
    );
    for (const trade of openPocketTrades) {
      const bars = rawData?.[trade.symbol];
      if (!bars || bars.length === 0) continue;
      const holdMin = Math.max(1, Math.round((new Date() - new Date(trade.entry_time)) / (1000 * 60)));
      const currClose = Number(bars[bars.length - 1]?.close);
      const currHigh = Number(bars[bars.length - 1]?.high);
      const currLow = Number(bars[bars.length - 1]?.low);
      const currOpen = Number(bars[bars.length - 1]?.open);
      const entryPrice = Number(trade.entry_price);
      if (!Number.isFinite(currClose) || !Number.isFinite(entryPrice)) continue;

      const action = String(trade.action || '').toUpperCase();
      const isJpy = String(trade.symbol || '').includes('JPY');
      const pipMult = isJpy ? 100.0 : 10000.0;
      const floatingPips = action === 'BUY'
        ? (currClose - entryPrice) * pipMult
        : (entryPrice - currClose) * pipMult;

      // 1. Intra-Trade Exit Challenger Evaluation (Active after at least 2 bars / 10 mins)
      if (holdMin >= 10 && bars.length >= 2) {
        try {
          const entryTimeMs = new Date(trade.entry_time).getTime();
          const barsSinceEntry = bars.filter(b => new Date(b.time).getTime() >= entryTimeMs);
          
          let maxMfe = -Infinity;
          let minMae = Infinity;
          for (const b of barsSinceEntry) {
            const h = Number(b.high);
            const l = Number(b.low);
            const mfe = action === 'BUY' ? (h - entryPrice) * pipMult : (entryPrice - l) * pipMult;
            const mae = action === 'BUY' ? (l - entryPrice) * pipMult : (entryPrice - h) * pipMult;
            if (mfe > maxMfe) maxMfe = mfe;
            if (mae < minMae) minMae = mae;
          }
          const cumMfePips = Math.max(0, maxMfe === -Infinity ? floatingPips : maxMfe);
          const cumMaePips = Math.min(0, minMae === Infinity ? floatingPips : minMae);
          const givebackPips = Math.max(0, cumMfePips - floatingPips);

          const latestBar = bars[bars.length - 1];
          const candleRange = (currHigh - currLow) + 0.00001;
          const candleBodyRatio = (currClose - currOpen) / candleRange;
          const upperWickRatio = (currHigh - Math.max(currClose, currOpen)) / candleRange;
          const lowerWickRatio = (Math.min(currClose, currOpen) - currLow) / candleRange;
          const adversePressure = action === 'BUY' ? -candleBodyRatio : candleBodyRatio;
          const rsi = Number(latestBar.rsi || 50.0);
          const atrPips = Number(latestBar.atr || 0.001) * pipMult;

          const exitEval = await predictForexExitChallenger({
            is_buy: action === 'BUY' ? 1 : 0,
            bar_index: Math.max(1, Math.round(holdMin / 5)),
            floating_pips: floatingPips,
            cum_mfe_pips: cumMfePips,
            cum_mae_pips: cumMaePips,
            giveback_pips: givebackPips,
            candle_body_ratio: candleBodyRatio,
            upper_wick_ratio: upperWickRatio,
            lower_wick_ratio: lowerWickRatio,
            adverse_pressure: adversePressure,
            rsi,
            atr_pips: atrPips
          });

          // Check STALL_HARVEST (Lock in profit before reversal)
          if (exitEval?.action === 'STALL_HARVEST' && exitEval?.probabilities?.stall_harvest >= 0.60 && floatingPips >= 2.0) {
            const exitReason = 'EXIT_CHALLENGER_STALL_HARVEST';
            await recordTradeExit({
              ticket: null,
              symbol: trade.symbol,
              exitPrice: currClose,
              exitReason,
              tradeResultId: trade.id
            });
            console.log(`🎯 [CHALLENGER_EXIT_V1.1.0] ${trade.symbol} ${action} STALL_HARVEST triggered @ ${currClose} (Locked +${floatingPips.toFixed(1)} pips | Prob: ${(exitEval.probabilities.stall_harvest * 100).toFixed(1)}%)`);
            continue;
          }

          // Check EARLY_CUT (Cut loss before full Hard SL)
          if (exitEval?.action === 'EARLY_CUT' && exitEval?.probabilities?.early_cut >= 0.55 && floatingPips <= -2.0) {
            const exitReason = 'EXIT_CHALLENGER_EARLY_CUT';
            await recordTradeExit({
              ticket: null,
              symbol: trade.symbol,
              exitPrice: currClose,
              exitReason,
              tradeResultId: trade.id
            });
            console.log(`✂️ [CHALLENGER_EXIT_V1.1.0] ${trade.symbol} ${action} EARLY_CUT triggered @ ${currClose} (Saved from Hard SL! Floating: ${floatingPips.toFixed(1)} pips | Prob: ${(exitEval.probabilities.early_cut * 100).toFixed(1)}%)`);
            continue;
          }
        } catch (exitErr) {
          // Keep normal execution if inference has transient error
          console.warn(`⚠️ [CHALLENGER_EXIT] Error evaluating intra-trade exit for ${trade.symbol}:`, exitErr.message);
        }
      }

      // 2. Standard Fixed-Time Expiry Fallback
      if (holdMin < POCKET_EVAL_EXPIRY_MINUTES) continue;

      const isWin = action === 'BUY' ? currClose > entryPrice : currClose < entryPrice;
      const isTie = currClose === entryPrice;
      const exitReason = isTie
        ? 'POCKET_EXPIRY_TIE'
        : (isWin ? 'POCKET_EXPIRY_WIN' : 'POCKET_EXPIRY_LOSS');

      await recordTradeExit({
        ticket: null,
        symbol: trade.symbol,
        exitPrice: currClose,
        exitReason,
        tradeResultId: trade.id
      });
      console.log(`👻 [${trade.decision_mode}] ${trade.symbol} ${action} -> ${exitReason} @ ${currClose}`);
    }
  } catch (err) {
    console.warn('⚠️ Error evaluating Pocket fixed-expiry shadows:', err.message);
  }
}

/**
 * Break down a symbol and action into directional currency exposures.
 * e.g. BUY EURUSD -> { EUR: 'LONG', USD: 'SHORT' }
 *      BUY EURJPY -> { EUR: 'LONG', JPY: 'SHORT' }
 *      SELL USDJPY -> { USD: 'SHORT', JPY: 'LONG' }
 */
export function getCurrencyExposures(symbol, action) {
  const clean = String(symbol || '').replace('=X', '').toUpperCase();
  if (clean.length < 6) return [];
  const base = clean.substring(0, 3);
  const quote = clean.substring(3, 6);
  const isBuy = String(action || '').toUpperCase().includes('BUY');
  return [
    { currency: base, side: isBuy ? 'LONG' : 'SHORT' },
    { currency: quote, side: isBuy ? 'SHORT' : 'LONG' }
  ];
}

/**
 * Ensures the portfolio does not take multiple directional bets on the same currency.
 * e.g. Prevents holding BUY EURJPY + BUY GBPJPY + BUY USDJPY (triple SHORT JPY).
 */
export function checkCorrelatedCurrencyGuard(existingPositions = [], newSymbol = '', newAction = '', maxLimit = 1) {
  const newExposures = getCurrencyExposures(newSymbol, newAction);
  if (newExposures.length === 0) return { blocked: false };

  for (const newExp of newExposures) {
    let sameSideCount = 0;
    let conflictSymbol = '';

    for (const pos of existingPositions) {
      const posSymbol = pos.symbol || '';
      if (posSymbol.replace('=X', '').toUpperCase() === newSymbol.replace('=X', '').toUpperCase()) {
        continue;
      }
      const posAction = pos.type || (pos.status_note && pos.status_note.includes('BUY') ? 'BUY' : 'SELL');
      const posExposures = getCurrencyExposures(posSymbol, posAction);

      for (const posExp of posExposures) {
        if (posExp.currency === newExp.currency && posExp.side === newExp.side) {
          sameSideCount++;
          conflictSymbol = posSymbol.replace('=X', '');
        }
      }
    }

    if (sameSideCount >= maxLimit) {
      return {
        blocked: true,
        currency: newExp.currency,
        side: newExp.side,
        conflictSymbol,
        reason: `พอร์ตมีออเดอร์ถือครองทิศทาง ${newExp.side} ${newExp.currency} อยู่แล้ว (${conflictSymbol}) ป้องกัน Correlated Cluster Risk`
      };
    }
  }

  return { blocked: false };
}

/**
 * Checks if symbol had consecutive realized losses within cooldown window.
 * Pending orders that expired/canceled without a fill are not losses and must
 * not lock the live entry path.
 */
export async function checkConsecutiveLossCircuitBreaker(pool, symbol) {
  const lossLimit = Number(process.env.FOREX_CIRCUIT_BREAKER_LOSS_LIMIT || 2);
  const cooldownHours = Number(process.env.FOREX_CIRCUIT_BREAKER_COOLDOWN_HOURS || 2);

  try {
    const [recentTrades] = await pool.query(
      `SELECT id, is_win, exit_time, created_at, exit_reason, profit_loss
       FROM trade_results
       WHERE symbol = ? AND market_type = 'forex' AND exit_reason NOT IN ('OPEN', 'SYNC_PENDING')
         AND exit_reason NOT IN ('CLOSED_EXPIRED', 'CANCELED', 'CLOSED_CANCELED')
         AND is_win = 0
       ORDER BY id DESC LIMIT ?`,
      [symbol, lossLimit]
    );

    if (recentTrades.length >= lossLimit) {
      const allLosses = recentTrades.every(t => t.is_win === 0 && (
        t.profit_loss === null || Number(t.profit_loss) < 0
      ));
      if (allLosses) {
        const lastExit = new Date(recentTrades[0].exit_time || recentTrades[0].created_at);
        const elapsedHours = (Date.now() - lastExit.getTime()) / (1000 * 60 * 60);

        if (elapsedHours < cooldownHours) {
          const remainingMinutes = Math.round((cooldownHours - elapsedHours) * 60);
          return {
            blocked: true,
            reason: `แพ้ติดกัน ${lossLimit} ไม้ล่าสุดในรอบวัน -> ติด Cooldown พักเทรดอีก ${remainingMinutes} นาที`
          };
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ [Circuit Breaker Check Error] ${symbol}:`, err.message);
  }

  return { blocked: false };
}

/**
 * Executes a single Forex market scan cycle.
 * Evaluates the 1st-stage filter, dynamic trailing stops, and triggers BUY/SELL signals.
 */
export async function executeForexScanCycle() {
  console.log(`[*] [${new Date().toISOString()}] 💱 เริ่มรอบการสแกนตลาด Forex (คู่เงิน)...`);
  const pool = await getPool();

  // 1. Fetch market data for Forex Universe in Parallel (Concurrent MT5 fetch)
  let rawData = {};
  const rawDataSource = {};
  const tf = process.env.MT5_TIMEFRAME || 'M5';

  if (process.env.MT5_ENABLED === 'true') {
    try {
      const fetchTasks = FOREX_UNIVERSE
        .filter(sym => sym !== 'DX-Y.NYB')
        .map(async (symbol) => {
          const cleanSymbol = symbol.replace('=X', '');
          try {
            const res = await getRates(cleanSymbol, tf, 80);
            if (res && res.bars && res.bars.length > 0) {
              return { symbol, bars: res.bars, source: 'mt5' };
            }
          } catch (e) {
            console.warn(`⚠️ Parallel MT5 rate fetch failed for ${cleanSymbol}:`, e.message);
          }
          return null;
        });

      const parallelResults = await Promise.all(fetchTasks);
      for (const item of parallelResults) {
        if (item) {
          rawData[item.symbol] = item.bars;
          rawDataSource[item.symbol] = item.source;
        }
      }
    } catch (err) {
      console.warn('⚠️ Parallel MT5 rates fetch failed, fallback to Yahoo Finance:', err.message);
    }
  }

  // Fallback or DXY fetch via Yahoo Finance with explicit M5 interval
  try {
    const missing = FOREX_UNIVERSE.filter(s => !rawData[s]);
    if (missing.length > 0) {
      const yData = await fetchMarketData(missing, '5d', '5m');
      rawData = { ...rawData, ...yData };
      for (const symbol of missing) {
        if (rawData[symbol]) rawDataSource[symbol] = 'yahoo';
      }
    }
  } catch (err) {
    console.error('❌ ดึงข้อมูลตลาด Forex เพิ่มเติมล้มเหลว:', err.message);
  }

  if (!rawData || Object.keys(rawData).length === 0) {
    console.warn('⚠️ ไม่มีข้อมูลตลาด Forex ที่ได้รับในรอบนี้');
    return { success: false, message: 'No Forex data returned' };
  }

  const dxyBars = rawData['DX-Y.NYB'] || null;

  // 2. Sync with MT5 & Process existing Forex Active Positions (Dynamic Trailing Stop)
  try {
    await syncMt5PositionsWithDatabase();

    const [openPositions] = await pool.query(
      `SELECT symbol, entry_price, entry_date, highest_price, sl_price, tp_price, status_note, mt5_ticket
       FROM active_positions
       WHERE market_type = 'forex' AND status_note NOT LIKE 'CLOSED%'`
    );

    for (const pos of openPositions) {
      if (pos.status_note?.includes('PENDING')) continue;
      const bars = rawData[pos.symbol];
      if (!bars || bars.length === 0) continue;

      const lastBar = bars[bars.length - 1];
      const currPrice = Number(lastBar.close);
      const isShort = pos.status_note?.includes('SELL') || Number(pos.tp_price) < Number(pos.entry_price);

      // Estimate ATR & pip size
      const atr = Math.abs(Number(lastBar.high) - Number(lastBar.low)) || (currPrice * 0.005);
      const isJpy = pos.symbol.includes('JPY');
      const pipSize = isJpy ? 0.01 : 0.0001;
      const dec = isJpy ? 3 : 5;

      let newHighest = Number(pos.highest_price) || currPrice;
      let newSl = Number(pos.sl_price);
      const isMt5Live = Boolean(pos.mt5_ticket && process.env.MT5_ENABLED === 'true');
      const entryPrice = Number(pos.entry_price) || currPrice;

      const entryTime = pos.entry_date ? new Date(pos.entry_date).getTime() : Date.now();
      const holdMinutes = (Date.now() - entryTime) / (1000 * 60);
      const maxHoldMinutes = Number(process.env.FOREX_MAX_HOLD_MINUTES || 30);
      const minExpansionPips = Math.max(8, (1.2 * atr) / pipSize);

      const tpPrice = Number(pos.tp_price);
      const isStallEnabled = process.env.FOREX_STALL_HARVEST_ENABLED !== 'false';
      const stallTriggerPct = Number(process.env.FOREX_STALL_TRIGGER_PCT || 0.70);
      const stallMinHold = Number(process.env.FOREX_STALL_MIN_HOLD_MINUTES || 15);
      const stallPullbackPips = Math.max(1.5, (Number(process.env.FOREX_STALL_PULLBACK_ATR || 0.30) * atr) / pipSize);

      const tier1Pct = Number(process.env.FOREX_TIER1_TRIGGER_PCT || 0.40);
      const tier2Pct = Number(process.env.FOREX_TIER2_TRIGGER_PCT || 0.60);
      const tier3Pct = Number(process.env.FOREX_TIER3_TRIGGER_PCT || 0.80);

      const isScalpMode = process.env.FOREX_SCALP_MODE !== 'false';
      const microHarvestPips = isJpy
        ? Number(process.env.FOREX_MICRO_HARVEST_PIPS_JPY || 1.8)
        : Number(process.env.FOREX_MICRO_HARVEST_PIPS_MAJOR || 1.0);
      const microBeTriggerPips = Number(process.env.FOREX_MICRO_BE_TRIGGER_PIPS || 2.5);
      const stepdownMaxMinutes = Number(process.env.FOREX_STEPDOWN_MAX_MINUTES || 25);
      const stepdownMinPips = Number(process.env.FOREX_STEPDOWN_MIN_PIPS || 2.0);

      if (isShort) {
        newHighest = Math.min(newHighest, currPrice); // stores lowest reached price
        const tpDistancePips = (tpPrice && tpPrice < entryPrice) ? Math.max(1, (entryPrice - tpPrice) / pipSize) : (isScalpMode ? 2.5 : 15);
        const profitPips = (entryPrice - currPrice) / pipSize;
        const maxProfitPips = (entryPrice - newHighest) / pipSize;
        const maxProfitRatio = maxProfitPips / tpDistancePips;

        // 0. Micro-Scalp Instant Harvest: Quick profit snatch (0.5 - 1.5 pips net target)
        if (isScalpMode && profitPips >= microHarvestPips) {
          console.log(`⚡ [Forex Micro-Scalp Harvest] ${pos.symbol} (SELL) กำไรแตะ +${profitPips.toFixed(1)} pips (>= ${microHarvestPips} pips) -> ปิดรวบกำไรทันที!`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
            }
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_MICRO_SCALP' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_MICRO_SCALP'
          });
          continue;
        }

        // 0.5. Step-Down Fast Exit: If held >= stepdownMaxMinutes and in profit >= stepdownMinPips, take it!
        if (isScalpMode && holdMinutes >= stepdownMaxMinutes && profitPips >= stepdownMinPips) {
          console.log(`⏱️ [Forex Step-Down Profit] ${pos.symbol} (SELL) ถือครอง ${Math.round(holdMinutes)}m กำไร +${profitPips.toFixed(1)} pips -> ปิดล็อกกำไร ไม่รอให้สวิงกลับ`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
            }
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_STEPDOWN_PROFIT' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_STEPDOWN_PROFIT'
          });
          continue;
        }

        // 1. Momentum Stall Harvester: Reached >= 60% TP and pulled back or stalling for >= 10 min
        if (isStallEnabled && holdMinutes >= stallMinHold && maxProfitRatio >= stallTriggerPct) {
          if (profitPips <= maxProfitPips - stallPullbackPips && profitPips >= 0.30 * tpDistancePips) {
            console.log(`🎯 [Forex Stall Harvest] ${pos.symbol} (SELL) แตะ ${Math.round(maxProfitRatio * 100)}% TP (+${maxProfitPips.toFixed(1)} pips) แล้วเริ่มหมดแรงย่อตัว (+${profitPips.toFixed(1)} pips) -> ปิดทำกำไรล็อกกำไรทันที!`);
            if (isMt5Live) {
              try {
                await closePosition(pos.mt5_ticket);
              } catch (e) {
                console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
              }
            }
            await pool.query(
              "UPDATE active_positions SET status_note = 'CLOSED_STALL_HARVEST' WHERE symbol = ? AND market_type = 'forex'",
              [pos.symbol]
            );
            await recordTradeExit({
              ticket: pos.mt5_ticket,
              symbol: pos.symbol,
              exitPrice: currPrice,
              exitReason: 'CLOSED_STALL_HARVEST'
            });
            continue;
          }
        }

        // 2. Strict Time-Decay Hard Exit: Position held >= maxHoldMinutes (20-30m) -> Close immediately to prevent lingering
        if (holdMinutes >= maxHoldMinutes) {
          console.log(`⏰ [Forex Scalp Time-Stop] ${pos.symbol} (SELL) ถือครองครบ ${Math.round(holdMinutes)} นาที (>= ${maxHoldMinutes}m) -> ปิดออเดอร์ตัดรอบทันที (${profitPips > 0 ? '+' : ''}${profitPips.toFixed(1)} pips)`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
            }
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_TIME_STOP'
          });
          continue;
        }

        // 3. Rollover Window Cutoff (03:45 - 04:00 Bangkok time): Exit stagnant scalps before spread blowout
        const now = new Date();
        const bkkHour = (now.getUTCHours() + 7) % 24;
        const bkkMin = now.getUTCMinutes();
        if (bkkHour === 3 && bkkMin >= 45 && profitPips < minExpansionPips) {
          console.log(`🌙 [Forex Rollover Cutoff] ${pos.symbol} (SELL) ปิดออเดอร์ก่อนช่วงถ่าง Spread 04:00 น. (${profitPips.toFixed(1)} pips)`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {}
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_TIME_STOP'
          });
          continue;
        }

        // 4. Only trigger local virtual close if NOT running live on MT5 (MT5 broker handles live execution)
        if (!isMt5Live) {
          if (newSl && currPrice >= newSl) {
            await pool.query(
              "UPDATE active_positions SET status_note = 'CLOSED_SL' WHERE symbol = ? AND market_type = 'forex'",
              [pos.symbol]
            );
            await recordTradeExit({
              ticket: pos.mt5_ticket,
              symbol: pos.symbol,
              exitPrice: currPrice,
              exitReason: 'CLOSED_SL'
            });
            console.log(`[Forex Position] ${pos.symbol} (SELL) ชน Stop Loss ที่ราคา ${currPrice}`);
            continue;
          }
          if (tpPrice && currPrice <= tpPrice) {
            await pool.query(
              "UPDATE active_positions SET status_note = 'CLOSED_TP' WHERE symbol = ? AND market_type = 'forex'",
              [pos.symbol]
            );
            await recordTradeExit({
              ticket: pos.mt5_ticket,
              symbol: pos.symbol,
              exitPrice: currPrice,
              exitReason: 'CLOSED_TP'
            });
            console.log(`[Forex Position] ${pos.symbol} (SELL) ถึงเป้า Take Profit ที่ราคา ${currPrice}`);
            continue;
          }
        }

        // 4.5. Fast Micro Break-Even Lock (+0.2 pips)
        if (isScalpMode && profitPips >= microBeTriggerPips) {
          const beSl = Number((entryPrice - (0.2 * pipSize)).toFixed(dec));
          if (!newSl || beSl < newSl) {
            newSl = beSl;
            console.log(`🛡️ [Micro Break-Even] ${pos.symbol} (SELL) กำไร +${profitPips.toFixed(1)} pips -> ล็อกทุนที่ ${newSl.toFixed(dec)}`);
          }
        }

        // 5. Multi-Tier Profit Ratchet Protection
        // Tier 3: Profit >= 80% TP -> Lock 70% TP
        if (maxProfitRatio >= tier3Pct || profitPips >= 0.80 * tpDistancePips) {
          const targetLockPrice = Number((entryPrice - (0.70 * tpDistancePips * pipSize)).toFixed(dec));
          if (!newSl || targetLockPrice < newSl) {
            newSl = targetLockPrice;
            console.log(`🥇 [Tier 3 Profit Ratchet] ${pos.symbol} (SELL) กำไรแตะ 80% TP -> ล็อกกำไรที่ 70% TP (${newSl.toFixed(dec)})`);
          }
        }
        // Tier 2: Profit >= 60% TP -> Lock 50% TP
        else if (maxProfitRatio >= tier2Pct || profitPips >= 0.60 * tpDistancePips) {
          const targetLockPrice = Number((entryPrice - (0.50 * tpDistancePips * pipSize)).toFixed(dec));
          if (!newSl || targetLockPrice < newSl) {
            newSl = targetLockPrice;
            console.log(`🥈 [Tier 2 Profit Ratchet] ${pos.symbol} (SELL) กำไรแตะ 60% TP -> ล็อกกำไรที่ 50% TP (${newSl.toFixed(dec)})`);
          }
        }
        // Tier 1: Profit >= 40% TP -> Lock Break-Even +0.5 pips
        else if (maxProfitRatio >= tier1Pct || profitPips >= Math.max(isJpy ? 2.5 : 1.2, (Number(process.env.FOREX_BREAKEVEN_TRIGGER_ATR || 0.5) * atr) / pipSize)) {
          const beSl = Number((entryPrice - (0.5 * pipSize)).toFixed(dec));
          if (!newSl || beSl < newSl) {
            newSl = beSl;
            console.log(`🛡️ [Tier 1 Break-Even] ${pos.symbol} (SELL) กำไร +${profitPips.toFixed(1)} pips -> ขยับ Break-Even ล็อกทุนที่ ${newSl.toFixed(dec)}`);
          }
        }

        // 6. Dynamic Adaptive Trailing Stop when profit expands past 5 pips
        if (profitPips >= (isScalpMode ? 3.0 : 12)) {
          const trailBuffer = Math.max(1.5 * pipSize, 0.5 * atr);
          const calculatedSl = Number((newHighest + trailBuffer).toFixed(dec));
          if (!newSl || calculatedSl < newSl) {
            newSl = calculatedSl;
          }
        }

        // One-Way Ratchet Rule for SELL: newSl can NEVER move higher (worse) than current pos.sl_price
        if (pos.sl_price && Number(pos.sl_price) > 0) {
          newSl = Math.min(newSl, Number(pos.sl_price));
        }

        await pool.query(
          `UPDATE active_positions
           SET highest_price = ?, sl_price = ?
           WHERE symbol = ? AND market_type = 'forex'`,
          [newHighest, newSl, pos.symbol]
        );
      } else {
        // Trailing Stop, Profit Ratchet & Stall Harvester for Long (BUY)
        newHighest = Math.max(newHighest, currPrice);
        const tpDistancePips = (tpPrice && tpPrice > entryPrice) ? Math.max(1, (tpPrice - entryPrice) / pipSize) : (isScalpMode ? 2.5 : 15);
        const profitPips = (currPrice - entryPrice) / pipSize;
        const maxProfitPips = (newHighest - entryPrice) / pipSize;
        const maxProfitRatio = maxProfitPips / tpDistancePips;

        // 0. Micro-Scalp Instant Harvest: Quick profit snatch (0.5 - 1.5 pips net target)
        if (isScalpMode && profitPips >= microHarvestPips) {
          console.log(`⚡ [Forex Micro-Scalp Harvest] ${pos.symbol} (BUY) กำไรแตะ +${profitPips.toFixed(1)} pips (>= ${microHarvestPips} pips) -> ปิดรวบกำไรทันที!`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
            }
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_MICRO_SCALP' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_MICRO_SCALP'
          });
          continue;
        }

        // 0.5. Step-Down Fast Exit: If held >= stepdownMaxMinutes and in profit >= stepdownMinPips, take it!
        if (isScalpMode && holdMinutes >= stepdownMaxMinutes && profitPips >= stepdownMinPips) {
          console.log(`⏱️ [Forex Step-Down Profit] ${pos.symbol} (BUY) ถือครอง ${Math.round(holdMinutes)}m กำไร +${profitPips.toFixed(1)} pips -> ปิดล็อกกำไร ไม่รอให้สวิงกลับ`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
            }
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_STEPDOWN_PROFIT' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_STEPDOWN_PROFIT'
          });
          continue;
        }

        // 1. Momentum Stall Harvester: Reached >= 60% TP and pulled back or stalling for >= 10 min
        if (isStallEnabled && holdMinutes >= stallMinHold && maxProfitRatio >= stallTriggerPct) {
          if (profitPips <= maxProfitPips - stallPullbackPips && profitPips >= 0.30 * tpDistancePips) {
            console.log(`🎯 [Forex Stall Harvest] ${pos.symbol} (BUY) แตะ ${Math.round(maxProfitRatio * 100)}% TP (+${maxProfitPips.toFixed(1)} pips) แล้วเริ่มหมดแรงย่อตัว (+${profitPips.toFixed(1)} pips) -> ปิดทำกำไรล็อกกำไรทันที!`);
            if (isMt5Live) {
              try {
                await closePosition(pos.mt5_ticket);
              } catch (e) {
                console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
              }
            }
            await pool.query(
              "UPDATE active_positions SET status_note = 'CLOSED_STALL_HARVEST' WHERE symbol = ? AND market_type = 'forex'",
              [pos.symbol]
            );
            await recordTradeExit({
              ticket: pos.mt5_ticket,
              symbol: pos.symbol,
              exitPrice: currPrice,
              exitReason: 'CLOSED_STALL_HARVEST'
            });
            continue;
          }
        }

        // 2. Strict Time-Decay Hard Exit: Position held >= maxHoldMinutes (20-30m) -> Close immediately to prevent lingering
        if (holdMinutes >= maxHoldMinutes) {
          console.log(`⏰ [Forex Scalp Time-Stop] ${pos.symbol} (BUY) ถือครองครบ ${Math.round(holdMinutes)} นาที (>= ${maxHoldMinutes}m) -> ปิดออเดอร์ตัดรอบทันที (${profitPips > 0 ? '+' : ''}${profitPips.toFixed(1)} pips)`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${pos.mt5_ticket}:`, e.message);
            }
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_TIME_STOP'
          });
          continue;
        }

        // 3. Rollover Window Cutoff (03:45 - 04:00 Bangkok time)
        const now = new Date();
        const bkkHour = (now.getUTCHours() + 7) % 24;
        const bkkMin = now.getUTCMinutes();
        if (bkkHour === 3 && bkkMin >= 45 && profitPips < minExpansionPips) {
          console.log(`🌙 [Forex Rollover Cutoff] ${pos.symbol} (BUY) ปิดออเดอร์ก่อนช่วงถ่าง Spread 04:00 น. (${profitPips.toFixed(1)} pips)`);
          if (isMt5Live) {
            try {
              await closePosition(pos.mt5_ticket);
            } catch (e) {}
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP' WHERE symbol = ? AND market_type = 'forex'",
            [pos.symbol]
          );
          await recordTradeExit({
            ticket: pos.mt5_ticket,
            symbol: pos.symbol,
            exitPrice: currPrice,
            exitReason: 'CLOSED_TIME_STOP'
          });
          continue;
        }

        // 4. Only trigger local virtual close if NOT running live on MT5
        if (!isMt5Live) {
          if (newSl && currPrice <= newSl) {
            await pool.query(
              "UPDATE active_positions SET status_note = 'CLOSED_SL' WHERE symbol = ? AND market_type = 'forex'",
              [pos.symbol]
            );
            await recordTradeExit({
              ticket: pos.mt5_ticket,
              symbol: pos.symbol,
              exitPrice: currPrice,
              exitReason: 'CLOSED_SL'
            });
            console.log(`[Forex Position] ${pos.symbol} (BUY) ชน Stop Loss ที่ราคา ${currPrice}`);
            continue;
          }
          if (tpPrice && currPrice >= tpPrice) {
            await pool.query(
              "UPDATE active_positions SET status_note = 'CLOSED_TP' WHERE symbol = ? AND market_type = 'forex'",
              [pos.symbol]
            );
            await recordTradeExit({
              ticket: pos.mt5_ticket,
              symbol: pos.symbol,
              exitPrice: currPrice,
              exitReason: 'CLOSED_TP'
            });
            console.log(`[Forex Position] ${pos.symbol} (BUY) ถึงเป้า Take Profit ที่ราคา ${currPrice}`);
            continue;
          }
        }

        // 4.5. Fast Micro Break-Even Lock (+0.2 pips)
        if (isScalpMode && profitPips >= microBeTriggerPips) {
          const beSl = Number((entryPrice + (0.2 * pipSize)).toFixed(dec));
          if (!newSl || beSl > newSl) {
            newSl = beSl;
            console.log(`🛡️ [Micro Break-Even] ${pos.symbol} (BUY) กำไร +${profitPips.toFixed(1)} pips -> ล็อกทุนที่ ${newSl.toFixed(dec)}`);
          }
        }

        // 5. Multi-Tier Profit Ratchet Protection
        // Tier 3: Profit >= 80% TP -> Lock 70% TP
        if (maxProfitRatio >= tier3Pct || profitPips >= 0.80 * tpDistancePips) {
          const targetLockPrice = Number((entryPrice + (0.70 * tpDistancePips * pipSize)).toFixed(dec));
          if (!newSl || targetLockPrice > newSl) {
            newSl = targetLockPrice;
            console.log(`🥇 [Tier 3 Profit Ratchet] ${pos.symbol} (BUY) กำไรแตะ 80% TP -> ล็อกกำไรที่ 70% TP (${newSl.toFixed(dec)})`);
          }
        }
        // Tier 2: Profit >= 60% TP -> Lock 50% TP
        else if (maxProfitRatio >= tier2Pct || profitPips >= 0.60 * tpDistancePips) {
          const targetLockPrice = Number((entryPrice + (0.50 * tpDistancePips * pipSize)).toFixed(dec));
          if (!newSl || targetLockPrice > newSl) {
            newSl = targetLockPrice;
            console.log(`🥈 [Tier 2 Profit Ratchet] ${pos.symbol} (BUY) กำไรแตะ 60% TP -> ล็อกกำไรที่ 50% TP (${newSl.toFixed(dec)})`);
          }
        }
        // Tier 1: Profit >= 40% TP -> Lock Break-Even +0.5 pips
        else if (maxProfitRatio >= tier1Pct || profitPips >= Math.max(isJpy ? 2.5 : 1.2, (Number(process.env.FOREX_BREAKEVEN_TRIGGER_ATR || 0.5) * atr) / pipSize)) {
          const beSl = Number((entryPrice + (0.5 * pipSize)).toFixed(dec));
          if (!newSl || beSl > newSl) {
            newSl = beSl;
            console.log(`🛡️ [Tier 1 Break-Even] ${pos.symbol} (BUY) กำไร +${profitPips.toFixed(1)} pips -> ขยับ Break-Even ล็อกทุนที่ ${newSl.toFixed(dec)}`);
          }
        }

        // 6. Dynamic Adaptive Trailing Stop when profit expands past 5 pips
        if (profitPips >= (isScalpMode ? 3.0 : 12)) {
          const trailBuffer = Math.max(1.5 * pipSize, 0.5 * atr);
          const calculatedSl = Number((newHighest - trailBuffer).toFixed(dec));
          if (!newSl || calculatedSl > newSl) {
            newSl = calculatedSl;
          }
        }

        // One-Way Ratchet Rule for BUY: newSl can NEVER move lower (worse) than current pos.sl_price
        if (pos.sl_price && Number(pos.sl_price) > 0) {
          newSl = Math.max(newSl, Number(pos.sl_price));
        }

        await pool.query(
          `UPDATE active_positions
           SET highest_price = ?, sl_price = ?
           WHERE symbol = ? AND market_type = 'forex'`,
          [newHighest, newSl, pos.symbol]
        );
      }

      // Sync Trailing SL to MT5 if ticket exists
      if (pos.mt5_ticket && process.env.MT5_ENABLED === 'true') {
        try {
          await modifyStopLoss(pos.mt5_ticket, newSl, Number(pos.tp_price));
        } catch (err) {
          console.warn(`⚠️ MT5 SL Modify warning (ticket #${pos.mt5_ticket}):`, err.message);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Error updating Forex trailing stops:', err.message);
  }

  // 2.2 Evaluate Open Shadow / Paper Harvesting Positions (ML Data Generation)
  if (process.env.FOREX_SHADOW_HARVESTING === 'true') {
    try {
      const [openShadows] = await pool.query(
        `SELECT * FROM trade_results
         WHERE market_type = 'forex_shadow'
           AND exit_reason = 'OPEN'
           AND decision_mode NOT IN (?, ?)`,
        [POCKET_PROD_DECISION_MODE, POCKET_EXPLORE_DECISION_MODE]
      );
      for (const shadow of openShadows) {
        const bars = rawData[shadow.symbol];
        if (!bars || bars.length === 0) continue;
        const currBar = bars[bars.length - 1];
        const currClose = Number(currBar.close);
        const currHigh = Number(currBar.high);
        const currLow = Number(currBar.low);
        const tpPrice = Number(shadow.tp_price);
        const slPrice = Number(shadow.sl_price);
        const holdMin = Math.max(1, Math.round((new Date() - new Date(shadow.entry_time)) / (1000 * 60)));

        const isJpy = shadow.symbol.includes('JPY');
        const pipSize = isJpy ? 0.01 : 0.0001;
        const entryPrice = Number(shadow.entry_price) || currClose;
        const isScalpMode = process.env.FOREX_SCALP_MODE !== 'false';
        const microHarvestPips = isJpy
          ? Number(process.env.FOREX_MICRO_HARVEST_PIPS_JPY || 1.8)
          : Number(process.env.FOREX_MICRO_HARVEST_PIPS_MAJOR || 1.0);
        const maxHoldMinutes = Number(process.env.FOREX_MAX_HOLD_MINUTES || 45);
        const stepdownMaxMinutes = Number(process.env.FOREX_STEPDOWN_MAX_MINUTES || 25);
        const stepdownMinPips = Number(process.env.FOREX_STEPDOWN_MIN_PIPS || 2.0);
        const tpDistancePips = (tpPrice && entryPrice) ? Math.abs(tpPrice - entryPrice) / pipSize : (isScalpMode ? 2.5 : 15);
        const atr = Math.abs(currHigh - currLow) || (currClose * 0.005);
        const stallPullbackPips = Math.max(1.5, (Number(process.env.FOREX_STALL_PULLBACK_ATR || 0.20) * atr) / pipSize);
        const isStallEnabled = process.env.FOREX_STALL_HARVEST_ENABLED !== 'false';

        let exitReason = null;
        let exitPrice = currClose;

        const spreadBuffer = (isJpy ? 1.8 : 1.2) * pipSize;

        if (shadow.action === 'BUY') {
          const maxProfitPips = (currHigh - entryPrice) / pipSize;
          const currProfitPips = (currClose - entryPrice) / pipSize;
          const maxProfitRatio = maxProfitPips / tpDistancePips;

          // Conservative & Realistic: Check SL first if bar had collision, and deduct spread from TP
          if (slPrice && currLow <= slPrice) {
            exitReason = 'CLOSED_SL';
            exitPrice = slPrice;
          } else if (tpPrice && (currHigh - spreadBuffer) >= tpPrice) {
            exitReason = 'CLOSED_TP';
            exitPrice = tpPrice;
          } else if (isScalpMode && currProfitPips >= microHarvestPips) {
            exitReason = 'CLOSED_MICRO_SCALP';
            exitPrice = currClose;
          } else if (isScalpMode && holdMin >= stepdownMaxMinutes && currProfitPips >= stepdownMinPips) {
            exitReason = 'CLOSED_STEPDOWN_PROFIT';
            exitPrice = currClose;
          } else if (isStallEnabled && holdMin >= 10 && maxProfitRatio >= 0.60 && currProfitPips <= maxProfitPips - stallPullbackPips && currProfitPips >= 0.30 * tpDistancePips) {
            exitReason = 'CLOSED_STALL_HARVEST';
            exitPrice = currClose;
          } else if (holdMin >= maxHoldMinutes) {
            exitReason = 'CLOSED_TIME_STOP';
            exitPrice = currClose;
          }
        } else {
          const maxProfitPips = (entryPrice - currLow) / pipSize;
          const currProfitPips = (entryPrice - currClose) / pipSize;
          const maxProfitRatio = maxProfitPips / tpDistancePips;

          // Conservative & Realistic: Check SL first if bar had collision, and add spread to buy-to-close
          if (slPrice && (currHigh + spreadBuffer) >= slPrice) {
            exitReason = 'CLOSED_SL';
            exitPrice = slPrice;
          } else if (tpPrice && (currLow + spreadBuffer) <= tpPrice) {
            exitReason = 'CLOSED_TP';
            exitPrice = tpPrice;
          } else if (isScalpMode && currProfitPips >= microHarvestPips) {
            exitReason = 'CLOSED_MICRO_SCALP';
            exitPrice = currClose;
          } else if (isScalpMode && holdMin >= stepdownMaxMinutes && currProfitPips >= stepdownMinPips) {
            exitReason = 'CLOSED_STEPDOWN_PROFIT';
            exitPrice = currClose;
          } else if (isStallEnabled && holdMin >= 10 && maxProfitRatio >= 0.60 && currProfitPips <= maxProfitPips - stallPullbackPips && currProfitPips >= 0.30 * tpDistancePips) {
            exitReason = 'CLOSED_STALL_HARVEST';
            exitPrice = currClose;
          } else if (holdMin >= maxHoldMinutes) {
            exitReason = 'CLOSED_TIME_STOP';
            exitPrice = currClose;
          }
        }

        if (exitReason) {
          await recordTradeExit({
            ticket: null,
            symbol: shadow.symbol,
            exitPrice,
            exitReason,
            tradeResultId: shadow.id
          });
          console.log(`👻 [SHADOW PAPER EXIT] ${shadow.symbol} (${shadow.action}) ปิดสถานะจำลอง: ${exitReason} @ ${exitPrice} (ถือ ${holdMin} นาที)`);
        }
      }
    } catch (err) {
      console.warn('⚠️ Error evaluating shadow trades:', err.message);
    }
    await evaluatePocketShadowTrades({ pool, rawData });
  }

  // 3. Evaluate Currency Strength Meter (CSM) & 1st-Stage Filter
  const csmResult = calculateCurrencyStrength(rawData, 12);
  console.log(`[*] [CSM Engine] 🌐 สกุลเงินแข็งสุด: ${csmResult.strongest} | อ่อนสุด: ${csmResult.weakest}`);

  const scanResults = [];
  const cycleNewPositions = [];

  for (const symbol of FOREX_UNIVERSE) {
    if (symbol === 'DX-Y.NYB') continue;
    const bars = rawData[symbol];
    if (!bars || bars.length < 35) continue;

    const lastBar = bars[bars.length - 1];
    // Predict Market Pressure & Indecision (Microstructure Model)
    let marketPressure = null;
    try {
      marketPressure = await predictForexMarketPressure(bars, symbol);
    } catch (err) {
      console.warn(`[MarketPressure] Inference error for ${symbol}:`, err.message);
    }

    // Run 1st-Stage Indicator Filter first to obtain indicators series (with marketPressure)
    const filterResult = evaluateForexFirstStageFilter(bars, dxyBars, symbol, { marketPressure });
    let { qualified, bias, reasons, indicators, activeTrack, confluenceScore } = filterResult;
    const filterQualified = Boolean(qualified);
    const atr = indicators?.atr14 || (currPrice * 0.005);

    if (marketPressure) {
      console.log(`🧭 [MARKET PRESSURE] ${symbol.replace('=X', '')}: ${marketPressure.state} | Buy: ${(marketPressure.probabilities.buy_pressure*100).toFixed(0)}% | Sell: ${(marketPressure.probabilities.sell_pressure*100).toFixed(0)}% | Indecision: ${(marketPressure.probabilities.indecision*100).toFixed(0)}% | ExpPips: ${marketPressure.pip_projections?.expected_net_pips > 0 ? '+' : ''}${marketPressure.pip_projections?.expected_net_pips}p`);
    }

    // Save recent bars with calculated RSI and ATR to market_bars for chart & raw data display
    try {
      const recentBars = bars.slice(-60);
      const startIdx = bars.length - recentBars.length;
      const values = recentBars.map((b, i) => {
        const fullIdx = startIdx + i;
        const rsiVal = indicators?.rsiSeries && Number.isFinite(indicators.rsiSeries[fullIdx])
          ? Number(indicators.rsiSeries[fullIdx].toFixed(2))
          : null;
        const atrVal = indicators?.atrSeries && Number.isFinite(indicators.atrSeries[fullIdx])
          ? Number(indicators.atrSeries[fullIdx].toFixed(5))
          : null;
        return [
          b.time,
          symbol,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume || 0,
          rsiVal,
          atrVal,
          'forex'
        ];
      });

      await pool.query(
        `INSERT INTO market_bars (time, symbol, open, high, low, close, volume, rsi, atr, market_type)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           open=VALUES(open), high=VALUES(high), low=VALUES(low),
           close=VALUES(close), volume=VALUES(volume),
           rsi=VALUES(rsi), atr=VALUES(atr),
           market_type='forex',
           last_scanned_at=CURRENT_TIMESTAMP`,
        [values]
      );
    } catch (err) {
      console.warn(`⚠️ Error saving Forex bars for ${symbol}:`, err.message);
    }

    // Calculate CSM spread & regime features early
    const isJpy = symbol.includes('JPY');
    const pipSize = isJpy ? 0.01 : 0.0001;
    const dec = isJpy ? 3 : 5;
    const csmSpread = getPairCsmSpread(symbol, csmResult?.scores);

    // Compute AI confidence using the configured primary Forex model role.
    let confidence = 0.20;
    let mlMeta = null;
    let championMlMeta = null;
    let challengerMlMeta = null;
    let challengerEvalMlMeta = null;
    let shadowMlMeta = null;
    let primaryModelError = false;
    let forexFeatures = null;
    let h1TrendSlope = 0;
    let rangeSetup = null;
    let rangeMlMeta = null;
    let rangeConfidence = 0;

    if (RANGE_MODEL_ENABLED) {
      rangeSetup = evaluateRangeExpertSetup(bars, indicators, symbol);
      if (rangeSetup.action && rangeSetup.features) {
        try {
          rangeMlMeta = await predictForexRangeConfidence(rangeSetup.features);
          rangeConfidence = Number(Math.min(0.95, Math.max(0.05, Number(rangeMlMeta?.confidence || 0))).toFixed(4));
        } catch (rangeErr) {
          console.warn(`⚠️ Range prediction skipped for ${symbol}:`, rangeErr.message);
        }
      }
    }

    // Build the complete entry-time feature snapshot for every sufficiently
    // long bar series, including filtered/no-trade observations.  This keeps
    // future training free from outcome-derived feature reconstruction.
    try {
      forexFeatures = buildForexFeatures({
        bars,
        indicators,
        symbol,
        csmSpread,
        // Keep inference timing compatible with the existing live path.
        at: new Date()
      });
      h1TrendSlope = Number(forexFeatures.h1_trend_slope || 0) / 100;

      if (qualified && activeTrack !== 'RANGE_MEAN_REVERSION') {
        const mlRes = await predictPrimaryForex({ ...forexFeatures, direction: bias || 'BUY' });
        mlMeta = mlRes;
        if (PRIMARY_MODEL_ROLE === 'challenger') challengerMlMeta = mlRes;
        else championMlMeta = mlRes;
        confidence = mlRes?.confidence || 0.50;

        if (process.env.FOREX_SHADOW_HARVESTING === 'true') {
          try {
            shadowMlMeta = await predictShadowForex({ ...forexFeatures, direction: bias || 'BUY' });
            if (SHADOW_MODEL_ROLE === 'challenger') challengerMlMeta = shadowMlMeta;
            else championMlMeta = shadowMlMeta;
          } catch (shadowErr) {
            console.warn(`⚠️ ${SHADOW_MODEL_ROLE} shadow prediction skipped for ${symbol}:`, shadowErr.message);
          }
        }

        if (POCKET_EVAL_ENABLED) {
          if (PRIMARY_MODEL_ROLE === 'challenger') {
            challengerEvalMlMeta = mlRes;
          } else if (SHADOW_MODEL_ROLE === 'challenger' && shadowMlMeta) {
            challengerEvalMlMeta = shadowMlMeta;
          } else {
            try {
              challengerEvalMlMeta = await predictForexChallengerConfidence({ ...forexFeatures, direction: bias || 'BUY' });
            } catch (challengerEvalErr) {
              console.warn(`⚠️ Challenger Pocket evaluation skipped for ${symbol}:`, challengerEvalErr.message);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Error building Forex ML features for ${symbol}:`, err.message);
      primaryModelError = true;
      confidence = 0;
    }

    const rangeIsSignal = Boolean(
      rangeSetup?.action
      && rangeConfidence >= RANGE_THRESHOLD
      && rangeSetup.score >= Number(process.env.FOREX_RANGE_MIN_SCORE || 60)
    );

    // Range expert is a separate mean-reversion path. It can qualify a
    // sideway setup without replacing an already-qualified trend setup.
    if (RANGE_LIVE_ENABLED && !qualified && rangeIsSignal) {
      qualified = true;
      bias = rangeSetup.action;
      activeTrack = 'RANGE_MEAN_REVERSION';
      confluenceScore = rangeSetup.score;
      confidence = rangeConfidence;
      reasons.push(`📊 [RANGE_MEAN_REVERSION] ${rangeSetup.reason} | Model ${(rangeConfidence * 100).toFixed(1)}%`);
      console.log(`📊 [RANGE LIVE QUALIFIED] ${symbol.replace('=X', '')} ${bias} @ ${currPrice.toFixed(dec)} | ${(rangeConfidence * 100).toFixed(1)}%`);
    }

    confidence = Number(Math.min(0.95, Math.max(0.05, confidence)).toFixed(4));
    const dynamicExitEnabled = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.FOREX_DYNAMIC_EXIT_ENABLED || 'false').toLowerCase()
    );
    const signalConfidenceThreshold = DATA_HARVEST_LIVE_MODE
      ? DATA_HARVEST_CONFIDENCE_THRESHOLD
      : (dynamicExitEnabled ? Number(process.env.FOREX_DYNAMIC_CONFIDENCE_THRESHOLD || CONFIDENCE_THRESHOLD) : CONFIDENCE_THRESHOLD);
    const primaryDirectionalScore = getDirectionalModelScore(mlMeta, bias);
    const primaryUsesRawDirectionalScore = process.env.FOREX_USE_RAW_SCORE === 'true';
    const primaryEntryScore = primaryUsesRawDirectionalScore
      ? primaryDirectionalScore
      : confidence;
    const primaryEntryThreshold = primaryUsesRawDirectionalScore
      ? getRawDirectionalThreshold(bias)
      : signalConfidenceThreshold;
    let isSignal = !primaryModelError
      && qualified
      && (primaryEntryScore >= primaryEntryThreshold)
      && (bias === 'BUY' || bias === 'SELL');
    const liveProductionConfidenceThreshold = bias === 'BUY'
      ? POCKET_EVAL_PROD_BUY_THRESHOLD
      : POCKET_EVAL_PROD_SELL_THRESHOLD;
    const liveProductionScore = primaryDirectionalScore;
    const liveRawScoreGuardEnabled = LIVE_PRODUCTION_GUARD && primaryUsesRawDirectionalScore;
    if (liveRawScoreGuardEnabled && isSignal && liveProductionScore < liveProductionConfidenceThreshold) {
      isSignal = false;
      reasons.push(`Production score ${liveProductionScore.toFixed(4)} < ${liveProductionConfidenceThreshold.toFixed(4)}`);
    }

    // Phase 1: Dynamic Symbol Gating & Regime Filtering
    const gatingEnabled = process.env.FOREX_GATING_ENABLED !== 'false';
    let gatingPassed = true;
    let gatingReason = '';

    if (gatingEnabled && activeTrack !== 'RANGE_MEAN_REVERSION' && qualified && (bias === 'BUY' || bias === 'SELL')) {
      const minAdx = isJpy
        ? Number(process.env.FOREX_GATING_MIN_ADX_JPY || 24)
        : Number(process.env.FOREX_GATING_MIN_ADX_MAJOR || 20);
      const configuredMinCsm = isJpy
        ? Number(process.env.FOREX_GATING_MIN_CSM_JPY || 1.2)
        : Number(process.env.FOREX_GATING_MIN_CSM_MAJOR || 0.8);

      const currentAdx = Number(indicators?.adx14 || 0);
      const absCsm = Math.abs(csmSpread || 0);

      // Multi-Track Squeeze Breakout bypass:
      // When Bollinger Bands expand with MACD acceleration, ADX is naturally lagging (< 20).
      // If Track 2 (SQUEEZE_BREAKOUT) or Track 3 (PULLBACK_DIP) fired with strong confluence (>= 60),
      // do NOT block the early-stage breakout by ADX!
      const isConfluenceBypass = (activeTrack === 'SQUEEZE_BREAKOUT' || activeTrack === 'PULLBACK_DIP') && (confluenceScore >= 60);

      // Market Pressure Bypass & Counter-Pressure Veto Shield
      const pBuy = Number(marketPressure?.probabilities?.buy_pressure || 0);
      const pSell = Number(marketPressure?.probabilities?.sell_pressure || 0);
      const isPressureBypass = (bias === 'BUY' && (pBuy >= 0.40 || marketPressure?.state === 'BUY_PRESSURE'))
        || (bias === 'SELL' && (pSell >= 0.40 || marketPressure?.state === 'SELL_PRESSURE'));
      const isCounterPressure = (bias === 'BUY' && pSell >= 0.40)
        || (bias === 'SELL' && pBuy >= 0.40);

      if (isCounterPressure && isSignal) {
        isSignal = false;
        const oppProb = bias === 'BUY' ? pSell : pBuy;
        reasons.push(`🚫 Counter-Pressure Veto: Market Pressure detected opposite push (${(oppProb * 100).toFixed(0)}%)`);
        console.log(`🛡️ [COUNTER-PRESSURE VETO] ${symbol.replace('=X', '')}: Opposite push ${(oppProb * 100).toFixed(0)}% -> Veto trade`);
      }

      if (isPressureBypass && !isConfluenceBypass && gatingPassed) {
        reasons.push(`⚡ Pressure Bypass: Market Pressure confirms directional momentum (${bias === 'BUY' ? (pBuy * 100).toFixed(0) : (pSell * 100).toFixed(0)}%) -> Bypassing ADX/CSM lag`);
        console.log(`⚡ [PRESSURE BYPASS] ${symbol.replace('=X', '')}: Momentum confirms ${bias} (${bias === 'BUY' ? (pBuy * 100).toFixed(0) : (pSell * 100).toFixed(0)}%) -> Bypassing ADX/CSM lag`);
      }

      // Relax CSM requirement for high confidence AI predictions (edge >= 70%) or Confluence/Pressure Bypass
      const minCsm = (confidence >= 0.70 || isConfluenceBypass || isPressureBypass) ? 0.0 : configuredMinCsm;

      if (currentAdx < minAdx && !isConfluenceBypass && !isPressureBypass) {
        gatingPassed = false;
        gatingReason = `ADX ${currentAdx.toFixed(1)} < ${minAdx} (ตลาด Sideway ไร้เทรนด์)`;
      } else if (absCsm < minCsm && !isConfluenceBypass && !isPressureBypass) {
        gatingPassed = false;
        gatingReason = `|CSM Spread| ${absCsm.toFixed(1)} < ${minCsm} (ความแข็งแกร่งคู่เงินไม่ต่างกัน)`;
      }

      if (!gatingPassed) {
        isSignal = false;
        reasons.push(`🚫 Dynamic Gating: ${gatingReason}`);
        console.log(`🛡️ [GATING FILTER] ${symbol.replace('=X', '')}: ${gatingReason}`);
      }
    }

    // 2.5 Rejection Candlestick Filter (Veto if long rejection wick >= threshold at S/R)
    const rejectionFilterEnabled = process.env.FOREX_REJECTION_FILTER_ENABLED === 'true'
      || (!DATA_HARVEST_LIVE_MODE && process.env.FOREX_REJECTION_FILTER_ENABLED !== 'false');
    if (rejectionFilterEnabled && qualified && isSignal) {
      const rejectionCheck = checkRejectionCandle(bars, bias, atr);
      if (rejectionCheck.hasRejection && !isPressureBypass) {
        isSignal = false;
        reasons.push(`🚫 Rejection Veto: ${rejectionCheck.reason}`);
        console.log(`🛡️ [REJECTION VETO (LIVE)] ${symbol.replace('=X', '')}: ${rejectionCheck.reason}`);
      }
    }

    const pocketProductionGuard = evaluatePocketProductionGuard({
      bars,
      symbol,
      qualified,
      bias,
      activeTrack,
      confluenceScore,
      indicators,
      csmSpread,
      atr,
      isJpy,
      isPressureBypass,
      isCounterPressure
    });
    if (LIVE_PRODUCTION_GUARD && isSignal && !pocketProductionGuard.passed) {
      isSignal = false;
      reasons.push(`Production guard: ${pocketProductionGuard.reasons.join('; ')}`);
      console.log(`🛡️ [PRODUCTION GUARD] ${symbol.replace('=X', '')}: ${pocketProductionGuard.reasons.join('; ')}`);
    }

    // 2.6 Dual-Mode Entry Resolution: Compression Pattern Breakout vs Overextended Pullback Guard
    let entryMode = 'DEFAULT'; // 'DEFAULT' | 'BREAKOUT' | 'PULLBACK'
    let entryPrice = currPrice;
    let slAnchorPrice = null;

    if (qualified && isSignal) {
      const compressionCheck = checkCompressionBreakout(bars, bias, atr);
      const overextCheck = checkOverextension(bars, indicators, bias);

      if (compressionCheck.isCompressionBreakout) {
        entryMode = 'BREAKOUT';
        slAnchorPrice = compressionCheck.slAnchorPrice;
        reasons.push(`⚡ Pattern Breakout: ${compressionCheck.reason}`);
        console.log(`⚡ [PATTERN BREAKOUT] ${symbol.replace('=X', '')}: ${compressionCheck.reason}`);
      } else if (overextCheck.isOverextended) {
        entryMode = 'PULLBACK';
        const pullback = calculatePullbackLevel(indicators, bias, currPrice, pipSize);
        entryPrice = Number(pullback.pullbackPrice.toFixed(dec));
        reasons.push(`🔄 Pullback Mode: ${overextCheck.reason} -> ดักตั้งรับ Limit Order ที่ ${entryPrice.toFixed(dec)}`);
        console.log(`🔄 [OVEREXTENDED GUARD] ${symbol.replace('=X', '')}: ${overextCheck.reason} -> ปรับเป็นโหมด PULLBACK LIMIT ที่ ${entryPrice.toFixed(dec)}`);
      }

      // 2.6.1 Smart Adaptive HTF Pullback Mode:
      // If signal is Counter to H1 Trend, do NOT ban the trade (prevent scared bot),
      // but convert from Market Order to Limit Pullback Order at EMA9/EMA21 support!
      const isCounterH1 = (bias === 'BUY' && h1TrendSlope < -0.0004) || (bias === 'SELL' && h1TrendSlope > 0.0004);
      if (isCounterH1 && entryMode === 'DEFAULT') {
        entryMode = 'PULLBACK';
        const pullback = calculatePullbackLevel(indicators, bias, currPrice, pipSize);
        entryPrice = Number(pullback.pullbackPrice.toFixed(dec));
        reasons.push(`🎯 Smart HTF Pullback: สัญญาณ ${bias} สวนทาง H1 Trend (Slope ${(h1TrendSlope * 1000).toFixed(1)}) -> เปลี่ยนเป็น ${bias === 'BUY' ? 'BUY_LIMIT' : 'SELL_LIMIT'} ดักรอรับราคาที่ย่อตัว @ ${entryPrice.toFixed(dec)} (ไม่เข้า Market ปลายไส้)`);
        console.log(`🎯 [SMART HTF PULLBACK] ${symbol.replace('=X', '')}: สัญญาณสวนเทรนด์ H1 (Slope ${(h1TrendSlope * 1000).toFixed(1)}) -> ปรับเป็นคำสั่ง PULLBACK LIMIT ดักรอราคา @ ${entryPrice.toFixed(dec)}`);
      }
    }

    // Calculate Scalp TP / SL. Dynamic mode is intentionally opt-in until its
    // walk-forward results are stable on more than one market regime.
    const isScalpMode = process.env.FOREX_SCALP_MODE !== 'false';
    const configuredMinSlPips = isJpy
      ? Number(process.env.FOREX_DYNAMIC_MIN_SL_JPY || (isScalpMode ? 6 : 14))
      : Number(process.env.FOREX_DYNAMIC_MIN_SL_MAJOR || (isScalpMode ? 4 : 6));
    const configuredMinTpPips = isJpy
      ? Number(process.env.FOREX_DYNAMIC_MIN_TP_JPY || (isScalpMode ? 3.5 : 10))
      : Number(process.env.FOREX_DYNAMIC_MIN_TP_MAJOR || (isScalpMode ? 2.0 : 6));
    const costBufferPips = isJpy
      ? FOREX_COST_BUFFER_PIPS_JPY
      : FOREX_COST_BUFFER_PIPS_MAJOR;
    const costAwareMinTpPips = configuredMinTpPips
      + costBufferPips
      + FOREX_MIN_NET_TARGET_PIPS;
    const minSlPips = dynamicExitEnabled ? configuredMinSlPips : (isScalpMode ? (isJpy ? 6 : 4) : (isJpy ? 24 : 14));
    const minTpPips = Math.max(
      dynamicExitEnabled
        ? configuredMinTpPips
        : (isScalpMode ? (isJpy ? 3.5 : 2.0) : (isJpy ? 38 : 22)),
      costAwareMinTpPips
    );
    const rangeMinSlPips = isJpy
      ? Number(process.env.FOREX_RANGE_MIN_SL_JPY || (isScalpMode ? 5 : 12))
      : Number(process.env.FOREX_RANGE_MIN_SL_MAJOR || (isScalpMode ? 3.5 : 6));
    const configuredRangeMinTpPips = isJpy
      ? Number(process.env.FOREX_RANGE_MIN_TP_JPY || (isScalpMode ? 3.0 : 16))
      : Number(process.env.FOREX_RANGE_MIN_TP_MAJOR || (isScalpMode ? 2.0 : 8));
    const rangeMinTpPips = Math.max(configuredRangeMinTpPips, costAwareMinTpPips);
    const tpMultiplier = Math.min(
      1,
      Math.max(0.1, Number(process.env.FOREX_TP_MULTIPLIER || 0.5))
    );

    let tpPips;
    let slPips;
    let dynamicExit = null;
    if (dynamicExitEnabled && qualified && (bias === 'BUY' || bias === 'SELL')) {
      dynamicExit = calculateDynamicForexExit({
        symbol,
        action: bias,
        entryPrice,
        atrPrice: atr,
        bars,
        options: {
          lookbackBars: Number(process.env.FOREX_EXIT_LOOKBACK_BARS || 24),
          pivotStrength: Number(process.env.FOREX_EXIT_PIVOT_STRENGTH || 2),
          tpAtrMult: Number(process.env.FOREX_DYNAMIC_TP_ATR_MULT || (marketPressure?.pip_projections?.recommended_tp_atr_mult || (isScalpMode ? 0.6 : 0.9))),
          slAtrMult: Number(process.env.FOREX_DYNAMIC_SL_ATR_MULT || (marketPressure?.pip_projections?.recommended_sl_atr_mult || 0.8)),
          marketPressure,
          bufferAtrFraction: Number(process.env.FOREX_DYNAMIC_BUFFER_ATR_FRACTION || 0.1),
          minBufferPips: Number(process.env.FOREX_DYNAMIC_MIN_BUFFER_PIPS || (isScalpMode ? 0.5 : 1)),
          minTpPips,
          minSlPips,
          tpMultiplier,
          minBrokerDistancePips: Number(process.env.FOREX_DYNAMIC_MIN_BROKER_DISTANCE_PIPS || 0),
          minRiskReward: Number(process.env.FOREX_DYNAMIC_MIN_RR || (isScalpMode ? 0.5 : 1.15)),
          entryMode,
          slAnchorPrice
        }
      });

      tpPips = dynamicExit.tpPips;
      slPips = dynamicExit.slPips;
      if (!dynamicExit.tradable) {
        if (!DATA_HARVEST_LIVE_MODE) {
          isSignal = false;
        } else {
          // Data Harvesting Fallback: enforce standard calibrated SL/TP geometry with safe spread buffer
          tpPips = minTpPips;
          slPips = minSlPips;
        }
        reasons.push(`🚫 Dynamic Exit: ${dynamicExit.reason}`);
      }
      console.log(
        `[Forex Exit] Dynamic ${symbol} (${entryMode}): TP ${tpPips.toFixed(1)} pips / SL ${slPips.toFixed(1)} pips` +
        ` | R:R 1:${dynamicExit.rr.toFixed(2)} | support ${dynamicExit.support ?? '-'} | resistance ${dynamicExit.resistance ?? '-'} | ${dynamicExit.tradable ? 'PASS' : 'SKIP'}`
      );
    } else {
      if (isScalpMode) {
        // Forex Ultra-Short Micro-Scalping: target fast 0.5 - 1.5 pips net
        const baseTpPips = Math.max(minTpPips, (0.75 * atr) / pipSize);
        tpPips = Number((baseTpPips * tpMultiplier).toFixed(1));
        if (tpPips < minTpPips) tpPips = minTpPips;
        slPips = Math.max(minSlPips, Number(((1.2 * atr) / pipSize).toFixed(1)));
      } else {
        // Fallback standard majors 22/14 pips, JPY 38/24 pips
        const baseTpPips = Math.max(minTpPips, (3.3 * atr) / pipSize);
        tpPips = baseTpPips * tpMultiplier;
        slPips = Math.max(minSlPips, (2.2 * atr) / pipSize);
      }

      // Range trades target a return toward the range midpoint
      if (activeTrack === 'RANGE_MEAN_REVERSION') {
        tpPips = Math.max(rangeMinTpPips, Number(((0.5 * atr) / pipSize).toFixed(1)));
        slPips = Math.max(rangeMinSlPips, Number(((0.6 * atr) / pipSize).toFixed(1)));
      }
    }

    const tpDist = tpPips * pipSize;
    const slDist = slPips * pipSize;

    let tpPrice, slPrice;
    if (bias === 'SELL') {
      tpPrice = Number((entryPrice - tpDist).toFixed(dec));
      slPrice = Number((entryPrice + slDist).toFixed(dec));
    } else {
      tpPrice = Number((entryPrice + tpDist).toFixed(dec));
      slPrice = Number((entryPrice - slDist).toFixed(dec));
    }

    const cleanName = symbol.replace('=X', '');
    const exitValidation = ['BUY', 'SELL'].includes(bias)
      ? validateForexExitGeometry({ action: bias, entryPrice, slPrice, tpPrice })
      : { valid: true, reason: null };
    const exitLevelsValid = exitValidation.valid;
    const exitValidationReason = exitLevelsValid
      ? null
      : `🚫 Invalid Forex exit geometry: ${exitValidation.reason}`;
    if (!exitLevelsValid) {
      isSignal = false;
      reasons.push(exitValidationReason);
      console.error(`❌ [EXIT GEOMETRY GUARD] ${cleanName}: ${exitValidation.reason} -> skip live/shadow entry`);
    }

    if (POCKET_EVAL_ENABLED && challengerEvalMlMeta && activeTrack !== 'RANGE_MEAN_REVERSION') {
      const challengerEvalConfidence = Number(
        Math.min(0.95, Math.max(0.05, Number(challengerEvalMlMeta.confidence || 0)))
      );
      const challengerEvalScore = getDirectionalModelScore(challengerEvalMlMeta, bias);
      const productionThreshold = bias === 'BUY'
        ? POCKET_EVAL_PROD_BUY_THRESHOLD
        : POCKET_EVAL_PROD_SELL_THRESHOLD;
      const productionEligible = exitLevelsValid
        && qualified
        && (bias === 'BUY' || bias === 'SELL')
        && pocketProductionGuard.passed
        && challengerEvalScore >= productionThreshold;
      const exploratoryEligible = exitLevelsValid
        && (qualified || filterQualified)
        && (bias === 'BUY' || bias === 'SELL')
        && Number(confluenceScore || 0) >= POCKET_EVAL_EXPLORE_MIN_CONFLUENCE
        && challengerEvalScore >= POCKET_EVAL_EXPLORE_THRESHOLD;

      try {
        if (productionEligible) {
          await recordPocketEvaluationSignal({
            pool,
            symbol,
            barTime: lastBar.time,
            bias,
            entryPrice,
            slPrice,
            tpPrice,
            confidence: challengerEvalConfidence,
            directionalScore: challengerEvalScore,
            modelMeta: challengerEvalMlMeta,
            decisionMode: POCKET_PROD_DECISION_MODE,
            confluenceScore,
            guardResult: pocketProductionGuard
          });
        }
        if (exploratoryEligible) {
          await recordPocketEvaluationSignal({
            pool,
            symbol,
            barTime: lastBar.time,
            bias,
            entryPrice,
            slPrice,
            tpPrice,
            confidence: challengerEvalConfidence,
            directionalScore: challengerEvalScore,
            modelMeta: challengerEvalMlMeta,
            decisionMode: POCKET_EXPLORE_DECISION_MODE,
            confluenceScore,
            guardResult: { reasons: ['exploratory lane: relaxed production guard'] }
          });
        }
      } catch (pocketRecordErr) {
        console.warn(`⚠️ Pocket evaluation record skipped for ${symbol}:`, pocketRecordErr.message);
      }
    }

    // Record both accepted and rejected/no-trade observations in the isolated
    // learning table.  This never updates trade_results or historical CSVs.
    if (forexFeatures) {
      const sampleKind = activeTrack === 'RANGE_MEAN_REVERSION'
        ? 'RANGE_EXCLUDED'
        : isSignal
          ? 'SIGNAL'
          : filterQualified
            ? 'REJECTED'
            : 'NO_TRADE';
      await recordForexMlObservation({
        pool,
        symbol,
        barTime: lastBar.time,
        dataSource: rawDataSource[symbol] || 'unknown',
        features: forexFeatures,
        sampleKind,
        candidateAction: bias,
        activeTrack: activeTrack || 'NONE',
        qualified: filterQualified,
        modelSignal: isSignal,
        confluenceScore,
        championConfidence: championMlMeta?.confidence ?? null,
        challengerConfidence: challengerMlMeta?.confidence ?? null,
        entryPrice,
        slPrice,
        tpPrice,
        reasons
      });
    }

    const pairId = createHash('sha256')
      .update(`${symbol}|${String(lastBar.time || '')}|${bias}`)
      .digest('hex')
      .slice(0, 32);

    // Evaluate the configured shadow model independently. Shadow predictions
    // are recorded for comparison only and never call MT5.
    const shadowConfidence = shadowMlMeta?.confidence !== undefined && shadowMlMeta?.confidence !== null
      ? Number(Math.min(0.95, Math.max(0.05, Number(shadowMlMeta.confidence))).toFixed(4))
      : null;
    const shadowDirectionalScore = getDirectionalModelScore(shadowMlMeta, bias);
    const shadowUsesRawDirectionalScore = process.env.FOREX_USE_RAW_SCORE === 'true';
    const shadowEntryScore = shadowUsesRawDirectionalScore
      ? shadowDirectionalScore
      : shadowConfidence;
    const shadowThresholdMult = Number(process.env.FOREX_SHADOW_THRESHOLD_MULT || 0.65);
    const shadowMinConfluence = Number(process.env.FOREX_SHADOW_MIN_CONFLUENCE || 35);
    const shadowEntryThreshold = shadowUsesRawDirectionalScore
      ? Number((getRawDirectionalThreshold(bias) * shadowThresholdMult).toFixed(4))
      : Number((signalConfidenceThreshold * shadowThresholdMult).toFixed(4));
    const shadowIsSignal = process.env.FOREX_SHADOW_HARVESTING === 'true'
      && (qualified || filterQualified)
      && (bias === 'BUY' || bias === 'SELL')
      && confluenceScore >= shadowMinConfluence
      && shadowEntryScore !== null
      && shadowEntryScore >= shadowEntryThreshold
      && exitLevelsValid;
    const challengerConfidence = challengerMlMeta?.confidence !== undefined && challengerMlMeta?.confidence !== null
      ? Number(Math.min(0.95, Math.max(0.05, Number(challengerMlMeta.confidence))).toFixed(4))
      : null;
    const challengerDirectionalScore = getDirectionalModelScore(challengerMlMeta, bias);
    const challengerIsSignal = CHALLENGER_ENABLED
      && process.env.FOREX_SHADOW_HARVESTING === 'true'
      && (qualified || filterQualified)
      && (bias === 'BUY' || bias === 'SELL')
      && confluenceScore >= shadowMinConfluence
      && challengerConfidence !== null
      && challengerDirectionalScore >= Number((getRawDirectionalThreshold(bias) * shadowThresholdMult).toFixed(4))
      && exitLevelsValid;
    if (shadowIsSignal) {
      try {
        const [existingChallenger] = await pool.query(
          `SELECT id FROM trade_results
           WHERE symbol = ? AND market_type = 'forex_shadow'
             AND model_source = ? AND exit_reason = 'OPEN'
           LIMIT 1`,
          [symbol, SHADOW_MODEL_SOURCE]
        );
        if (existingChallenger.length === 0) {
          await recordTradeEntry({
            ticket: null,
            symbol,
            marketType: 'forex_shadow',
            pairId,
            action: bias,
            lotSize: 0.01,
            entryPrice,
            confidence: shadowConfidence,
            sl: slPrice,
            tp: tpPrice,
            indicators,
            reasons: [`[${SHADOW_MODEL_ROLE.toUpperCase()}_SHADOW] จำลองสัญญาณจากโมเดล ${SHADOW_MODEL_VERSION}`, ...reasons],
            modelSource: SHADOW_MODEL_SOURCE,
            modelVersion: shadowMlMeta?.model_version || SHADOW_MODEL_VERSION,
            strategyVersion: STRATEGY_VERSION,
            configHash: MODEL_CONFIG_HASH,
            decisionMode: `${SHADOW_MODEL_ROLE.toUpperCase()}_SHADOW`,
            predictionMeta: {
              primary: mlMeta,
              shadow: shadowMlMeta,
              champion: championMlMeta,
              challenger: challengerMlMeta,
              threshold: shadowEntryThreshold,
              score_used: shadowEntryScore,
              score_type: shadowUsesRawDirectionalScore ? 'raw_directional_probability' : 'relative_confidence',
              confluenceScore,
              market_pressure: marketPressure
            }
          });
          console.log(`🧪 [${SHADOW_MODEL_ROLE.toUpperCase()} SHADOW] ${cleanName} ${bias} @ ${entryPrice.toFixed(dec)} | ${(shadowConfidence * 100).toFixed(1)}% | ${SHADOW_MODEL_VERSION}`);
        }
      } catch (err) {
        console.warn(`⚠️ Error logging ${SHADOW_MODEL_ROLE} shadow trade for ${symbol}:`, err.message);
      }
    }

    // Record qualifying range setups separately when they are not already a
    // live Demo order, so their realized performance can be measured.
    if (RANGE_MODEL_ENABLED && !isSignal && rangeIsSignal && exitLevelsValid) {
      try {
        const rangePairId = createHash('sha256')
          .update(`${symbol}|${String(lastBar.time || '')}|${rangeSetup.action}|RANGE`)
          .digest('hex').slice(0, 32);
        const [existingRange] = await pool.query(
          `SELECT id FROM trade_results
           WHERE symbol = ? AND market_type = 'forex_shadow'
             AND model_source = ? AND exit_reason = 'OPEN'
           LIMIT 1`,
          [symbol, RANGE_MODEL_SOURCE]
        );
        if (existingRange.length === 0) {
          // Range shadow uses its own action. The normal trend-path prices are
          // based on `bias`, which can be neutral or opposite when the Range
          // expert is only harvesting shadow data.
          const rangeAction = String(rangeSetup.action || '').toUpperCase();
          const rangeTpPipsForShadow = Math.max(
            rangeMinTpPips,
            Number(((0.5 * atr) / pipSize).toFixed(1))
          );
          const rangeSlPipsForShadow = Math.max(
            rangeMinSlPips,
            Number(((0.6 * atr) / pipSize).toFixed(1))
          );
          const rangeTpDistance = rangeTpPipsForShadow * pipSize;
          const rangeSlDistance = rangeSlPipsForShadow * pipSize;
          const rangeTpPrice = rangeAction === 'SELL'
            ? Number((currPrice - rangeTpDistance).toFixed(dec))
            : Number((currPrice + rangeTpDistance).toFixed(dec));
          const rangeSlPrice = rangeAction === 'SELL'
            ? Number((currPrice + rangeSlDistance).toFixed(dec))
            : Number((currPrice - rangeSlDistance).toFixed(dec));
          const rangeExitValidation = validateForexExitGeometry({
            action: rangeAction,
            entryPrice: currPrice,
            slPrice: rangeSlPrice,
            tpPrice: rangeTpPrice
          });
          if (!rangeExitValidation.valid) {
            console.warn(`⚠️ [RANGE SHADOW] ${cleanName}: invalid exit geometry after normalization -> skip`);
            continue;
          }
          await recordTradeEntry({
            ticket: null,
            symbol,
            marketType: 'forex_shadow',
            pairId: rangePairId,
            action: rangeSetup.action,
            lotSize: 0.01,
            entryPrice: currPrice,
            confidence: rangeConfidence,
            sl: rangeSlPrice,
            tp: rangeTpPrice,
            indicators,
            reasons: ['[RANGE_MODEL] Mean-reversion expert', rangeSetup.reason, ...reasons],
            modelSource: RANGE_MODEL_SOURCE,
            modelVersion: rangeMlMeta?.model_version || RANGE_MODEL_VERSION,
            strategyVersion: STRATEGY_VERSION,
            configHash: MODEL_CONFIG_HASH,
            decisionMode: 'RANGE_SHADOW',
            predictionMeta: { range: rangeMlMeta, rangeScore: rangeSetup.score, threshold: RANGE_THRESHOLD }
          });
          console.log(`📊 [RANGE SHADOW] ${cleanName} ${rangeSetup.action} @ ${currPrice.toFixed(dec)} | ${(rangeConfidence * 100).toFixed(1)}%`);
        }
      } catch (rangeLogErr) {
        console.warn(`⚠️ Error logging Range model result for ${symbol}:`, rangeLogErr.message);
      }
    }

    const logTag = !qualified
      ? '⚪ [CHOP / FILTERED]'
      : isSignal
        ? (bias === 'BUY' ? '🟢 [BUY LIVE_READY]' : '🔴 [SELL LIVE_READY]')
        : (bias === 'BUY' ? '🟡 [BUY SHADOW_ONLY]' : '🟠 [SELL SHADOW_ONLY]');
    console.log(`${logTag} ${cleanName.padEnd(7)} @ ${currPrice.toFixed(dec)} | มั่นใจ: ${(confidence * 100).toFixed(1)}% | Track: ${(activeTrack || 'DEFAULT').padEnd(16)} (Score: ${confluenceScore || 0}/100) | Mode: ${entryMode} | ADX: ${indicators?.adx14?.toFixed(1) || '-'} | RSI: ${indicators?.rsi14?.toFixed(1) || '-'}`);

    // Make the primary-vs-shadow decision explicit in the runtime log. The
    // legacy SHADOW_ONLY tag means isSignal=false; it does not mean the
    // configured primary model itself is running in shadow mode.
    const formatModelScore = value => Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '-';
    const decisionReasons = [];
    if (primaryModelError) decisionReasons.push('primary_model_error');
    if (!qualified) decisionReasons.push('setup_not_qualified');
    if (!['BUY', 'SELL'].includes(String(bias || '').toUpperCase())) decisionReasons.push('no_valid_direction');
    if (primaryEntryScore < primaryEntryThreshold) {
      const scoreLabel = primaryUsesRawDirectionalScore ? `raw_${String(bias || '').toLowerCase()}` : 'confidence';
      decisionReasons.push(`${scoreLabel} ${primaryEntryScore.toFixed(4)} < ${primaryEntryThreshold.toFixed(4)}`);
    }
    if (liveRawScoreGuardEnabled && liveProductionScore < liveProductionConfidenceThreshold) {
      decisionReasons.push(`raw_${String(bias || '').toLowerCase()} ${liveProductionScore.toFixed(4)} < ${liveProductionConfidenceThreshold.toFixed(4)}`);
    }
    if (LIVE_PRODUCTION_GUARD && !pocketProductionGuard.passed) {
      decisionReasons.push(...pocketProductionGuard.reasons.map(reason => `production_guard: ${reason}`));
    }
    if (dynamicExit && !dynamicExit.tradable) {
      decisionReasons.push(`dynamic_exit: ${dynamicExit.reason}`);
    }
    if (!exitLevelsValid) decisionReasons.push(`exit_geometry: ${exitValidation.reason}`);
    const uniqueDecisionReasons = [...new Set(decisionReasons)].slice(0, 5);
    const primaryMetaLabel = `${PRIMARY_MODEL_SOURCE}/${PRIMARY_MODEL_VERSION}`;
    const shadowMetaLabel = shadowMlMeta
      ? `${SHADOW_MODEL_SOURCE}/${SHADOW_MODEL_VERSION} conf=${formatModelScore(shadowMlMeta.confidence)}`
      : '-';
    console.log(
      `[FOREX MODEL DECISION] ${cleanName} | primary=${primaryMetaLabel} | bias=${bias || '-'} | ` +
      `conf=${formatModelScore(mlMeta?.confidence ?? confidence)} | ` +
      `raw_buy=${formatModelScore(mlMeta?.raw_buy)} raw_sell=${formatModelScore(mlMeta?.raw_sell)} | ` +
      `prod_score=${formatModelScore(liveProductionScore)} threshold=${formatModelScore(primaryEntryThreshold)} | ` +
      `result=${isSignal ? 'MT5_LIVE_READY' : 'SHADOW_ONLY'} | ` +
      `shadow=${shadowMetaLabel} | ` +
      `reason=${isSignal ? 'PASS_LIVE_GUARDS' : (uniqueDecisionReasons.join(' ; ') || 'not_signal')}`
    );

    scanResults.push({
      symbol,
      cleanName,
      price: currPrice,
      entryPrice,
      entryMode,
      qualified,
      bias,
      confidence,
      isSignal,
      challengerConfidence,
      challengerIsSignal,
      rangeAction: rangeSetup?.action || null,
      rangeConfidence,
      rangeIsSignal,
      tpPrice,
      slPrice,
      exitMode: dynamicExit?.mode || 'fixed_atr',
      exitTradable: (dynamicExit?.tradable ?? true) && exitLevelsValid,
      exitReason: exitValidationReason || dynamicExit?.reason || null,
      exitRr: dynamicExit?.rr || (slPips > 0 ? tpPips / slPips : 0),
      reasons
    });

    // If Signal Triggered, write to MySQL & Telegram Alert
    if (isSignal) {
      try {
        // 1. Check if already holding an active position on this pair
        const [openCheck] = await pool.query(
          `SELECT symbol, status_note FROM active_positions 
           WHERE symbol = ? AND market_type = 'forex' AND status_note NOT LIKE 'CLOSED%'`,
          [symbol]
        );
        const hasDbActivePosition = openCheck.length > 0;
        let isScaleIn = false;
        let isSignalReentry = false;
        const addOnEntryEnabled = SCALE_IN_ENABLED || REENTRY_ENABLED;
        if (hasDbActivePosition && (!addOnEntryEnabled || process.env.MT5_ENABLED !== 'true')) {
          // Already holding an open trade on this pair, wait for it to close
          console.log(`⏸️ [ACTIVE HOLDING GUARD] ${cleanName} มีออเดอร์/Pending อยู่แล้ว (${openCheck[0].status_note}) -> ข้าม`);
          continue;
        }

        // MT5 is the source of truth for live positions. Fail closed when the
        // broker cannot be checked, because placing an order in that state can
        // create a duplicate position.
        let livePositions = [];
        let livePendingOrders = [];
        if (process.env.MT5_ENABLED === 'true') {
          livePositions = await getOpenPositions();
          if (!Array.isArray(livePositions)) {
            console.warn(`⚠️ [MT5 POSITION CHECK] ตรวจสอบ ${cleanName} ไม่ได้ -> ข้ามการยิงเพื่อความปลอดภัย`);
            continue;
          }

          const brokerSymbol = cleanName.toUpperCase();
          const sameSymbolPositions = livePositions.filter(pos =>
            String(pos.symbol || '').replace(/=X$/i, '').toUpperCase() === brokerSymbol
          );
          let allowScaleIn = false;
          if (sameSymbolPositions.length > 0 && (SCALE_IN_ENABLED || REENTRY_ENABLED)) {
            const sameDirectionPositions = sameSymbolPositions.filter(pos =>
              String(pos.type || '').toUpperCase() === bias
            );
            const oppositeDirectionPositions = sameSymbolPositions.filter(pos =>
              String(pos.type || '').toUpperCase() !== bias
            );

            if (REENTRY_ENABLED
              && primaryEntryScore >= REENTRY_MIN_CONFIDENCE
              && sameDirectionPositions.length > 0
              && oppositeDirectionPositions.length === 0
              && sameSymbolPositions.length < REENTRY_MAX_POSITIONS_PER_SYMBOL) {
              // Re-entry is only allowed when the existing same-direction
              // position has moved in favor by at least the configured ATR
              // distance. Never add to a losing position or flip direction
              // while the previous position is still open.
              const latestPosition = [...sameDirectionPositions].sort((a, b) =>
                new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime()
              )[0];
              const anchorPrice = Number(latestPosition?.priceOpen || 0);
              const favorableMove = bias === 'BUY'
                ? currPrice - anchorPrice
                : anchorPrice - currPrice;
              const minMove = Math.max(Number.EPSILON, SCALE_IN_MIN_DISTANCE_ATR * atr);

              if (Number.isFinite(anchorPrice) && anchorPrice > 0 && favorableMove >= minMove) {
                allowScaleIn = true;
                isScaleIn = true;
                isSignalReentry = true;
                console.log(`[FOREX REENTRY] ${cleanName} ${bias} SIGNAL_PERSISTENCE | score ${primaryEntryScore.toFixed(4)} | favorable move ${favorableMove.toFixed(dec)} >= ${minMove.toFixed(dec)} | ${sameSymbolPositions.length}/${REENTRY_MAX_POSITIONS_PER_SYMBOL} positions`);
              } else {
                console.log(`[REENTRY GUARD] ${cleanName}: favorable move ${favorableMove.toFixed(dec)} < ${minMove.toFixed(dec)} -> skip`);
              }
            } else if (sameDirectionPositions.length > 0
              && oppositeDirectionPositions.length === 0
              && sameDirectionPositions.length < SCALE_IN_MAX_POSITIONS_PER_SYMBOL) {
              // Only pyramid into a move that is already favorable. Never
              // use this lane to average down a losing position.
              const latestPosition = [...sameDirectionPositions].sort((a, b) =>
                new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime()
              )[0];
              const anchorPrice = Number(latestPosition?.priceOpen || 0);
              const favorableMove = bias === 'BUY'
                ? currPrice - anchorPrice
                : anchorPrice - currPrice;
              const minMove = Math.max(Number.EPSILON, SCALE_IN_MIN_DISTANCE_ATR * atr);

              if (Number.isFinite(anchorPrice) && anchorPrice > 0 && favorableMove >= minMove) {
                allowScaleIn = true;
                isScaleIn = true;
                console.log(`📈 [SCALE-IN CANDIDATE] ${cleanName} ${bias}: ${sameDirectionPositions.length}/${SCALE_IN_MAX_POSITIONS_PER_SYMBOL} positions | favorable move ${favorableMove.toFixed(dec)} >= ${minMove.toFixed(dec)}`);
              } else {
                console.log(`⏭️ [SCALE-IN GUARD] ${cleanName}: favorable move ${favorableMove.toFixed(dec)} < ${minMove.toFixed(dec)} (${SCALE_IN_MIN_DISTANCE_ATR} ATR) -> skip`);
              }
            }
          }
          const alreadyOpenOnMt5 = sameSymbolPositions.length > 0 && !allowScaleIn;
          if (alreadyOpenOnMt5) {
            console.log(`⏭️ [MT5 DUPLICATE GUARD] ${cleanName} มี position อยู่บน MT5 แล้ว -> ข้าม`);
            continue;
          }

          // Check if symbol already has an active Pending Order on MT5
          livePendingOrders = await getPendingOrders();
          if (Array.isArray(livePendingOrders)) {
            const alreadyPendingOnMt5 = livePendingOrders.some(ord =>
              String(ord.symbol || '').replace(/=X$/i, '').toUpperCase() === brokerSymbol
            );
            if (alreadyPendingOnMt5) {
              console.log(`⏭️ [MT5 PENDING GUARD] ${cleanName} มี Pending Order ค้างอยู่บน MT5 แล้ว -> ข้าม`);
              continue;
            }
          }
        }

        // 2. Correlated Currency Exposure Guard: Prevent multi-pair cluster exposure on same currency (e.g. 3x Short JPY)
        if (!DATA_HARVEST_LIVE_MODE && process.env.FOREX_CORRELATED_GUARD_ENABLED !== 'false') {
          const maxExposure = Number(process.env.FOREX_MAX_CORRELATED_EXPOSURE || 2);
          let allExistingPositions = [];
          if (process.env.MT5_ENABLED === 'true') {
            allExistingPositions = [
              ...(Array.isArray(livePositions) ? livePositions : []),
              ...cycleNewPositions
            ];
          } else {
            const [dbActive] = await pool.query(
              `SELECT symbol, status_note FROM active_positions WHERE market_type = 'forex' AND status_note NOT LIKE 'CLOSED%' AND status_note NOT LIKE '%PENDING%'`
            );
            allExistingPositions = [...(dbActive || []), ...cycleNewPositions];
          }

          const correlationGuard = checkCorrelatedCurrencyGuard(allExistingPositions, symbol, bias, maxExposure);
          if (correlationGuard.blocked) {
            console.log(`🛡️ [CORRELATION GUARD] ข้ามการยิงออเดอร์ ${cleanName} (${bias}): ${correlationGuard.reason}`);
            continue;
          }
        }

        // 3. Cooldown check: prevent re-entering on consecutive bars within configurable minutes
        if (!DATA_HARVEST_LIVE_MODE) {
          if (!isScaleIn && !isSignalReentry) {
            const cooldownMinutes = Number(process.env.FOREX_SIGNAL_COOLDOWN_MINUTES || 5);
            const [cooldownCheck] = await pool.query(
              `SELECT id FROM signals 
               WHERE symbol = ? AND market_type = 'forex' AND time >= NOW() - INTERVAL ? MINUTE`,
              [symbol, cooldownMinutes]
            );
            if (cooldownCheck.length > 0) {
              console.log(`⏳ [COOLDOWN GUARD] ข้ามการยิงออเดอร์ ${cleanName}: เพิ่งมีสัญญาณไปภายใน ${cooldownMinutes} นาที`);
              continue;
            }
          }
        }

        if (isScaleIn || isSignalReentry) {
          const [lastSignalRows] = await pool.query(
            `SELECT time FROM signals
             WHERE symbol = ? AND market_type = 'forex'
             ORDER BY id DESC LIMIT 1`,
            [symbol]
          );
          const lastSignalTime = lastSignalRows[0]?.time ? new Date(lastSignalRows[0].time).getTime() : NaN;
          const currentBarTime = Date.now();
          if (Number.isFinite(lastSignalTime) && Number.isFinite(currentBarTime)) {
            const lastSignalBar = Math.floor(lastSignalTime / (5 * 60 * 1000));
            const currentBar = Math.floor(currentBarTime / (5 * 60 * 1000));
            if (lastSignalBar === currentBar) {
              console.log(`⏭️ [SCALE-IN BAR GUARD] ${cleanName}: same M5 bar -> skip`);
              continue;
            }
          }
        }

        // 4. Session Guard: Skip new entries during statistically toxic rollover/transition windows
        if (!DATA_HARVEST_LIVE_MODE && process.env.FOREX_SESSION_GUARD_ENABLED !== 'false') {
          const sessionGuard = checkForexSessionGuard();
          if (sessionGuard.blocked) {
            console.log(`⏸️ [SESSION GUARD] ข้ามการยิงออเดอร์ ${cleanName}: ${sessionGuard.reason}`);
            continue;
          }
        }

        // 5. Consecutive Loss Circuit Breaker: Prevent repeated losses in choppy pairs
        if (!DATA_HARVEST_LIVE_MODE) {
        const circuitBreaker = await checkConsecutiveLossCircuitBreaker(pool, symbol);
        if (circuitBreaker.blocked) {
          console.log(`🛡️ [CIRCUIT BREAKER] ข้ามการยิงออเดอร์ ${cleanName}: ${circuitBreaker.reason}`);
          continue;
        }

        console.log(`🔥 [FOREX ${bias} SIGNAL] ตรวจพบสัญญาณ ${bias} ${cleanName} @ ${currPrice.toFixed(dec)} (ความมั่นใจ ${(confidence * 100).toFixed(1)}%) | Mode: ${entryMode}`);

        }

        if (DATA_HARVEST_LIVE_MODE) {
          console.log(`[DATA_HARVEST_LIVE] ${bias} ${cleanName} accepted after frequency guards | confidence ${(confidence * 100).toFixed(1)}% | score ${confluenceScore}`);
        }

        const pipSize = symbol.includes('JPY') ? 0.01 : 0.0001;
        const tpPips = Math.round(Math.abs(tpPrice - entryPrice) / pipSize);
        const slPips = Math.round(Math.abs(entryPrice - slPrice) / pipSize);
        const rrRatio = (Math.abs(tpPrice - entryPrice) / (Math.abs(entryPrice - slPrice) || 1)).toFixed(2);

        // 3. Optional Gemini LLM Review (Two-Stage AI Validation)
        const geminiReview = await reviewTradeWithGemini({
          symbol,
          cleanName,
          action: bias,
          price: entryPrice,
          atr,
          ema9: indicators?.ema9,
          ema21: indicators?.ema21,
          ema50: indicators?.ema50,
          rsi: indicators?.rsi14,
          adx: indicators?.adx14,
          macd_hist: indicators?.macdHist,
          dxyTrend: indicators?.dxyTrend,
          slPrice,
          tpPrice,
          slPips,
          tpPips,
          rrRatio,
          mlConfidence: confidence
        });

        if (geminiReview.enabled && !geminiReview.should_enter) {
          console.log(`🛑 [GEMINI VETO] Gemini ปฏิเสธการเข้าออเดอร์ ${bias} ${cleanName}: ${geminiReview.comment_th}`);
          continue;
        }

        if (geminiReview.enabled && geminiReview.should_enter) {
          console.log(`✨ [GEMINI APPROVED] ${cleanName} (${geminiReview.verdict} - ${geminiReview.risk_rating}): ${geminiReview.comment_th}`);
          reasons.push(`🤖 Gemini Review: [${geminiReview.verdict} / ${geminiReview.risk_rating}] ${geminiReview.comment_th}`);
        }

        // Use Thailand local time (Asia/Bangkok)
        const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });

        // Calculate lot size with asymmetric high conviction sizing
        const baseLot = Number(process.env.MT5_DEFAULT_LOT || 0.01);
        const highConvictionLot = Number(process.env.FOREX_HIGH_CONVICTION_LOT || 0.02);
        const isHighConviction = confidence >= 0.75 && Math.abs(csmSpread || 0) >= 3.0;
        const standardLot = isHighConviction ? highConvictionLot : baseLot;
        // Respect the broker's common 0.01 minimum while keeping scale-in
        // entries no larger than the normal entry lot.
        const lot = isScaleIn
          ? Math.max(0.01, Number((standardLot * SCALE_IN_LOT_MULTIPLIER).toFixed(2)))
          : standardLot;
        if (isHighConviction) {
          console.log(`💎 [HIGH CONVICTION SIZING] ${cleanName}: มั่นใจ ${(confidence * 100).toFixed(1)}% + CSM Spread ${Math.abs(csmSpread || 0).toFixed(1)} -> ปรับ Lot เป็น ${lot}`);
        }

        // Attempt Auto-Execution on MT5 Demo if enabled
        let mt5Ticket = null;
        let isPendingOrder = false;
        let actualMarketFillPrice = null;
        if (process.env.MT5_ENABLED === 'true') {
          try {
            if (entryMode === 'PULLBACK') {
              const pendingType = bias === 'BUY' ? 'BUY_LIMIT' : 'SELL_LIMIT';
              const expirationMinutes = Number(process.env.FOREX_PENDING_EXPIRATION_MINUTES || 45);
              const orderRes = await placePendingOrder({
                symbol,
                type: pendingType,
                price: entryPrice,
                lot,
                sl: slPrice,
                tp: tpPrice,
                expirationMinutes,
                comment: `AI Limit ${bias} ${cleanName}`
              });
              if (orderRes && orderRes.success) {
                mt5Ticket = orderRes.ticket;
                isPendingOrder = true;
                console.log(`⏳ [MT5 PENDING LIMIT PLACED] Ticket #${mt5Ticket} | ${pendingType} ${cleanName} @ ${orderRes.price} (SL: ${slPrice}, TP: ${tpPrice}, Exp: ${expirationMinutes}m)`);
              } else if (orderRes && orderRes.error) {
                console.warn(`⚠️ MT5 Pending Order failed: ${orderRes.error}`);
              }
            } else {
              const orderRes = await placeOrder({
                symbol,
                action: bias,
                lot,
                sl: slPrice,
                tp: tpPrice,
                comment: `${entryMode === 'BREAKOUT' ? 'AI Breakout' : 'AI Market'} ${bias} ${cleanName}`
              });
              if (orderRes && orderRes.success) {
                mt5Ticket = orderRes.ticket;
                actualMarketFillPrice = Number(orderRes.price);
                console.log(`🚀 [MT5 DEMO ORDER FILLED] Ticket #${mt5Ticket} | ${bias} ${cleanName} @ ${orderRes.price}`);
              } else if (orderRes && orderRes.error) {
                console.warn(`⚠️ MT5 Order placement skipped/failed: ${orderRes.error}`);
              }
            }
          } catch (err) {
            console.warn(`⚠️ MT5 Order exception: ${err.message}`);
          }
        }

        // Market orders can fill at a different price from the scan quote.
        // Re-anchor exits to the broker fill so a micro-scalp TP cannot end up
        // on the wrong side of the actual position (e.g. BUY TP < priceOpen).
        if (!isPendingOrder
          && Number(mt5Ticket) > 0
          && Number.isFinite(actualMarketFillPrice)
          && actualMarketFillPrice > 0) {
          const plannedEntryPrice = entryPrice;
          const plannedTpDistance = Math.abs(tpPrice - plannedEntryPrice);
          const plannedSlDistance = Math.abs(plannedEntryPrice - slPrice);
          const fillMoved = Math.abs(actualMarketFillPrice - plannedEntryPrice) > Number.EPSILON;

          if (fillMoved && plannedTpDistance > 0 && plannedSlDistance > 0) {
            entryPrice = Number(actualMarketFillPrice.toFixed(dec));
            if (bias === 'BUY') {
              tpPrice = Number((entryPrice + plannedTpDistance).toFixed(dec));
              slPrice = Number((entryPrice - plannedSlDistance).toFixed(dec));
            } else {
              tpPrice = Number((entryPrice - plannedTpDistance).toFixed(dec));
              slPrice = Number((entryPrice + plannedSlDistance).toFixed(dec));
            }

            const fillExitValidation = validateForexExitGeometry({
              action: bias,
              entryPrice,
              slPrice,
              tpPrice
            });
            if (fillExitValidation.valid) {
              try {
                const modifyRes = await modifyStopLoss(mt5Ticket, slPrice, tpPrice);
                if (modifyRes && modifyRes.success) {
                  console.log(`[MT5 EXIT RE-ANCHOR] ${cleanName} ${bias} fill ${entryPrice} -> SL ${slPrice} / TP ${tpPrice}`);
                } else {
                  console.warn(`⚠️ [MT5 EXIT RE-ANCHOR FAILED] ${cleanName} #${mt5Ticket}: ${modifyRes?.error || 'unknown error'}`);
                }
              } catch (modifyErr) {
                console.warn(`⚠️ [MT5 EXIT RE-ANCHOR ERROR] ${cleanName} #${mt5Ticket}: ${modifyErr.message}`);
              }
            } else {
              console.error(`❌ [MT5 EXIT RE-ANCHOR GUARD] ${cleanName} #${mt5Ticket}: ${fillExitValidation.reason}`);
            }
          }
        }

        const finalExitValidation = validateForexExitGeometry({
          action: bias,
          entryPrice,
          slPrice,
          tpPrice
        });
        if (!finalExitValidation.valid) {
          console.error(`❌ [FOREX EXIT GEOMETRY GUARD] ${cleanName} #${mt5Ticket}: ${finalExitValidation.reason}`);
          if (Number(mt5Ticket) > 0) {
            try {
              await closePosition(mt5Ticket);
            } catch (closeErr) {
              console.error(`❌ [FOREX SAFETY CLOSE FAILED] ${cleanName} #${mt5Ticket}: ${closeErr.message}`);
            }
          }
          continue;
        }

        // Never create DB trade records for an order that was not filled or placed.
        if (process.env.MT5_ENABLED === 'true' && !(Number(mt5Ticket) > 0)) {
          console.warn(`⏭️ [INSERT GUARD] ${cleanName} ไม่มี MT5 ticket หลังส่งคำสั่ง -> ไม่ Insert trade record`);
          continue;
        }

        // Second idempotency check after execution protects against a retry
        if (Number(mt5Ticket) > 0) {
          const [duplicateTrade] = await pool.query(
            `SELECT id FROM trade_results WHERE mt5_ticket = ? LIMIT 1`,
            [Number(mt5Ticket)]
          );
          if (duplicateTrade.length > 0) {
            console.warn(`⏭️ [INSERT GUARD] Ticket #${mt5Ticket} มีใน trade_results แล้ว -> ข้ามการ Insert ซ้ำ`);
            continue;
          }
        }

        // Insert into signals table
        await pool.query(
          `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket, source_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'forex', ?, ?)`,
          [
            nowStr,
            symbol,
            entryPrice,
            confidence,
            slPrice,
            tpPrice,
            bias,
            mt5Ticket,
            isSignalReentry ? 'forex_reentry' : (isScaleIn ? 'forex_scalein' : 'forex_live')
          ]
        );

        // Insert into active_positions table
        const positionStatus = isPendingOrder ? `FOREX_${bias}_PENDING_LIMIT` : `FOREX_${bias}_OPEN`;
        await pool.query(
          `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note, market_type, mt5_ticket, source_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'forex', ?, ?)
           ON DUPLICATE KEY UPDATE
             entry_date = VALUES(entry_date),
             entry_price = VALUES(entry_price),
             highest_price = VALUES(highest_price),
             sl_price = VALUES(sl_price),
             tp_price = VALUES(tp_price),
             status_note = VALUES(status_note),
             market_type = 'forex',
              mt5_ticket = VALUES(mt5_ticket),
              source_tag = VALUES(source_tag)`,
          [
            symbol,
            nowStr,
            entryPrice,
            entryPrice,
            slPrice,
            tpPrice,
            positionStatus,
            mt5Ticket,
            isSignalReentry ? 'forex_reentry' : (isScaleIn ? 'forex_scalein' : 'forex_live')
          ]
        );

        // Record snapshot into trade_results for ML learning & performance tracking
        const liveModelSource = activeTrack === 'RANGE_MEAN_REVERSION'
          ? RANGE_MODEL_SOURCE
          : PRIMARY_MODEL_SOURCE;
        const liveModelVersion = activeTrack === 'RANGE_MEAN_REVERSION'
          ? (rangeMlMeta?.model_version || RANGE_MODEL_VERSION)
          : (mlMeta?.model_version || PRIMARY_MODEL_VERSION);
        await recordTradeEntry({
          ticket: mt5Ticket,
          symbol,
          marketType: 'forex',
          pairId,
          action: bias,
          lotSize: lot,
          entryPrice,
          confidence,
          sl: slPrice,
          tp: tpPrice,
          indicators,
          reasons,
          modelSource: liveModelSource,
          modelVersion: liveModelVersion,
          strategyVersion: STRATEGY_VERSION,
          configHash: MODEL_CONFIG_HASH,
          decisionMode: isSignalReentry ? 'FOREX_SIGNAL_REENTRY' : (isScaleIn ? 'FOREX_SCALE_IN' : 'LIVE'),
          sourceTag: isSignalReentry ? 'forex_reentry' : (isScaleIn ? 'forex_scalein' : 'forex_live'),
          predictionMeta: {
            primary: mlMeta,
            shadow: shadowMlMeta,
            champion: championMlMeta,
            challenger: challengerMlMeta,
            range: rangeMlMeta,
            threshold: primaryEntryThreshold,
            score_used: primaryEntryScore,
            score_type: primaryUsesRawDirectionalScore ? 'raw_directional_probability' : 'relative_confidence',
            confluenceScore,
            market_pressure: marketPressure,
            entry_policy: isSignalReentry
              ? 'forex_signal_reentry_v1'
              : (isScaleIn ? 'forex_scalein_v1' : 'forex_base_v1'),
            cost_policy: {
              configured_min_tp_pips: configuredMinTpPips,
              cost_buffer_pips: costBufferPips,
              min_net_target_pips: FOREX_MIN_NET_TARGET_PIPS,
              effective_min_tp_pips: minTpPips
            },
            reentry: isSignalReentry ? {
              min_confidence: REENTRY_MIN_CONFIDENCE,
              max_positions_per_symbol: REENTRY_MAX_POSITIONS_PER_SYMBOL
            } : null,
            scale_in: isScaleIn ? {
              max_positions_per_symbol: SCALE_IN_MAX_POSITIONS_PER_SYMBOL,
              min_distance_atr: SCALE_IN_MIN_DISTANCE_ATR,
              cooldown_minutes: SCALE_IN_COOLDOWN_MINUTES,
              lot_multiplier: SCALE_IN_LOT_MULTIPLIER
            } : null
          }
        });

        // Track in current scan cycle to immediately protect subsequent pairs
        cycleNewPositions.push({ symbol, type: bias });

        // Telegram Notification
        const geminiText = geminiReview.enabled ? `• 🤖 Gemini Review: \`${geminiReview.verdict} (${geminiReview.risk_rating})\`\n  _${geminiReview.comment_th}_\n` : '';
        const ticketText = mt5Ticket 
          ? (isPendingOrder ? `• MT5 Pending Order: \`#${mt5Ticket} (${bias === 'BUY' ? 'BUY_LIMIT' : 'SELL_LIMIT'} @ ${entryPrice.toFixed(dec)})\`\n` : `• MT5 Order Ticket: \`#${mt5Ticket} (Filled)\`\n`)
          : '';

        const alertMsg =
          `⚡ *AI Forex M5 Scalp Signal: ${bias} ${cleanName}* (${entryMode})\n` +
          `• Action: *${bias}* @ \`${entryPrice.toFixed(dec)}\`\n` +
          `• Mode: *${entryMode}* (SL: \`${slPrice.toFixed(dec)}\` | TP: \`${tpPrice.toFixed(dec)}\`)\n` +
          `• Risk/Reward: *1:${rrRatio}* (SL ${slPips} pips / TP ${tpPips} pips)\n` +
          `• AI Confidence: *${(confidence * 100).toFixed(1)}%*\n` +
          ticketText +
          `• Lot Size: *${lot}*\n` +
          geminiText +
          `• Time: \`${nowStr}\` (Asia/Bangkok)`;

        await sendTelegramAlert(alertMsg);
      } catch (err) {
        console.error(`❌ Error recording Forex signal for ${symbol}:`, err.message);
      }
    } else if (false) {
      // Legacy branch retained for compatibility; configured shadow entries
      // are recorded in the role-aware block above.
      try {
        const [existingShadow] = await pool.query(
          `SELECT id FROM trade_results
           WHERE symbol = ? AND market_type = 'forex_shadow'
             AND model_source = ? AND exit_reason = 'OPEN'
           LIMIT 1`,
          [symbol, CHAMPION_MODEL_SOURCE]
        );
        if (existingShadow.length === 0) {
          await recordTradeEntry({
            ticket: null,
          symbol,
          marketType: 'forex_shadow',
          pairId,
          action: bias,
            lotSize: 0.01,
            entryPrice,
            confidence,
            sl: slPrice,
            tp: tpPrice,
            indicators,
            reasons: ['[SHADOW_HARVEST] สัญญาณจำลองเก็บข้อมูล ML', ...reasons],
            modelSource: CHAMPION_MODEL_SOURCE,
            modelVersion: mlMeta?.model_version || CHAMPION_MODEL_VERSION,
            strategyVersion: STRATEGY_VERSION,
            configHash: MODEL_CONFIG_HASH,
            decisionMode: 'CHAMPION_SHADOW',
            predictionMeta: {
              champion: mlMeta,
              challenger: challengerMlMeta,
              threshold: signalConfidenceThreshold,
              confluenceScore
            }
          });
          console.log(`👻 [SHADOW DATA HARVEST] บันทึกตัวอย่าง ${cleanName} (${bias}) เข้าฐานข้อมูลเพื่อเทรน AI (Score: ${confluenceScore})`);
        }
      } catch (err) {
        console.warn('⚠️ Error logging shadow trade:', err.message);
      }
    }
  }

  console.log(`[+] รอบการสแกนตลาด Forex เสร็จสิ้น (${scanResults.length} คู่เงิน)`);
  try {
    await labelForexMlObservations(pool, 250);
  } catch (err) {
    console.warn('⚠️ [Forex ML Dataset] label observations ไม่สำเร็จ:', err.message);
  }

  return {
    success: true,
    market: 'forex',
    scannedAt: new Date().toISOString(),
    results: scanResults
  };
}
