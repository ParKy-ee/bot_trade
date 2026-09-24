/**
 * Forex M5 pattern engine.
 *
 * This file is intentionally standalone and is NOT imported by forexEngine.js
 * yet. It only converts OHLCV bars into deterministic pattern candidates and
 * ML-friendly features. It never places, modifies, or closes an order.
 *
 * Pattern categories:
 *   BOUNCE       - repeated support/resistance rejection
 *   REVERSAL     - double top/bottom and completed ABCD reversal
 *   CONTINUATION - pullback followed by a trend continuation break
 *   BREAKOUT     - confirmed break from a recent range
 */

export const PATTERN_CATEGORIES = Object.freeze({
  BOUNCE: 'BOUNCE',
  REVERSAL: 'REVERSAL',
  CONTINUATION: 'CONTINUATION',
  BREAKOUT: 'BREAKOUT'
});

export const PATTERN_TYPES = Object.freeze({
  SUPPORT_BOUNCE: 'SUPPORT_BOUNCE',
  RESISTANCE_REJECTION: 'RESISTANCE_REJECTION',
  DOUBLE_BOTTOM: 'DOUBLE_BOTTOM',
  DOUBLE_TOP: 'DOUBLE_TOP',
  ABCD_CLASSIC: 'ABCD_CLASSIC',
  ABCD_EXTENSION: 'ABCD_EXTENSION',
  BULLISH_PULLBACK_BREAKOUT: 'BULLISH_PULLBACK_BREAKOUT',
  BEARISH_PULLBACK_BREAKOUT: 'BEARISH_PULLBACK_BREAKOUT',
  RANGE_BREAKOUT_UP: 'RANGE_BREAKOUT_UP',
  RANGE_BREAKOUT_DOWN: 'RANGE_BREAKOUT_DOWN'
});

export const DEFAULT_PATTERN_CONFIG = Object.freeze({
  atrPeriod: 14,
  pivotLeft: 2,
  pivotRight: 2,
  minBarsBetweenPivots: 2,
  minSwingAtr: 0.25,
  levelToleranceAtr: 0.25,
  bounceMoveAtr: 0.35,
  minBounceTouches: 3,
  patternMaxAgeBars: 36,
  patternWindows: [6, 12, 24, 36],
  breakoutLookbackBars: 24,
  breakoutBufferAtr: 0.20,
  confirmationBars: 2,
  minRetracementRatio: 0.382,
  maxRetracementRatio: 0.786,
  classicCdRatioMin: 0.85,
  classicCdRatioMax: 1.15,
  extensionCdRatioMin: 1.20,
  extensionCdRatioMax: 1.80,
  maxAbcdLegBars: 36,
  fingerprintWindowBars: 24,
  fingerprintAtrFloor: 1e-9
});

function mergeConfig(options = {}) {
  return { ...DEFAULT_PATTERN_CONFIG, ...options };
}

function finiteNumber(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanSymbol(symbol = '') {
  return String(symbol).replace(/=X$/i, '').toUpperCase();
}

export function pipSizeForSymbol(symbol = '') {
  return cleanSymbol(symbol).includes('JPY') ? 0.01 : 0.0001;
}

/** Normalize bars and discard rows that cannot participate in geometry. */
export function normalizePatternBars(rawBars = []) {
  if (!Array.isArray(rawBars)) return [];
  return rawBars
    .map((bar, index) => ({
      ...bar,
      _index: index,
      time: bar?.time ?? null,
      open: finiteNumber(bar?.open),
      high: finiteNumber(bar?.high),
      low: finiteNumber(bar?.low),
      close: finiteNumber(bar?.close),
      volume: finiteNumber(bar?.volume, 0)
    }))
    .filter(bar => Number.isFinite(bar.open)
      && Number.isFinite(bar.high)
      && Number.isFinite(bar.low)
      && Number.isFinite(bar.close)
      && bar.high >= bar.low);
}

function trueRangeAt(bars, index) {
  const bar = bars[index];
  if (!bar) return NaN;
  const previousClose = index > 0 ? bars[index - 1].close : bar.close;
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose)
  );
}

