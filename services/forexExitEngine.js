/**
 * Structure-aware dynamic exits for short-term Forex trades.
 *
 * This module only calculates candidate SL/TP levels. It never places,
 * modifies, or closes an order.
 */

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
  const dynamicTpMult = options.marketPressure?.pip_projections?.recommended_tp_atr_mult;
  const dynamicSlMult = options.marketPressure?.pip_projections?.recommended_sl_atr_mult;
  const tpAtrMult = Math.max(0.1, Number(options.tpAtrMult ?? dynamicTpMult ?? (entryMode === 'BREAKOUT' ? 1.8 : (entryMode === 'PULLBACK' ? 1.5 : 0.9))));
  const slAtrMult = Math.max(0.1, Number(options.slAtrMult ?? dynamicSlMult ?? 0.8));
  const bufferAtrFraction = Math.max(0, Number(options.bufferAtrFraction ?? 0.1));
  const minBufferPips = Math.max(0, Number(options.minBufferPips ?? 1));
  const spreadPips = Math.max(0, Number(options.spreadPips || 0));
  const spreadBufferMultiplier = Math.max(0, Number(options.spreadBufferMultiplier ?? 1.5));
  const minTpPips = Math.max(0, Number(options.minTpPips ?? (isJpy ? 10 : 6)));
  const minSlPips = Math.max(0, Number(options.minSlPips ?? (isJpy ? 14 : 6)));
  const tpMultiplier = Math.min(
    1,
    Math.max(0.1, Number(options.tpMultiplier ?? 1))
  );
  const minBrokerDistancePips = Math.max(0, Number(options.minBrokerDistancePips || 0));
  const minRiskReward = Math.max(0, Number(options.minRiskReward ?? (entryMode === 'BREAKOUT' ? 1.3 : 1.15)));

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
    // In trend modes, target ATR expansion or up to distant structure
    rawTpPips = Math.max(atrTargetPips, Math.min(structureTargetPips, atrTargetPips * 1.5));
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
