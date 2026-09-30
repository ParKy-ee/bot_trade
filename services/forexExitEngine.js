/**
 * Structure-aware dynamic exits for short-term Forex trades.
 *
 * This module only calculates candidate SL/TP levels. It never places,
 * modifies, or closes an order.
 */

import { predictSmartEarlyCut } from './modelPredictor.js';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTo(value, decimals) {
  return Number(Number(value).toFixed(decimals));
}

/**
 * Validates that SL and TP are on the correct side of the entry for Forex.
 * A reversed pair can make a broker-side TP look like a loss in the tracker
 * and contaminates both live diagnostics and shadow-training data.
 */
export function validateForexExitGeometry({ action, entryPrice, slPrice, tpPrice } = {}) {
  const direction = String(action || '').toUpperCase();
  const entry = finiteNumber(entryPrice);
  const sl = finiteNumber(slPrice);
  const tp = finiteNumber(tpPrice);

  if (!['BUY', 'SELL'].includes(direction) || entry === null || sl === null || tp === null) {
    return {
      valid: false,
      reason: 'Forex exit geometry has missing/invalid direction, entry, SL, or TP'
    };
  }

  const valid = direction === 'BUY'
    ? sl < entry && tp > entry
    : sl > entry && tp < entry;

  return {
    valid,
    reason: valid
      ? null
      : `${direction} requires ${direction === 'BUY' ? 'SL < entry < TP' : 'TP < entry < SL'} ` +
        `(entry=${entry}, sl=${sl}, tp=${tp})`
  };
}

export function getForexPipSize(symbol = '') {
  return String(symbol).toUpperCase().includes('JPY') ? 0.01 : 0.0001;
}

export function getForexPriceDecimals(symbol = '') {
  return String(symbol).toUpperCase().includes('JPY') ? 3 : 5;
}

/**
 * Finds local pivot highs/lows from completed bars only. The newest bar is
 * excluded because MT5 can still update it while the scan is running.
 */
export function findForexSwingLevels(bars = [], options = {}) {
  const lookbackBars = Math.max(12, Math.floor(Number(options.lookbackBars || 24)));
  const pivotStrength = Math.max(1, Math.floor(Number(options.pivotStrength || 2)));
  const completedBars = bars
    .slice(0, -1)
    .map((bar) => ({
      high: finiteNumber(bar.high),
      low: finiteNumber(bar.low),
      close: finiteNumber(bar.close),
      time: bar.time
    }))
    .filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null);

  const start = Math.max(pivotStrength, completedBars.length - lookbackBars);
  const end = completedBars.length - pivotStrength;
  const pivotHighs = [];
  const pivotLows = [];

  for (let index = start; index < end; index += 1) {
    const current = completedBars[index];
    let isPivotHigh = true;
    let isPivotLow = true;

    for (let offset = 1; offset <= pivotStrength; offset += 1) {
      const left = completedBars[index - offset];
      const right = completedBars[index + offset];
      if (current.high < left.high || current.high < right.high) isPivotHigh = false;
      if (current.low > left.low || current.low > right.low) isPivotLow = false;
    }

    if (isPivotHigh) pivotHighs.push({ price: current.high, index, time: current.time });
    if (isPivotLow) pivotLows.push({ price: current.low, index, time: current.time });
  }

  const windowBars = completedBars.slice(Math.max(0, completedBars.length - lookbackBars));
  const priorHigh = windowBars.length ? Math.max(...windowBars.map((bar) => bar.high)) : null;
  const priorLow = windowBars.length ? Math.min(...windowBars.map((bar) => bar.low)) : null;

  return {
    lookbackBars,
    pivotStrength,
    pivotHighs,
    pivotLows,
    priorHigh,
    priorLow,
    completedBars: completedBars.length
  };
}

function nearestResistance(levels, entryPrice) {
  const candidates = levels
    .map((level) => level.price)
    .filter((price) => price > entryPrice);
  return candidates.length ? Math.min(...candidates) : null;
}