/** Wilder ATR series, kept local so the engine has no indicator dependency. */
export function calculateAtrSeries(rawBars, period = DEFAULT_PATTERN_CONFIG.atrPeriod) {
  const bars = normalizePatternBars(rawBars);
  const safePeriod = Math.max(1, Math.floor(Number(period) || DEFAULT_PATTERN_CONFIG.atrPeriod));
  const tr = bars.map((_, index) => trueRangeAt(bars, index));
  const atr = new Array(bars.length).fill(NaN);

  for (let i = 0; i < bars.length; i += 1) {
    if (i < safePeriod - 1) {
      const values = tr.slice(0, i + 1).filter(Number.isFinite);
      atr[i] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
    } else if (i === safePeriod - 1) {
      const values = tr.slice(0, safePeriod).filter(Number.isFinite);
      atr[i] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
    } else {
      atr[i] = ((atr[i - 1] * (safePeriod - 1)) + tr[i]) / safePeriod;
    }
  }

  return { bars, trueRange: tr, atr };
}

function latestFinite(values, fallback = NaN) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return fallback;
}

function highest(values) {
  return values.reduce((max, value) => Math.max(max, value), -Infinity);
}

function lowest(values) {
  return values.reduce((min, value) => Math.min(min, value), Infinity);
}

function average(values, fallback = 0) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : fallback;
}

function median(values, fallback = 0) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return fallback;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function priceTolerance(atr, config, pipSize) {
  return Math.max(
    pipSize * 2,
    (Number.isFinite(atr) ? atr : pipSize * 10) * config.levelToleranceAtr
  );
}

function patternAge(index, totalBars) {
  return Math.max(0, totalBars - 1 - index);
}

function patternResult({
  category,
  type,
  direction = 'NEUTRAL',
  confirmed = false,
  confidence = 0,
  startIndex = null,
  endIndex = null,
  metrics = {},
  levels = {},
  reasons = []
}) {
  return {
    category,
    type,
    direction,
    confirmed,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    startIndex,
    endIndex,
    metrics,
    levels,
    reasons
  };
}

/**
 * Find confirmed local pivots. A pivot cannot use the last pivotRight bars,
 * which prevents the detector from pretending that an unconfirmed turning
 * point is already known.
 */
export function detectPivots(rawBars, atrSeries = [], options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  const left = Math.max(1, Math.floor(config.pivotLeft));
  const right = Math.max(1, Math.floor(config.pivotRight));
  const pivots = [];

  for (let i = left; i < bars.length - right; i += 1) {
    const leftBars = bars.slice(i - left, i);
    const rightBars = bars.slice(i + 1, i + right + 1);
    const high = bars[i].high;
    const low = bars[i].low;
    const atr = finiteNumber(atrSeries[i], high - low);
    const leftHigh = highest(leftBars.map(bar => bar.high));
    const rightHigh = highest(rightBars.map(bar => bar.high));
    const leftLow = lowest(leftBars.map(bar => bar.low));
    const rightLow = lowest(rightBars.map(bar => bar.low));

    const isHigh = high >= leftHigh && high >= rightHigh;
    const isLow = low <= leftLow && low <= rightLow;

    if (isHigh) {
      pivots.push({
        index: i,
        time: bars[i].time,
        type: 'HIGH',
        price: high,
        atr,
        strength: Math.max(0, (high - Math.max(leftHigh, rightHigh)) / Math.max(atr, 1e-9))
      });
    }
    if (isLow) {
      pivots.push({
        index: i,
        time: bars[i].time,
        type: 'LOW',
        price: low,
        atr,
        strength: Math.max(0, (Math.min(leftLow, rightLow) - low) / Math.max(atr, 1e-9))
      });
    }
  }

  pivots.sort((a, b) => a.index - b.index || (a.type === 'LOW' ? -1 : 1));
  const filtered = [];
  for (const pivot of pivots) {
    const previousSameType = [...filtered].reverse().find(item => item.type === pivot.type);
    if (previousSameType && pivot.index - previousSameType.index < config.minBarsBetweenPivots) {
      const keepCurrent = pivot.type === 'HIGH'
        ? pivot.price >= previousSameType.price
        : pivot.price <= previousSameType.price;
      if (keepCurrent) {
        const position = filtered.indexOf(previousSameType);
        filtered[position] = pivot;
      }
      continue;
    }
    filtered.push(pivot);
  }

  return filtered.sort((a, b) => a.index - b.index);
}

