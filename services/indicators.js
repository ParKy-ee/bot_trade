import { EMA, RSI, MACD, BollingerBands, ATR, ADX } from 'technicalindicators';

/**
 * Calculates all technical indicators and features required by the AI Swing Trading Model.
 * Matches feature columns of dynamic_trailing_model.joblib exactly.
 */

// Helper for rolling mean
function rollingMean(arr, window) {
  const result = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= window) {
      sum -= arr[i - window];
    }
    if (i >= window - 1) {
      result[i] = sum / window;
    }
  }
  return result;
}

// Helper for rolling max
function rollingMax(arr, window) {
  const result = new Array(arr.length).fill(NaN);
  for (let i = window - 1; i < arr.length; i++) {
    let m = -Infinity;
    for (let j = i - window + 1; j <= i; j++) {
      if (arr[j] > m) m = arr[j];
    }
    result[i] = m;
  }
  return result;
}

// Helper for percentage change
function pctChange(arr, periods = 1) {
  const result = new Array(arr.length).fill(NaN);
  for (let i = periods; i < arr.length; i++) {
    const prev = arr[i - periods];
    if (prev !== 0 && !isNaN(prev)) {
      result[i] = (arr[i] - prev) / prev;
    }
  }
  return result;
}

// Helper to align indicator array of length <= n to match original series
function alignIndicator(calculated, totalLength) {
  const offset = totalLength - calculated.length;
  const full = new Array(totalLength).fill(NaN);
  for (let i = 0; i < calculated.length; i++) {
    full[offset + i] = calculated[i];
  }
  return full;
}

