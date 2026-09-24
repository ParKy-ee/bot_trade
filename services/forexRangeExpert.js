/**
 * Range/mean-reversion setup detector and feature builder.
 * This path is deliberately separate from the trend-oriented Forex models.
 */

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

function sampleStd(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const avg = mean(valid);
  return Math.sqrt(valid.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (valid.length - 1));
}

function getAt(values, offsetFromEnd, fallback = 0) {
  const index = values.length - 1 - offsetFromEnd;
  return index >= 0 && Number.isFinite(values[index]) ? values[index] : fallback;
}

export function evaluateRangeExpertSetup(bars = [], indicators = {}, symbol = '') {
  if (!Array.isArray(bars) || bars.length < 45) {
    return { eligible: false, action: null, score: 0, features: null, reason: 'bars_not_ready' };
  }

  const closes = bars.map(b => Number(b.close));
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const opens = bars.map(b => Number(b.open));
  const n = bars.length - 1;
  const close = closes[n];
  const atr = Number(indicators.atr14 || close * 0.005);
  const adx = Number(indicators.adx14 || 20);
  const ema21 = Number(indicators.ema21 || close);
  const ema50 = Number(indicators.ema50 || close);
  const rsi = Number(indicators.rsi14 || 50);
  const macdHist = Number(indicators.macdHist || 0);
  const isJpy = String(symbol).toUpperCase().includes('JPY') ? 1 : 0;

  const recentCloses = closes.slice(Math.max(0, n - 19), n + 1);
  const recentHighsExcludingCurrent = highs.slice(Math.max(0, n - 20), n);
  const recentLowsExcludingCurrent = lows.slice(Math.max(0, n - 20), n);
  if (recentCloses.length < 20 || recentHighsExcludingCurrent.length < 15) {
    return { eligible: false, action: null, score: 0, features: null, reason: 'range_window_not_ready' };
  }

  const mid20 = mean(recentCloses);
  const std20 = sampleStd(recentCloses);
  const bbWidth = (4 * std20) / (mid20 || 1);
  const bbWidths = [];
  for (let i = 19; i < closes.length; i++) {
    const window = closes.slice(i - 19, i + 1);
    bbWidths.push((4 * sampleStd(window)) / (mean(window) || 1));
  }
  const bbWidthMean20 = mean(bbWidths.slice(-20));
  const bbWidthRatio = bbWidth / (bbWidthMean20 || bbWidth || 1);
  const rangeHigh20 = Math.max(...recentHighsExcludingCurrent);
  const rangeLow20 = Math.min(...recentLowsExcludingCurrent);
  const rangePosition = (close - rangeLow20) / ((rangeHigh20 - rangeLow20) || 1e-12);
  const distanceToMidAtr = (close - mid20) / (atr || 1e-12);
  const move10 = Math.abs(close - getAt(closes, 10, close));
  let path10 = 0;
  for (let i = Math.max(1, n - 9); i <= n; i++) path10 += Math.abs(closes[i] - closes[i - 1]);
  const efficiency = move10 / (path10 || 1e-12);
  const candleRange = Math.max(1e-12, highs[n] - lows[n]);
  const upperWickPct = (highs[n] - Math.max(opens[n], closes[n])) / candleRange;
  const lowerWickPct = (Math.min(opens[n], closes[n]) - lows[n]) / candleRange;
  const emaAtr = Math.abs(ema21 - ema50) / (atr || 1e-12);

  const eligible = adx < 24 && emaAtr < 0.50 && bbWidthRatio < 1.20 && efficiency < 0.50
    && rangePosition >= 0 && rangePosition <= 1;
  const buyCandidate = eligible && rangePosition <= 0.35 && rsi <= 45;
  const sellCandidate = eligible && rangePosition >= 0.65 && rsi >= 55;
  const action = buyCandidate ? 'BUY' : (sellCandidate ? 'SELL' : null);
  const score = action === 'BUY'
    ? 30 + (rangePosition <= 0.20 ? 20 : 10) + (rsi <= 35 ? 20 : 10) + (lowerWickPct >= 0.30 ? 15 : 0) + (macdHist >= 0 ? 15 : 0)
    : action === 'SELL'
      ? 30 + (rangePosition >= 0.80 ? 20 : 10) + (rsi >= 65 ? 20 : 10) + (upperWickPct >= 0.30 ? 15 : 0) + (macdHist <= 0 ? 15 : 0)
      : 0;

  return {
    eligible,
    action,
    score,
    rangePosition,
    reason: action ? `RANGE ${action} | position ${(rangePosition * 100).toFixed(1)}% | ADX ${adx.toFixed(1)} | RSI ${rsi.toFixed(1)}` : 'no_range_extreme',
    features: action ? {
      rsi_14: rsi,
      adx_14: adx,
      atr_pct: atr / (close || 1),
      ema_spread_20_50: (ema21 - ema50) / (close || 1),
      macd_hist: macdHist,
      range_position: rangePosition,
      distance_to_mid_atr: distanceToMidAtr,
      bb_width: bbWidth,
      bb_width_ratio: bbWidthRatio,
      efficiency_ratio: efficiency,
      upper_wick_pct: upperWickPct,
      lower_wick_pct: lowerWickPct,
      is_jpy: isJpy,
      direction: action
    } : null
  };
}