/** Cluster pivot prices into support/resistance levels. */
export function clusterPriceLevels(pivots = [], options = {}) {
  const config = mergeConfig(options);
  const symbol = options.symbol || '';
  const pipSize = pipSizeForSymbol(symbol);
  const groups = [];

  for (const pivot of pivots) {
    const tolerance = priceTolerance(pivot.atr, config, pipSize);
    let group = groups.find(item => Math.abs(item.price - pivot.price) <= Math.max(item.tolerance, tolerance));
    if (!group) {
      group = {
        price: pivot.price,
        tolerance,
        touches: [],
        highTouches: 0,
        lowTouches: 0
      };
      groups.push(group);
    }
    group.touches.push(pivot);
    group.highTouches += pivot.type === 'HIGH' ? 1 : 0;
    group.lowTouches += pivot.type === 'LOW' ? 1 : 0;
    group.price = average(group.touches.map(item => item.price), group.price);
    group.tolerance = Math.max(group.tolerance, tolerance);
  }

  return groups
    .map(level => ({
      ...level,
      role: level.lowTouches > level.highTouches
        ? 'SUPPORT'
        : (level.highTouches > level.lowTouches ? 'RESISTANCE' : 'MIXED'),
      touches: level.touches.sort((a, b) => a.index - b.index),
      touchCount: level.touches.length
    }))
    .sort((a, b) => a.price - b.price);
}

function hasBounceAfterTouch(bars, touch, level, direction, atrSeries, config) {
  const end = Math.min(bars.length, touch.index + Math.max(3, config.pivotRight + 4));
  const following = bars.slice(touch.index + 1, end);
  const atr = finiteNumber(atrSeries[touch.index], touch.atr);
  const move = Math.max(atr * config.bounceMoveAtr, level.tolerance);
  if (direction === 'BUY') {
    return following.some(bar => bar.high >= level.price + move);
  }
  return following.some(bar => bar.low <= level.price - move);
}

/** BOUNCE: at least 3 level touches, therefore at least 2 confirmed bounces. */
export function detectBouncePatterns(rawBars, pivots = [], atrSeries = [], options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  const levels = clusterPriceLevels(pivots, options);
  const patterns = [];

  for (const level of levels) {
    if (level.touchCount < config.minBounceTouches || level.role === 'MIXED') continue;
    const direction = level.role === 'SUPPORT' ? 'BUY' : 'SELL';
    const relevantTouches = level.touches.filter(touch => (
      (direction === 'BUY' && touch.type === 'LOW')
      || (direction === 'SELL' && touch.type === 'HIGH')
    ));
    const bouncedTouches = relevantTouches.filter(touch => (
      hasBounceAfterTouch(bars, touch, level, direction, atrSeries, config)
    ));
    const latestTouch = relevantTouches[relevantTouches.length - 1];
    const distancePips = latestTouch
      ? Math.abs(bars[bars.length - 1].close - level.price) / pipSizeForSymbol(options.symbol)
      : NaN;
    const confirmedBounces = Math.max(0, bouncedTouches.length - 1);
    const confirmed = bouncedTouches.length >= config.minBounceTouches;

    patterns.push(patternResult({
      category: PATTERN_CATEGORIES.BOUNCE,
      type: direction === 'BUY' ? PATTERN_TYPES.SUPPORT_BOUNCE : PATTERN_TYPES.RESISTANCE_REJECTION,
      direction,
      confirmed,
      confidence: Math.min(1, 0.35 + (confirmedBounces * 0.15) + (level.touchCount * 0.05)),
      startIndex: relevantTouches[0]?.index ?? null,
      endIndex: latestTouch?.index ?? null,
      metrics: {
        touchCount: level.touchCount,
        confirmedBounces,
        distancePips,
        levelTolerancePips: level.tolerance / pipSizeForSymbol(options.symbol)
      },
      levels: { trigger: level.price },
      reasons: [
        `${level.role} มีจุดแตะ ${level.touchCount} ครั้ง`,
        `ยืนยันการเด้งแล้ว ${confirmedBounces} ครั้ง`
      ]
    }));
  }

  return patterns;
}