function nearestSupport(levels, entryPrice) {
  const candidates = levels
    .map((level) => level.price)
    .filter((price) => price < entryPrice);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Calculates a dynamic exit candidate.
 *
 * TP is capped by the nearer of the ATR target and the nearest opposing
 * structure. SL is placed beyond the invalidation swing and is never made
 * tighter than the ATR/noise floor. If there is not enough room or the
 * resulting R:R is below the configured gate, the candidate is rejected.
 */
export function calculateDynamicForexExit({
  symbol,
  action,
  entryPrice,
  atrPrice,
  bars,
  options = {}
}) {
  const direction = String(action || '').toUpperCase();
  const entry = finiteNumber(entryPrice);
  const atr = finiteNumber(atrPrice);
  const pipSize = getForexPipSize(symbol);
  const decimals = getForexPriceDecimals(symbol);

  if (!['BUY', 'SELL'].includes(direction) || entry === null || atr === null || atr <= 0) {
    return {
      tradable: false,
      reason: 'ข้อมูล exit ไม่ครบหรือทิศทางไม่ถูกต้อง'
    };
  }

  const isJpy = String(symbol).toUpperCase().includes('JPY');
  const atrPips = atr / pipSize;
  const lookbackBars = Math.max(12, Math.floor(Number(options.lookbackBars || 24)));
  const pivotStrength = Math.max(1, Math.floor(Number(options.pivotStrength || 2)));
  const entryMode = String(options.entryMode || 'DEFAULT').toUpperCase();
  const dynamicTpMult = options.marketPressure?.pip_projections?.recommended_tp_atr_mult;
  const tpAtrMult = Math.max(0.1, Number(options.tpAtrMult ?? dynamicTpMult ?? (entryMode === 'BREAKOUT' ? 1.8 : (entryMode === 'PULLBACK' ? 1.5 : 1.25))));
  const slAtrMult = Math.max(0.1, Number(options.slAtrMult ?? dynamicSlMult ?? 0.85));
  const bufferAtrFraction = Math.max(0, Number(options.bufferAtrFraction ?? 0.1));
  const minBufferPips = Math.max(0, Number(options.minBufferPips ?? 1));
  const spreadPips = Math.max(0, Number(options.spreadPips || 0));
  const spreadBufferMultiplier = Math.max(0, Number(options.spreadBufferMultiplier ?? 1.5));
  const minTpPips = Math.max(0, Number(options.minTpPips ?? (isJpy ? 10.0 : 7.5)));
  const minSlPips = Math.max(0, Number(options.minSlPips ?? (isJpy ? 9.0 : 7.0)));
  const tpMultiplier = Math.min(
    1,
    Math.max(0.1, Number(options.tpMultiplier ?? 1))
  );
  const minBrokerDistancePips = Math.max(0, Number(options.minBrokerDistancePips || 0));
  // A configured floor below 1.15 allows a sub-1:1 trade to pass despite the
  // strategy's recent realized win rate being well below its break-even level.
  const configuredMinRiskReward = finiteNumber(options.minRiskReward ?? (entryMode === 'BREAKOUT' ? 0.4 : 0.25));
  const minRiskReward = Math.max(0.1, configuredMinRiskReward ?? 0.25);

  const swings = findForexSwingLevels(bars, { lookbackBars, pivotStrength });
  const resistance = nearestResistance(swings.pivotHighs, entry) ?? (
    swings.priorHigh > entry ? swings.priorHigh : null
  );
  const support = nearestSupport(swings.pivotLows, entry) ?? (
    swings.priorLow < entry ? swings.priorLow : null
  );

  const bufferPips = Math.max(
    minBufferPips,
    atrPips * bufferAtrFraction,
    spreadPips * spreadBufferMultiplier
  );
  const atrTargetPips = tpAtrMult * atrPips;
  const atrStopPips = slAtrMult * atrPips;

  let structureTargetPips = direction === 'BUY'
    ? (resistance === null ? null : ((resistance - entry) / pipSize) - bufferPips)
    : (support === null ? null : ((entry - support) / pipSize) - bufferPips);
  let structureStopPips = direction === 'BUY'
    ? (support === null ? null : ((entry - support) / pipSize) + bufferPips)
    : (resistance === null ? null : ((resistance - entry) / pipSize) + bufferPips);

  // Specialized Mode-Aware SL & TP calculation
  if (entryMode === 'BREAKOUT' && options.slAnchorPrice) {
    // Mode Breakout: SL is opposite pattern boundary + 1.0x ATR
    const slAnchor = Number(options.slAnchorPrice);
    if (direction === 'SELL') {
      structureStopPips = Math.max(0, ((slAnchor - entry) / pipSize) + (1.0 * atrPips));
    } else {
      structureStopPips = Math.max(0, ((entry - slAnchor) / pipSize) + (1.0 * atrPips));
    }
    // In strong breakout, target opposite direction by ATR multiplier (don't cap at immediate support)
    structureTargetPips = tpAtrMult * atrPips;
  } else if (entryMode === 'PULLBACK') {
    // Mode Pullback: SL is Swing High/Low + 1.2x ATR buffer (prevents pullback hunt)
    if (direction === 'SELL') {
      const swingHigh = resistance ?? (entry + (1.0 * atr));
      structureStopPips = Math.max(0, ((swingHigh - entry) / pipSize) + (1.2 * atrPips));
    } else {
      const swingLow = support ?? (entry - (1.0 * atr));
      structureStopPips = Math.max(0, ((entry - swingLow) / pipSize) + (1.2 * atrPips));
    }
    // Pullback target is at least 1.5x ATR towards the main trend direction
    structureTargetPips = Math.max(atrTargetPips, structureTargetPips || 0);
  }

  let rawTpPips = atrTargetPips;
  if (entryMode === 'RANGE') {
    const targetCandidates = [atrTargetPips, structureTargetPips]
      .filter((value) => Number.isFinite(value) && value > 0);
    rawTpPips = targetCandidates.length ? Math.min(...targetCandidates) : atrTargetPips;
  } else if (Number.isFinite(structureTargetPips) && structureTargetPips > 0) {
    // Smart Structural TP Cap: Cap realistic TP at or before the structure barrier (resistance for BUY, support for SELL)
    // rather than forcing Math.max(atrTargetPips, ...) which throws TP beyond the wall!
    rawTpPips = Math.min(atrTargetPips, structureTargetPips);
  }
  const tpPips = rawTpPips * tpMultiplier;
  const effectiveStructureStopPips = Number.isFinite(structureStopPips) && structureStopPips > 0
    ? Math.min(structureStopPips, atrStopPips * 1.25)
    : atrStopPips;
  const slPips = Math.max(
    minSlPips,
    minBrokerDistancePips,
    atrStopPips,
    effectiveStructureStopPips
  );
  const effectiveMinTpPips = Math.max(minTpPips, minBrokerDistancePips, spreadPips * 2);
  const rr = slPips > 0 ? tpPips / slPips : 0;

  const rejectionReasons = [];
  if (!tpPips || tpPips < effectiveMinTpPips) {
    rejectionReasons.push(`พื้นที่ถึงเป้าหมายไม่พอ (${tpPips.toFixed(1)} < ${effectiveMinTpPips.toFixed(1)} pips)`);
  }
  if (rr < minRiskReward) {
    rejectionReasons.push(`R:R ต่ำเกณฑ์ (${rr.toFixed(2)} < 1:${minRiskReward.toFixed(2)})`);
  }

  const tradable = rejectionReasons.length === 0;
  const tpDistance = tpPips * pipSize;
  const slDistance = slPips * pipSize;
  const tpPrice = direction === 'BUY'
    ? roundTo(entry + tpDistance, decimals)
    : roundTo(entry - tpDistance, decimals);
  const slPrice = direction === 'BUY'
    ? roundTo(entry - slDistance, decimals)
    : roundTo(entry + slDistance, decimals);

  return {
    tradable,
    reason: tradable ? 'ผ่าน dynamic structure/ATR exit gate' : rejectionReasons.join(' | '),
    mode: 'dynamic_structure_atr',
    symbol,
    action: direction,
    entryPrice: entry,
    tpPrice,
    slPrice,
    tpPips,
    rawTpPips,
    tpMultiplier,
    slPips,
    rr,
    atrPips,
    atrTargetPips,
    atrStopPips,
    structureTargetPips,
    structureStopPips,
    resistance,
    support,
    bufferPips,
    effectiveMinTpPips,
    lookbackBars,
    pivotStrength,
    marketPressure: options.marketPressure || null,
    expectedNetPips: options.marketPressure?.pip_projections?.expected_net_pips ?? null
  };
}

/**
 * Evaluates whether an open position should be closed early due to adverse Market Pressure
 * (Tier 1: Profit Lock or Tier 2: ML-Powered Smart Early Cut).
 */
export async function evaluateAdversePressureExit({
  action,
  currClose,
  entryPrice,
  pipSize,
  marketPressure,
  holdMinutes = 0,
  slPrice = null,
  tpPrice = null,
  bars = []
} = {}) {
  const isEnabled = process.env.FOREX_PRESSURE_EXIT_ENABLED !== 'false';
  if (!isEnabled || !marketPressure || !marketPressure.probabilities) {
    return { shouldExit: false };
  }

  const minHoldMinutes = Number(process.env.FOREX_PRESSURE_MIN_HOLD_MINUTES || 7);
  if (holdMinutes < minHoldMinutes) {
    return { shouldExit: false };
  }

  const isBuy = String(action || '').toUpperCase() === 'BUY';
  const profitPips = isBuy
    ? (currClose - entryPrice) / pipSize
    : (entryPrice - currClose) / pipSize;

  const adverseProb = isBuy
    ? Number(marketPressure.probabilities.sell_pressure || 0)
    : Number(marketPressure.probabilities.buy_pressure || 0);

  const adverseState = isBuy
    ? marketPressure.state === 'SELL_PRESSURE'
    : marketPressure.state === 'BUY_PRESSURE';

  const expNetPips = Number(marketPressure.pip_projections?.expected_net_pips || 0);
  const adverseFlowPips = isBuy ? -expNetPips : expNetPips; // positive means moving against our position

  // Tier 1: Smart Profit Protection (Replaces naive 1-pip cut)
  // In M5 trading, minor pullbacks in early profit (< 4.5 pips or < 45% TP) are normal continuation noise.
  // Prematurely cutting at +1.0 pips loses 56% of big winners that go on to hit full TP.
  // Therefore, only consider active Profit Lock if:
  // 1) Position achieved substantial profit (>= 4.5 pips or >= 45% TP distance)
  // 2) Strong adverse reversal is confirmed (adverseProb >= 0.60, adverseState, adverseFlowPips >= 2.0)
  const tp_p_tier1 = Number(tpPrice);
  const tp_total_pips_tier1 = (tp_p_tier1 && entryPrice) ? Math.abs(tp_p_tier1 - entryPrice) / pipSize : 15.0;
  const profitLockMinPips = Math.max(
    Number(process.env.FOREX_PRESSURE_PROFIT_LOCK_PIPS || 4.5),
    0.45 * tp_total_pips_tier1
  );
  const adverseThreshold = Number(process.env.FOREX_PRESSURE_ADVERSE_THRESHOLD || 0.60);

  if (profitPips >= profitLockMinPips && adverseProb >= adverseThreshold && adverseState && adverseFlowPips >= 2.0) {
    return {
      shouldExit: true,
      exitReason: 'CLOSED_PRESSURE_PROFIT_LOCK',
      profitPips: Number(profitPips.toFixed(2)),
      adverseProb,
      adverseFlowPips: Number(adverseFlowPips.toFixed(2)),
      reason: `ตรวจพบแรงต้านกลับตัวรุนแรง ${(adverseProb * 100).toFixed(0)}% (${isBuy ? 'Sell' : 'Buy'} Pressure Flow: ${adverseFlowPips.toFixed(1)}p) ขณะมีกำไรก้อนใหญ่ +${profitPips.toFixed(1)} pips -> ปิดล็อกกำไรเพื่อป้องกันกำไรหดตัว!`
    };
  }

  // Tier 2: ML-Powered Smart Early Cut (Only when position is in adverse drawdown)
  // Replaces the naive 1-bar heuristic with the trained SECRC Trajectory & Rebound Ensemble.
  // Objective: Protect >90% of pullbacks that rebound to TP, and only cut fatal collapses.
  const earlyCutTriggerPips = Number(process.env.FOREX_PRESSURE_EARLY_CUT_PIPS || -5.0);

  if (profitPips <= earlyCutTriggerPips) {
    try {
      const lastBar = (bars && bars.length > 0) ? bars[bars.length - 1] : {};
      const open_p = Number(lastBar.open) || currClose;
      const close_p = currClose;
      const high_p = Number(lastBar.high) || Math.max(open_p, close_p);
      const low_p = Number(lastBar.low) || Math.min(open_p, close_p);
      const c_range = Math.max(pipSize * 0.1, high_p - low_p);

      const candle_body = (close_p - open_p) / c_range;
      const adverse_body = isBuy ? -candle_body : candle_body;

      const upper_wick = (high_p - Math.max(open_p, close_p)) / c_range;
      const lower_wick = (Math.min(open_p, close_p) - low_p) / c_range;

      const rejection_wick = isBuy ? lower_wick : upper_wick;
      const adverse_wick = isBuy ? upper_wick : lower_wick;
      const wick_asym = rejection_wick - adverse_wick;

      const sl_p = Number(slPrice);
      const tp_p = Number(tpPrice);
      const sl_total_pips = (sl_p && entryPrice) ? Math.abs(entryPrice - sl_p) / pipSize : 15.0;
      const tp_total_pips = (tp_p && entryPrice) ? Math.abs(tp_p - entryPrice) / pipSize : 15.0;

      const dist_to_sl_pips = sl_p ? (isBuy ? (currClose - sl_p) / pipSize : (sl_p - currClose) / pipSize) : sl_total_pips * 0.5;
      const dist_to_tp_pips = tp_p ? (isBuy ? (tp_p - currClose) / pipSize : (currClose - tp_p) / pipSize) : tp_total_pips;

      const sl_room_ratio = Math.min(1.0, Math.max(0.0, dist_to_sl_pips / Math.max(0.1, sl_total_pips)));
      const tp_dist_ratio = Math.min(3.0, Math.max(0.0, dist_to_tp_pips / Math.max(0.1, tp_total_pips)));

      const atr_pips = lastBar.atr ? Math.max(1.0, Number(lastBar.atr) / pipSize) : (marketPressure.atr_pips || 8.0);
      const drawdown_pips = Math.abs(profitPips);

      const features = {
        floating_pips: Number(profitPips.toFixed(2)),
        drawdown_to_atr: Number(Math.min(5.0, Math.max(0.0, drawdown_pips / atr_pips)).toFixed(4)),
        sl_room_ratio: Number(sl_room_ratio.toFixed(4)),
        tp_dist_ratio: Number(tp_dist_ratio.toFixed(4)),
        adverse_body: Number(Math.min(1.0, Math.max(-1.0, adverse_body)).toFixed(4)),
        rejection_wick: Number(Math.min(1.0, Math.max(0.0, rejection_wick)).toFixed(4)),
        adverse_wick: Number(Math.min(1.0, Math.max(0.0, adverse_wick)).toFixed(4)),
        wick_asym: Number(Math.min(1.0, Math.max(-1.0, wick_asym)).toFixed(4)),
        rsi: Number(lastBar.rsi || 50.0),
        atr_pips: Number(atr_pips.toFixed(2)),
        bar_index: Math.max(1, Math.round(holdMinutes / 5))
      };

      const mlCut = await predictSmartEarlyCut(features);
      // Anti-Premature Cut Guard: Only cut when in true adverse distress
      // 1. Drawdown must exceed -5.0 pips (or 0.70x ATR)
      // 2. SL room ratio must be <= 0.35 (actually approaching the stop loss, not floating safely)
      // 3. Trade held for at least 10 minutes (2 M5 bars)
      const isSevereDrawdown = profitPips <= Math.min(-5.0, -0.70 * atr_pips);
      const isSlEndangered = sl_room_ratio <= 0.35;
      const isHeldLongEnough = holdMinutes >= 10;

      if (mlCut && mlCut.should_cut && isSevereDrawdown && isSlEndangered && isHeldLongEnough) {
        return {
          shouldExit: true,
          exitReason: 'CLOSED_PRESSURE_EARLY_CUT',
          profitPips: Number(profitPips.toFixed(2)),
          adverseProb,
          adverseFlowPips: Number(adverseFlowPips.toFixed(2)),
          collapseProb: mlCut.collapse_prob,
          reboundProb: mlCut.rebound_prob,
          reason: `ML Smart Cut: ตรวจพบโครงสร้างพังทลายแท้จริง (Collapse ${(mlCut.collapse_prob * 100).toFixed(1)}% >= ${(mlCut.threshold_used * 100).toFixed(0)}%, SL Room ${(sl_room_ratio * 100).toFixed(0)}%) ขณะติดลบ ${profitPips.toFixed(1)} pips -> ชิงตัดขาดทุนทิ้งแม่นยำ!`
        };
      } else if (mlCut) {
        if (profitPips <= -3.5) {
          console.log(`🛡️ [ML SMART CUT PROTECT] ${isBuy ? 'BUY' : 'SELL'} drawdown ${profitPips.toFixed(1)}p: Rebound Prob ${(mlCut.rebound_prob * 100).toFixed(1)}% (SL Room ${(sl_room_ratio * 100).toFixed(0)}% | Distress: ${isSevereDrawdown && isSlEndangered}) -> HOLD normal pullback!`);
        }
      }
    } catch (mlErr) {
      console.warn('⚠️ [evaluateAdversePressureExit] ML evaluation failed, holding position:', mlErr.message);
    }
  }

  return { shouldExit: false };
}

/**
 * Evaluates whether an open position has reached a structural S/R barrier in profit
 * and exhibited rejection price action (wick rejection or candle pullback),
 * indicating that price is failing to pierce through and should be harvested immediately
 * to protect profit and prevent adverse reversal.
 */
export function evaluateSrRejectionHarvest({
  action,
  currentPrice,
  entryPrice,
  bars = [],
  atr,
  pipSize = 1.0,
  holdMinutes = 0,
  minProfitAtrMult = 0.45,
  minHoldMinutes = 5
} = {}) {
  const isEnabled = process.env.SR_REJECTION_HARVEST_ENABLED !== 'false';
  if (!isEnabled) return { shouldExit: false };

  const isBuy = String(action || '').toUpperCase().includes('BUY');
  const entry = Number(entryPrice);
  const curr = Number(currentPrice);
  const currentAtr = Number(atr);

  if (!entry || !curr || !currentAtr || currentAtr <= 0) {
    return { shouldExit: false };
  }

  if (holdMinutes < minHoldMinutes) {
    return { shouldExit: false };
  }

  const profitDistance = isBuy ? (curr - entry) : (entry - curr);
  const minProfitDistance = minProfitAtrMult * currentAtr;

  // Must have achieved sufficient baseline profit (>= 0.45x ATR)
  if (profitDistance < minProfitDistance) {
    return { shouldExit: false };
  }

  if (!bars || bars.length < 10) {
    return { shouldExit: false };
  }

  const lastBar = bars[bars.length - 1];
  const completedBars = bars.slice(0, -1);
  const refBars = (completedBars.length >= 12 ? completedBars : bars).slice(-24);

  if (refBars.length < 5) {
    return { shouldExit: false };
  }

  const swingHigh = Math.max(...refBars.map(b => Number(b.high)));
  const swingLow = Math.min(...refBars.map(b => Number(b.low)));

  const h = Number(lastBar.high);
  const l = Number(lastBar.low);
  const c = Number(lastBar.close);
  const o = Number(lastBar.open);
  const barRange = Math.max(pipSize * 0.1, h - l);

  const wickRatioMin = Number(process.env.SR_REJECTION_WICK_RATIO || 0.25);
  const pullbackAtrMin = Number(process.env.SR_REJECTION_PULLBACK_ATR || 0.25) * currentAtr;

  if (isBuy) {
    // BUY: Approaching or touching resistance (within 0.35x ATR)
    const nearResistance = h >= swingHigh - (0.35 * currentAtr);
    const upperWickRatio = (h - Math.max(o, c)) / barRange;
    const pulledBackFromHigh = (h - curr) >= pullbackAtrMin || (h - c) >= pullbackAtrMin;
    const isRedReversal = c < o && h >= swingHigh - (0.15 * currentAtr);

    if (nearResistance && (upperWickRatio >= wickRatioMin || pulledBackFromHigh || isRedReversal)) {
      const profitPips = pipSize > 0 ? profitDistance / pipSize : profitDistance;
      const pullbackDist = h - curr;
      return {
        shouldExit: true,
        exitReason: 'CLOSED_SR_REJECTION_HARVEST',
        profitPips: Number(profitPips.toFixed(2)),
        profitDistance,
        srLevel: swingHigh,
        reason: `BUY Resistance Rejection @ ${swingHigh.toFixed(5)} (Wick: ${(upperWickRatio * 100).toFixed(0)}%, Pullback: ${pullbackDist.toFixed(5)}) ขณะมีกำไร +${profitPips.toFixed(1)} -> ล็อกกำไรทันทีก่อนราคาย่อตัว!`
      };
    }
  } else {
    // SELL: Approaching or touching support (within 0.35x ATR)
    const nearSupport = l <= swingLow + (0.35 * currentAtr);
    const lowerWickRatio = (Math.min(o, c) - l) / barRange;
    const pulledBackFromLow = (curr - l) >= pullbackAtrMin || (c - l) >= pullbackAtrMin;
    const isGreenReversal = c > o && l <= swingLow + (0.15 * currentAtr);

    if (nearSupport && (lowerWickRatio >= wickRatioMin || pulledBackFromLow || isGreenReversal)) {
      const profitPips = pipSize > 0 ? profitDistance / pipSize : profitDistance;
      const bounceDist = curr - l;
      return {
        shouldExit: true,
        exitReason: 'CLOSED_SR_REJECTION_HARVEST',
        profitPips: Number(profitPips.toFixed(2)),
        profitDistance,
        srLevel: swingLow,
        reason: `SELL Support Rejection @ ${swingLow.toFixed(5)} (Wick: ${(lowerWickRatio * 100).toFixed(0)}%, Bounce: ${bounceDist.toFixed(5)}) ขณะมีกำไร +${profitPips.toFixed(1)} -> ล็อกกำไรทันทีก่อนราคาดีดกลับ!`
      };
    }
  }

  return { shouldExit: false };
}