export function calculateIndicators(rawBars, spyBars) {
  // rawBars: array of { time, open, high, low, close, volume } sorted ascending
  const n = rawBars.length;
  if (n < 30) return null;

  const closes = rawBars.map(b => Number(b.close));
  const highs = rawBars.map(b => Number(b.high));
  const lows = rawBars.map(b => Number(b.low));
  const volumes = rawBars.map(b => Number(b.volume));

  // SPY calculations
  let marketBullish = true;
  let spyRet20d = 0;
  if (spyBars && spyBars.length >= 30) {
    const spyCloses = spyBars.map(b => Number(b.close));
    const spyEma50Values = alignIndicator(EMA.calculate({ period: 50, values: spyCloses }), spyCloses.length);
    const spyEma200Values = alignIndicator(EMA.calculate({ period: 200, values: spyCloses }), spyCloses.length);
    const spyPct20 = pctChange(spyCloses, 20);

    const lastIdx = spyCloses.length - 1;
    const lastSpyClose = spyCloses[lastIdx];
    const lastSpyEma50 = spyEma50Values[lastIdx] || 0;
    const lastSpyEma200 = spyEma200Values[lastIdx] || 0;

    marketBullish = (lastSpyClose > lastSpyEma200) && (lastSpyEma50 > lastSpyEma200);
    spyRet20d = Number.isFinite(spyPct20[lastIdx]) ? spyPct20[lastIdx] : 0;
  }

  // Symbol Indicators
  const ret1d = pctChange(closes, 1);
  const ret5d = pctChange(closes, 5);
  const ret20d = pctChange(closes, 20);

  // RSI 14
  const rsiCalc = RSI.calculate({ period: 14, values: closes });
  const rsi14 = alignIndicator(rsiCalc, n);

  // ROC 12: ((close - close_12) / close_12) * 100
  const roc12 = pctChange(closes, 12).map(v => isNaN(v) ? NaN : v * 100);

  // MACD (12, 26, 9)
  const macdCalc = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const macdOffset = n - macdCalc.length;
  const macdLine = new Array(n).fill(NaN);
  const macdSignal = new Array(n).fill(NaN);
  const macdHist = new Array(n).fill(NaN);
  for (let i = 0; i < macdCalc.length; i++) {
    macdLine[macdOffset + i] = macdCalc[i].MACD ?? NaN;
    macdSignal[macdOffset + i] = macdCalc[i].signal ?? NaN;
    macdHist[macdOffset + i] = macdCalc[i].histogram ?? NaN;
  }

  // EMAs (20, 50, 200)
  const ema20 = alignIndicator(EMA.calculate({ period: 20, values: closes }), n);
  const ema50 = alignIndicator(EMA.calculate({ period: 50, values: closes }), n);
  const ema200 = alignIndicator(EMA.calculate({ period: 200, values: closes }), n);

  // ATR 14
  const atrCalc = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atr14 = alignIndicator(atrCalc, n);
  const atr50mean = rollingMean(atr14.map(v => isNaN(v) ? 0 : v), 50);

  // Bollinger Bands (20, 2)
  const bbCalc = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const bbOffset = n - bbCalc.length;
  const bbPband = new Array(n).fill(NaN);
  const bbWidth = new Array(n).fill(NaN);
  for (let i = 0; i < bbCalc.length; i++) {
    const { upper, lower, middle } = bbCalc[i];
    const range = (upper - lower) || 1e-12;
    bbPband[bbOffset + i] = (closes[bbOffset + i] - lower) / range;
    bbWidth[bbOffset + i] = (upper - lower) / (middle || 1e-12);
  }

  // ADX 14
  let adx14 = new Array(n).fill(NaN);
  try {
    const adxCalc = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const adxOffset = n - adxCalc.length;
    for (let i = 0; i < adxCalc.length; i++) {
      adx14[adxOffset + i] = adxCalc[i].adx ?? NaN;
    }
  } catch {
    // fallback if ADX calculation fails
  }

  // Volume MA 20 & RVOL
  const volMa20 = rollingMean(volumes, 20);
  const highest20 = rollingMax(highs, 20);

  const lastIdx = n - 1;
  const lastClose = closes[lastIdx];
  const lastEma20 = ema20[lastIdx] || lastClose;
  const lastEma50 = ema50[lastIdx] || lastClose;
  const lastEma200 = ema200[lastIdx] || lastClose;
  const lastAtr = atr14[lastIdx] || (lastClose * 0.02);
  const lastAtrMean = atr50mean[lastIdx] || lastAtr;
  const lastVolMa = volMa20[lastIdx] || volumes[lastIdx] || 1;
  const lastHigh20 = highest20[lastIdx] || highs[lastIdx];

  const distEma20 = (lastClose - lastEma20) / (lastEma20 + 1e-12);
  const distEma50 = (lastClose - lastEma50) / (lastEma50 + 1e-12);
  const distEma200 = (lastClose - lastEma200) / (lastEma200 + 1e-12);
  const emaTrendRatio = lastEma20 / (lastEma50 + 1e-12);
  const atrRatio = lastAtr / (lastAtrMean + 1e-12);
  const rvol = (volumes[lastIdx] || 0) / (lastVolMa + 1e-12);
  const distTo20dHigh = (lastHigh20 - lastClose) / (lastClose + 1e-12);
  const lastRet20d = Number.isFinite(ret20d[lastIdx]) ? ret20d[lastIdx] : 0;
  const rs20d = lastRet20d - spyRet20d;

  return {
    time: rawBars[lastIdx].time,
    open: rawBars[lastIdx].open,
    high: rawBars[lastIdx].high,
    low: rawBars[lastIdx].low,
    close: lastClose,
    volume: volumes[lastIdx],
    rsi_14: Number.isFinite(rsi14[lastIdx]) ? rsi14[lastIdx] : 50,
    atr_14: lastAtr,
    market_bullish: marketBullish,
    rs_20d: rs20d,
    features: {
      return_1d: Number.isFinite(ret1d[lastIdx]) ? ret1d[lastIdx] : 0,
      return_5d: Number.isFinite(ret5d[lastIdx]) ? ret5d[lastIdx] : 0,
      return_20d: lastRet20d,
      rsi_14: Number.isFinite(rsi14[lastIdx]) ? rsi14[lastIdx] : 50,
      roc_12: Number.isFinite(roc12[lastIdx]) ? roc12[lastIdx] : 0,
      macd_line: Number.isFinite(macdLine[lastIdx]) ? macdLine[lastIdx] : 0,
      macd_signal: Number.isFinite(macdSignal[lastIdx]) ? macdSignal[lastIdx] : 0,
      macd_hist: Number.isFinite(macdHist[lastIdx]) ? macdHist[lastIdx] : 0,
      dist_ema_20: distEma20,
      dist_ema_50: distEma50,
      dist_ema_200: distEma200,
      ema_trend_ratio: emaTrendRatio,
      atr_14: lastAtr,
      atr_ratio: atrRatio,
      bb_pband: Number.isFinite(bbPband[lastIdx]) ? bbPband[lastIdx] : 0.5,
      bb_width: Number.isFinite(bbWidth[lastIdx]) ? bbWidth[lastIdx] : 0.05,
      adx_14: Number.isFinite(adx14[lastIdx]) ? adx14[lastIdx] : 20,
      rvol: rvol,
      dist_to_20d_high: distTo20dHigh,
      rs_20d: rs20d
    }
  };
}