/** REVERSAL: double top and double bottom with neckline confirmation. */
export function detectDoubleTopBottom(rawBars, pivots = [], atrSeries = [], options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  const currentClose = bars[bars.length - 1]?.close;
  const patterns = [];

  for (let i = 0; i <= pivots.length - 3; i += 1) {
    const a = pivots[i];
    const b = pivots[i + 1];
    const c = pivots[i + 2];
    if (!a || !b || !c || c.index < bars.length - config.patternMaxAgeBars) continue;
    const tolerance = priceTolerance(average([a.atr, b.atr, c.atr]), config, pipSizeForSymbol(options.symbol));
    const buffer = Math.max(average([a.atr, b.atr, c.atr]) * config.breakoutBufferAtr, tolerance * 0.5);

    if (a.type === 'HIGH' && b.type === 'LOW' && c.type === 'HIGH'
      && Math.abs(a.price - c.price) <= tolerance) {
      const confirmed = currentClose < b.price - buffer;
      patterns.push(patternResult({
        category: PATTERN_CATEGORIES.REVERSAL,
        type: PATTERN_TYPES.DOUBLE_TOP,
        direction: 'SELL',
        confirmed,
        confidence: Math.min(1, 0.55 + (confirmed ? 0.2 : 0) + Math.max(0, 0.1 - Math.abs(a.price - c.price) / Math.max(tolerance, 1e-9))),
        startIndex: a.index,
        endIndex: c.index,
        metrics: {
          peakDifferencePips: Math.abs(a.price - c.price) / pipSizeForSymbol(options.symbol),
          patternHeightPips: (Math.min(a.price, c.price) - b.price) / pipSizeForSymbol(options.symbol)
        },
        levels: { neckline: b.price, invalidation: Math.max(a.price, c.price) + buffer },
        reasons: [
          'ยอด High สองจุดอยู่ใน tolerance เดียวกัน',
          confirmed ? 'ราคาปิดหลุด neckline แล้ว' : 'รอราคาปิดหลุด neckline'
        ]
      }));
    }

    if (a.type === 'LOW' && b.type === 'HIGH' && c.type === 'LOW'
      && Math.abs(a.price - c.price) <= tolerance) {
      const confirmed = currentClose > b.price + buffer;
      patterns.push(patternResult({
        category: PATTERN_CATEGORIES.REVERSAL,
        type: PATTERN_TYPES.DOUBLE_BOTTOM,
        direction: 'BUY',
        confirmed,
        confidence: Math.min(1, 0.55 + (confirmed ? 0.2 : 0) + Math.max(0, 0.1 - Math.abs(a.price - c.price) / Math.max(tolerance, 1e-9))),
        startIndex: a.index,
        endIndex: c.index,
        metrics: {
          troughDifferencePips: Math.abs(a.price - c.price) / pipSizeForSymbol(options.symbol),
          patternHeightPips: (b.price - Math.max(a.price, c.price)) / pipSizeForSymbol(options.symbol)
        },
        levels: { neckline: b.price, invalidation: Math.min(a.price, c.price) - buffer },
        reasons: [
          'ฐาน Low สองจุดอยู่ใน tolerance เดียวกัน',
          confirmed ? 'ราคาปิดทะลุ neckline แล้ว' : 'รอราคาปิดทะลุ neckline'
        ]
      }));
    }
  }

  return patterns;
}

function abcdSequenceDirection(sequence) {
  const types = sequence.map(point => point.type).join('-');
  if (types === 'LOW-HIGH-LOW-HIGH') return 'SELL';
  if (types === 'HIGH-LOW-HIGH-LOW') return 'BUY';
  return 'NEUTRAL';
}

function detectAbcdVariant(sequence, bars, atrSeries, variant, options = {}) {
  const config = mergeConfig(options);
  const [a, b, c, d] = sequence;
  const direction = abcdSequenceDirection(sequence);
  if (direction === 'NEUTRAL') return null;
  if (d.index - a.index > config.maxAbcdLegBars || d.index < bars.length - config.patternMaxAgeBars) return null;

  const ab = Math.abs(b.price - a.price);
  const bc = Math.abs(c.price - b.price);
  const cd = Math.abs(d.price - c.price);
  if (ab <= 0 || bc <= 0 || cd <= 0) return null;

  const bcRatio = bc / ab;
  const cdRatio = cd / ab;
  const retracementValid = bcRatio >= config.minRetracementRatio && bcRatio <= config.maxRetracementRatio;
  const cdValid = variant === 'CLASSIC'
    ? cdRatio >= config.classicCdRatioMin && cdRatio <= config.classicCdRatioMax
    : cdRatio >= config.extensionCdRatioMin && cdRatio <= config.extensionCdRatioMax;
  if (!retracementValid || !cdValid) return null;

  const atr = latestFinite(atrSeries, d.atr);
  const buffer = Math.max(atr * config.breakoutBufferAtr, priceTolerance(atr, config, pipSizeForSymbol(options.symbol)) * 0.5);
  const currentClose = bars[bars.length - 1].close;
  const reversalConfirmed = direction === 'SELL'
    ? currentClose < d.price - buffer
    : currentClose > d.price + buffer;
  const projection = variant === 'CLASSIC' ? ab : ab * cdRatio;
  const projectedD = direction === 'SELL' ? c.price + projection : c.price - projection;

  return patternResult({
    category: PATTERN_CATEGORIES.REVERSAL,
    type: variant === 'CLASSIC' ? PATTERN_TYPES.ABCD_CLASSIC : PATTERN_TYPES.ABCD_EXTENSION,
    direction,
    confirmed: reversalConfirmed,
    confidence: Math.min(1, 0.45 + (reversalConfirmed ? 0.25 : 0) + Math.max(0, 0.15 - Math.abs(cdRatio - (variant === 'CLASSIC' ? 1 : 1.5)) * 0.1)),
    startIndex: a.index,
    endIndex: d.index,
    metrics: {
      abPips: ab / pipSizeForSymbol(options.symbol),
      bcPips: bc / pipSizeForSymbol(options.symbol),
      cdPips: cd / pipSizeForSymbol(options.symbol),
      bcRetracementRatio: bcRatio,
      cdToAbRatio: cdRatio,
      abBars: b.index - a.index,
      bcBars: c.index - b.index,
      cdBars: d.index - c.index
    },
    levels: {
      pointA: a.price,
      pointB: b.price,
      pointC: c.price,
      pointD: d.price,
      projectedD,
      invalidation: direction === 'SELL' ? d.price + buffer : d.price - buffer
    },
    reasons: [
      `BC retracement ${(bcRatio * 100).toFixed(1)}% อยู่ในช่วงที่กำหนด`,
      `CD/AB = ${cdRatio.toFixed(2)}`,
      reversalConfirmed ? 'D ยืนยันด้วยการเคลื่อนออกจากจุดกลับตัว' : 'รอ confirmation หลังจุด D'
    ]
  });
}

/** REVERSAL: classic AB=CD and AB=CD extension, kept as separate types. */
export function detectAbcdPatterns(rawBars, pivots = [], atrSeries = [], options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  const patterns = [];
  for (let i = 0; i <= pivots.length - 4; i += 1) {
    const sequence = pivots.slice(i, i + 4);
    if (sequence.length !== 4) continue;
    if (sequence.some((point, index) => index > 0 && point.type === sequence[index - 1].type)) continue;
    for (const variant of ['CLASSIC', 'EXTENSION']) {
      const candidate = detectAbcdVariant(sequence, bars, atrSeries, variant, config);
      if (candidate) patterns.push(candidate);
    }
  }
  return patterns;
}

/** CONTINUATION: impulse, 38.2–78.6% pullback, then break of B. */
export function detectContinuationPullbacks(rawBars, pivots = [], atrSeries = [], options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  const currentClose = bars[bars.length - 1]?.close;
  const patterns = [];

  for (let i = 0; i <= pivots.length - 3; i += 1) {
    const [a, b, c] = pivots.slice(i, i + 3);
    if (!a || !b || !c || c.index < bars.length - config.patternMaxAgeBars) continue;
    const ab = Math.abs(b.price - a.price);
    const bc = Math.abs(c.price - b.price);
    if (ab <= 0 || bc <= 0) continue;
    const retracementRatio = bc / ab;
    if (retracementRatio < config.minRetracementRatio || retracementRatio > config.maxRetracementRatio) continue;
    const atr = average([a.atr, b.atr, c.atr], latestFinite(atrSeries, 0));
    const buffer = Math.max(atr * config.breakoutBufferAtr, priceTolerance(atr, config, pipSizeForSymbol(options.symbol)) * 0.5);

    if (a.type === 'LOW' && b.type === 'HIGH' && c.type === 'LOW') {
      const confirmed = currentClose > b.price + buffer;
      patterns.push(patternResult({
        category: PATTERN_CATEGORIES.CONTINUATION,
        type: PATTERN_TYPES.BULLISH_PULLBACK_BREAKOUT,
        direction: 'BUY',
        confirmed,
        confidence: Math.min(1, 0.42 + (confirmed ? 0.28 : 0)),
        startIndex: a.index,
        endIndex: c.index,
        metrics: { impulsePips: ab / pipSizeForSymbol(options.symbol), retracementRatio },
        levels: { breakout: b.price, pullback: c.price, invalidation: c.price - buffer },
        reasons: [
          `ขา Pullback ย่อ ${(retracementRatio * 100).toFixed(1)}% ของ impulse`,
          confirmed ? 'ปิดทะลุยอด B แล้ว' : 'รอปิดทะลุยอด B'
        ]
      }));
    }

    if (a.type === 'HIGH' && b.type === 'LOW' && c.type === 'HIGH') {
      const confirmed = currentClose < b.price - buffer;
      patterns.push(patternResult({
        category: PATTERN_CATEGORIES.CONTINUATION,
        type: PATTERN_TYPES.BEARISH_PULLBACK_BREAKOUT,
        direction: 'SELL',
        confirmed,
        confidence: Math.min(1, 0.42 + (confirmed ? 0.28 : 0)),
        startIndex: a.index,
        endIndex: c.index,
        metrics: { impulsePips: ab / pipSizeForSymbol(options.symbol), retracementRatio },
        levels: { breakout: b.price, pullback: c.price, invalidation: c.price + buffer },
        reasons: [
          `ขา Pullback ย่อ ${(retracementRatio * 100).toFixed(1)}% ของ impulse`,
          confirmed ? 'ปิดทะลุฐาน B แล้ว' : 'รอปิดทะลุฐาน B'
        ]
      }));
    }
  }

  return patterns;
}

/** BREAKOUT: two closes beyond a recent range boundary with ATR buffer. */
export function detectRangeBreakouts(rawBars, atrSeries = [], options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  const n = bars.length;
  const lookback = Math.max(6, Math.floor(config.breakoutLookbackBars));
  if (n < lookback + 2) return [];
  const start = Math.max(0, n - lookback - 1);
  const previous = bars.slice(start, n - 1);
  const rangeHigh = highest(previous.map(bar => bar.high));
  const rangeLow = lowest(previous.map(bar => bar.low));
  const atr = latestFinite(atrSeries, rangeHigh - rangeLow);
  const buffer = Math.max(atr * config.breakoutBufferAtr, priceTolerance(atr, config, pipSizeForSymbol(options.symbol)) * 0.5);
  const confirmationBars = Math.max(1, Math.floor(config.confirmationBars));
  const recentCloses = bars.slice(Math.max(0, n - confirmationBars)).map(bar => bar.close);
  const breakUp = recentCloses.every(close => close > rangeHigh + buffer);
  const breakDown = recentCloses.every(close => close < rangeLow - buffer);
  const volumeValues = previous.map(bar => bar.volume).filter(value => value > 0);
  const currentVolume = bars[n - 1].volume;
  const volumeRatio = volumeValues.length && currentVolume > 0
    ? currentVolume / Math.max(median(volumeValues), 1e-9)
    : null;

  const patterns = [];
  if (breakUp) {
    patterns.push(patternResult({
      category: PATTERN_CATEGORIES.BREAKOUT,
      type: PATTERN_TYPES.RANGE_BREAKOUT_UP,
      direction: 'BUY',
      confirmed: true,
      confidence: Math.min(1, 0.55 + (volumeRatio && volumeRatio >= 1.2 ? 0.15 : 0)),
      startIndex: start,
      endIndex: n - 1,
      metrics: { rangePips: (rangeHigh - rangeLow) / pipSizeForSymbol(options.symbol), volumeRatio },
      levels: { brokenResistance: rangeHigh, retestLevel: rangeHigh, invalidation: rangeHigh - buffer },
      reasons: [`ปิดเหนือ range ${confirmationBars} แท่ง`, `buffer ${(buffer / pipSizeForSymbol(options.symbol)).toFixed(1)} pips`]
    }));
  }
  if (breakDown) {
    patterns.push(patternResult({
      category: PATTERN_CATEGORIES.BREAKOUT,
      type: PATTERN_TYPES.RANGE_BREAKOUT_DOWN,
      direction: 'SELL',
      confirmed: true,
      confidence: Math.min(1, 0.55 + (volumeRatio && volumeRatio >= 1.2 ? 0.15 : 0)),
      startIndex: start,
      endIndex: n - 1,
      metrics: { rangePips: (rangeHigh - rangeLow) / pipSizeForSymbol(options.symbol), volumeRatio },
      levels: { brokenSupport: rangeLow, retestLevel: rangeLow, invalidation: rangeLow + buffer },
      reasons: [`ปิดต่ำกว่า range ${confirmationBars} แท่ง`, `buffer ${(buffer / pipSizeForSymbol(options.symbol)).toFixed(1)} pips`]
    }));
  }
  return patterns;
}

/** Build scale-invariant candle features for later ML or nearest-pattern search. */
export function buildPatternFingerprint(rawBars, options = {}) {
  const config = mergeConfig(options);
  const { bars, atr } = calculateAtrSeries(rawBars, config.atrPeriod);
  const window = Math.max(6, Math.floor(config.fingerprintWindowBars));
  const selected = bars.slice(-window);
  const offset = bars.length - selected.length;
  const features = selected.map((bar, index) => {
    const fullIndex = offset + index;
    const candleRange = Math.max(bar.high - bar.low, config.fingerprintAtrFloor);
    const candleAtr = Math.max(finiteNumber(atr[fullIndex], candleRange), config.fingerprintAtrFloor);
    return {
      index: fullIndex,
      time: bar.time,
      closeReturn: index === 0 || !selected[index - 1].close
        ? 0
        : (bar.close - selected[index - 1].close) / candleAtr,
      bodyToRange: (bar.close - bar.open) / candleRange,
      upperWickToRange: (bar.high - Math.max(bar.open, bar.close)) / candleRange,
      lowerWickToRange: (Math.min(bar.open, bar.close) - bar.low) / candleRange,
      rangeToAtr: candleRange / candleAtr,
      volumeToMedian: null
    };
  });
  const volumes = selected.map(bar => bar.volume).filter(value => value > 0);
  const volumeMedian = median(volumes, NaN);
  for (const feature of features) {
    const volume = selected[feature.index - offset]?.volume;
    feature.volumeToMedian = Number.isFinite(volumeMedian) && volume > 0 ? volume / volumeMedian : null;
  }

  return {
    windowBars: selected.length,
    startIndex: offset,
    endIndex: bars.length - 1,
    latestAtr: latestFinite(atr),
    features
  };
}

/** Simple distance metric; use only after filtering same symbol/timeframe/regime. */
export function comparePatternFingerprints(left, right) {
  const leftFeatures = left?.features || [];
  const rightFeatures = right?.features || [];
  const length = Math.min(leftFeatures.length, rightFeatures.length);
  if (!length) return { distance: Infinity, similarity: 0, comparedBars: 0 };

  const keys = ['closeReturn', 'bodyToRange', 'upperWickToRange', 'lowerWickToRange', 'rangeToAtr'];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < length; i += 1) {
    for (const key of keys) {
      const a = finiteNumber(leftFeatures[i][key], 0);
      const b = finiteNumber(rightFeatures[i][key], 0);
      sum += (a - b) ** 2;
      count += 1;
    }
  }
  const distance = Math.sqrt(sum / Math.max(count, 1));
  return {
    distance,
    similarity: 1 / (1 + distance),
    comparedBars: length
  };
}

export function rankPatternCandidates(patterns = [], barsCount = 0) {
  return [...patterns]
    .map(pattern => {
      const age = pattern.endIndex == null ? barsCount : patternAge(pattern.endIndex, barsCount);
      const recency = Math.max(0, 1 - age / Math.max(1, DEFAULT_PATTERN_CONFIG.patternMaxAgeBars));
      const confirmationBonus = pattern.confirmed ? 0.20 : 0;
      return {
        ...pattern,
        rankScore: Number(Math.min(1, pattern.confidence * 0.65 + recency * 0.15 + confirmationBonus).toFixed(4)),
        ageBars: age
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}

/**
 * Run every deterministic detector. The caller can inspect candidates before
 * deciding whether to connect this engine to ML or order execution.
 */
export function scanForexPatterns(rawBars, options = {}) {
  const config = mergeConfig(options);
  const bars = normalizePatternBars(rawBars);
  if (bars.length < Math.max(35, config.fingerprintWindowBars + config.pivotLeft + config.pivotRight)) {
    return {
      valid: false,
      symbol: options.symbol || null,
      timeframe: options.timeframe || 'M5',
      bars: bars.length,
      patterns: [],
      pivots: [],
      levels: [],
      features: null,
      reason: 'ข้อมูลแท่งราคาไม่เพียงพอ'
    };
  }

  const { atr, trueRange } = calculateAtrSeries(bars, config.atrPeriod);
  const pivots = detectPivots(bars, atr, config);
  const levels = clusterPriceLevels(pivots, config);
  const patterns = [
    ...detectBouncePatterns(bars, pivots, atr, config),
    ...detectDoubleTopBottom(bars, pivots, atr, config),
    ...detectAbcdPatterns(bars, pivots, atr, config),
    ...detectContinuationPullbacks(bars, pivots, atr, config),
    ...detectRangeBreakouts(bars, atr, config)
  ];
  const rankedPatterns = rankPatternCandidates(patterns, bars.length);
  const pipSize = pipSizeForSymbol(options.symbol);
  const latestAtr = latestFinite(atr, latestFinite(trueRange));
  const currentPrice = bars[bars.length - 1].close;

  return {
    valid: true,
    symbol: options.symbol || null,
    timeframe: options.timeframe || 'M5',
    bars: bars.length,
    currentPrice,
    pipSize,
    atr: latestAtr,
    atrPips: latestAtr / pipSize,
    pivots,
    levels,
    patterns: rankedPatterns,
    confirmedPatterns: rankedPatterns.filter(pattern => pattern.confirmed),
    features: buildPatternFingerprint(bars, config)
  };
}

