import { EMA, RSI, MACD, BollingerBands, ATR, ADX, Stochastic } from 'technicalindicators';

/**
 * 1st-Stage Multi-Indicator Filter for Forex Currency Pairs.
 * Evaluates Dual-Track Confluence:
 * Track 1: TREND_RIDER (EMA 9/21/50 + ADX + Supertrend)
 * Track 2: SQUEEZE_BREAKOUT (Bollinger Bands Squeeze & Breakout + MACD Acceleration - Bypasses ADX lag)
 * Track 3: PULLBACK_DIP (Stochastic Oversold Cross + EMA Support)
 */

// Helper to align indicator arrays
function alignIndicator(calculated, totalLength) {
  const offset = totalLength - calculated.length;
  const full = new Array(totalLength).fill(NaN);
  for (let i = 0; i < calculated.length; i++) {
    full[offset + i] = calculated[i];
  }
  return full;
}

// Rolling mean helper
function rollingMean(arr, window) {
  const result = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += (isNaN(arr[i]) ? 0 : arr[i]);
    if (i >= window) {
      sum -= (isNaN(arr[i - window]) ? 0 : arr[i - window]);
    }
    if (i >= window - 1) {
      result[i] = sum / window;
    }
  }
  return result;
}

/**
 * Calculate Supertrend (ATR-based dynamic trend reversal)
 * Standard parameters: Period = 10, Multiplier = 3.0
 */
export function calculateSupertrend(highs, lows, closes, period = 10, multiplier = 3.0) {
  const n = closes.length;
  if (n < period) return { direction: 'NEUTRAL', value: closes[n - 1] || 0 };

  const atrCalc = ATR.calculate({ period, high: highs, low: lows, close: closes });
  const atrOffset = n - atrCalc.length;

  let upperBand = 0;
  let lowerBand = 0;
  let supertrend = 0;
  let direction = 'BUY';

  for (let i = atrOffset; i < n; i++) {
    const atrIdx = i - atrOffset;
    const curAtr = atrCalc[atrIdx] || 0;
    const hl2 = (highs[i] + lows[i]) / 2;
    let curUpper = hl2 + (multiplier * curAtr);
    let curLower = hl2 - (multiplier * curAtr);

    if (i > atrOffset) {
      if (curLower > lowerBand || closes[i - 1] < lowerBand) {
        // keep new lower
      } else {
        curLower = lowerBand;
      }
      if (curUpper < upperBand || closes[i - 1] > upperBand) {
        // keep new upper
      } else {
        curUpper = upperBand;
      }
    }

    upperBand = curUpper;
    lowerBand = curLower;

    if (i === atrOffset) {
      direction = closes[i] > curUpper ? 'BUY' : 'SELL';
      supertrend = direction === 'BUY' ? curLower : curUpper;
    } else {
      if (direction === 'BUY') {
        if (closes[i] < lowerBand) {
          direction = 'SELL';
          supertrend = upperBand;
        } else {
          supertrend = lowerBand;
        }
      } else {
        if (closes[i] > upperBand) {
          direction = 'BUY';
          supertrend = lowerBand;
        } else {
          supertrend = upperBand;
        }
      }
    }
  }

  return { direction, value: supertrend };
}

/**
 * Evaluates the Multi-Track Confluence Filter on a currency pair's bars.
 * @param {Array} pairBars Array of OHLCV bars for the currency pair
 * @param {Array} dxyBars Array of OHLCV bars for US Dollar Index (DX-Y.NYB)
 * @param {string} symbol Currency pair symbol, e.g. 'EURUSD=X'
 * @returns {Object} Filter assessment result
 */
export function evaluateForexFirstStageFilter(pairBars, dxyBars, symbol) {
  const n = pairBars ? pairBars.length : 0;
  if (n < 35) {
    return {
      qualified: false,
      bias: 'NEUTRAL',
      activeTrack: 'NONE',
      confluenceScore: 0,
      reasons: ['ข้อมูลแท่งราคาไม่เพียงพอ (< 35 bars)']
    };
  }

  const closes = pairBars.map(b => Number(b.close));
  const highs = pairBars.map(b => Number(b.high));
  const lows = pairBars.map(b => Number(b.low));

  const lastIdx = n - 1;
  const close = closes[lastIdx];

  // 1. Fast EMAs (9, 21, 50) for M5 Quick-Scalper
  const ema9Arr = alignIndicator(EMA.calculate({ period: 9, values: closes }), n);
  const ema21Arr = alignIndicator(EMA.calculate({ period: 21, values: closes }), n);
  const ema50Arr = alignIndicator(EMA.calculate({ period: 50, values: closes }), n);

  const ema9 = ema9Arr[lastIdx] || close;
  const ema21 = ema21Arr[lastIdx] || close;
  const ema50 = ema50Arr[lastIdx] || close;

  // 2. ADX (14) - Momentum Strength
  let adx14 = 20;
  try {
    const adxCalc = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const adxArr = alignIndicator(adxCalc.map(a => a.adx), n);
    adx14 = Number.isFinite(adxArr[lastIdx]) ? adxArr[lastIdx] : 20;
  } catch {}

  // 3. Bollinger Bands (20, 2) - Volatility Squeeze & Band Expansion
  const bbCalc = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const bbWidths = bbCalc.map(b => (b.upper - b.lower) / (b.middle || 1));
  const bbWidthMean20 = rollingMean(bbWidths, 20);
  const lastBbWidth = bbWidths[bbWidths.length - 1] || 0.02;
  const lastBbWidthMean = bbWidthMean20[bbWidthMean20.length - 1] || lastBbWidth;
  const lastBb = bbCalc[bbCalc.length - 1] || { upper: close * 1.01, lower: close * 0.99, middle: close };
  const prevBb = bbCalc.length > 1 ? bbCalc[bbCalc.length - 2] : lastBb;
  const isBbExpanding = lastBbWidth > lastBbWidthMean && lastBbWidth > (prevBb ? (prevBb.upper - prevBb.lower) / prevBb.middle : 0);
  const isBbUpperBreakout = close >= (lastBb.upper - 0.00005);
  const isBbLowerBreakdown = close <= (lastBb.lower + 0.00005);

  // 4. Momentum (Fast RSI 9 & MACD 12, 26, 9)
  const rsiCalc = alignIndicator(RSI.calculate({ period: 9, values: closes }), n);
  const rsi9 = Number.isFinite(rsiCalc[lastIdx]) ? rsiCalc[lastIdx] : 50;

  const macdCalc = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const macdHist = macdCalc.length > 0 ? (macdCalc[macdCalc.length - 1].histogram ?? 0) : 0;
  const prevMacdHist = macdCalc.length > 1 ? (macdCalc[macdCalc.length - 2].histogram ?? 0) : 0;

  // 5. ATR 14
  const atrCalc = alignIndicator(ATR.calculate({ period: 14, high: highs, low: lows, close: closes }), n);
  const atr14 = atrCalc[lastIdx] || (close * 0.005);

  // 6. Stochastic Oscillator (14, 3, 3) - Pullback & Dip Timing
  let stochK = 50;
  let stochD = 50;
  let stochPrevK = 50;
  let stochPrevD = 50;
  try {
    const stochCalc = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
    if (stochCalc.length > 0) {
      const cur = stochCalc[stochCalc.length - 1];
      const prev = stochCalc.length > 1 ? stochCalc[stochCalc.length - 2] : cur;
      stochK = Number(cur.k || 50);
      stochD = Number(cur.d || 50);
      stochPrevK = Number(prev.k || 50);
      stochPrevD = Number(prev.d || 50);
    }
  } catch {}

  const stochCrossUp = stochPrevK <= stochPrevD && stochK > stochD && stochK < 45;
  const stochCrossDown = stochPrevK >= stochPrevD && stochK < stochD && stochK > 55;

  // 7. Supertrend (10, 3) - Dynamic Trend Regime
  const supertrend = calculateSupertrend(highs, lows, closes, 10, 3.0);
  const stDirection = supertrend.direction; // 'BUY' | 'SELL'

  // 8. Macro Dollar Index (DXY) Trend
  let dxyTrend = 'NEUTRAL';
  if (dxyBars && dxyBars.length >= 30) {
    const dxyCloses = dxyBars.map(b => Number(b.close));
    const dxyEma50Arr = alignIndicator(EMA.calculate({ period: 50, values: dxyCloses }), dxyCloses.length);
    const lastDxyClose = dxyCloses[dxyCloses.length - 1];
    const lastDxyEma50 = dxyEma50Arr[dxyCloses.length - 1] || lastDxyClose;

    if (lastDxyClose > lastDxyEma50) dxyTrend = 'BULLISH';
    else if (lastDxyClose < lastDxyEma50) dxyTrend = 'BEARISH';
  }

  // ================= ANTI-ENTANGLEMENT (CHOP PREVENTION) =================
  const isDeadMarket = adx14 < 13;
  const emaSepRatio = Math.abs(ema9 - ema21) / (atr14 || 1e-5);
  const ema50Distance = Math.abs(close - ema50) / (atr14 || 1e-5);
  const isEmaEntangled = (emaSepRatio < 0.18) && (ema50Distance < 0.25);

  const isAboveEma50 = close > ema50 && (close - ema50) >= (0.20 * atr14);
  const isBelowEma50 = close < ema50 && (ema50 - close) >= (0.20 * atr14);

  // ================= MULTI-TRACK EVALUATION =================
  // Track 1: Trend Rider (Classic Trend Alignment)
  const isTrendRiderBuy = !isEmaEntangled && isAboveEma50 && (ema9 > ema21) && stDirection === 'BUY' && adx14 >= 20;
  const isTrendRiderSell = !isEmaEntangled && isBelowEma50 && (ema9 < ema21) && stDirection === 'SELL' && adx14 >= 20;

  // Track 2: Squeeze Breakout (Bollinger Bands + MACD Early Expansion - Bypasses ADX lag!)
  const isMacdExpandingBuy = macdHist > 0 && (prevMacdHist <= 0 || macdHist > prevMacdHist * 1.05);
  const isMacdExpandingSell = macdHist < 0 && (prevMacdHist >= 0 || macdHist < prevMacdHist * 1.05);
  const isSqueezeBreakoutBuy = isBbExpanding && isBbUpperBreakout && isMacdExpandingBuy && stDirection === 'BUY';
  const isSqueezeBreakoutSell = isBbExpanding && isBbLowerBreakdown && isMacdExpandingSell && stDirection === 'SELL';

  // Track 3: Pullback Dip (Stochastic Oversold / Support Bounce)
  const isPullbackDipBuy = isAboveEma50 && (ema9 >= ema21 || Math.abs(close - ema21) <= 1.2 * atr14) && stochCrossUp;
  const isPullbackDipSell = isBelowEma50 && (ema9 <= ema21 || Math.abs(close - ema21) <= 1.2 * atr14) && stochCrossDown;

  // ================= CONFLUENCE SCORING (0 - 100) =================
  let buyScore = 0;
  let sellScore = 0;

  // EMA Structure (Max 25 pts)
  if (close > ema50 && ema9 > ema21) buyScore += 25;
  if (close < ema50 && ema9 < ema21) sellScore += 25;

  // Supertrend Alignment (Max 25 pts)
  if (stDirection === 'BUY') buyScore += 25;
  if (stDirection === 'SELL') sellScore += 25;

  // MACD Momentum (Max 20 pts)
  if (macdHist > 0) buyScore += isMacdExpandingBuy ? 20 : 12;
  if (macdHist < 0) sellScore += isMacdExpandingSell ? 20 : 12;

  // Bollinger Bands Expansion (Max 15 pts)
  if (isBbExpanding && isBbUpperBreakout) buyScore += 15;
  else if (isBbExpanding && close > lastBb.middle) buyScore += 8;

  if (isBbExpanding && isBbLowerBreakdown) sellScore += 15;
  else if (isBbExpanding && close < lastBb.middle) sellScore += 8;

  // RSI & Stochastic Momentum Health (Max 15 pts)
  if (rsi9 >= 45 && rsi9 <= 75) buyScore += 8;
  if (stochK > stochD || stochCrossUp) buyScore += 7;

  if (rsi9 >= 25 && rsi9 <= 55) sellScore += 8;
  if (stochK < stochD || stochCrossDown) sellScore += 7;

  // ================= MACRO DXY DIRECTIONAL CALIBRATION =================
  const cleanSym = String(symbol || '').replace('=X', '').toUpperCase();
  const isUsdQuote = ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD'].includes(cleanSym);
  const isUsdBase = ['USDJPY', 'USDCHF', 'USDCAD'].includes(cleanSym);

  // Determine if BUY or SELL is counter-trend against DXY
  let isBuyCounterTrend = false;
  let isSellCounterTrend = false;
  if (dxyTrend === 'BULLISH') {
    if (isUsdQuote) isBuyCounterTrend = true;
    if (isUsdBase) isSellCounterTrend = true;
  } else if (dxyTrend === 'BEARISH') {
    if (isUsdQuote) isSellCounterTrend = true;
    if (isUsdBase) isBuyCounterTrend = true;
  }

  const dataHarvestLiveMode = process.env.FOREX_DATA_HARVEST_LIVE_MODE === 'true';
  const dataHarvestMinScore = Math.max(
    0,
    Number(process.env.FOREX_DATA_HARVEST_MIN_CONFLUENCE_SCORE || 55)
  );
  const minBuyScore = dataHarvestLiveMode
    ? dataHarvestMinScore
    : (isBuyCounterTrend ? 70 : 55);
  const minSellScore = dataHarvestLiveMode
    ? dataHarvestMinScore
    : (isSellCounterTrend ? 70 : 55);

  // ================= SELECTION & REASONS =================
  const reasons = [];
  let bias = 'NEUTRAL';
  let activeTrack = 'NONE';
  let confluenceScore = 0;
  let qualified = false;

  if (isDeadMarket && !dataHarvestLiveMode) {
    reasons.push(`🚫 กรองทิ้ง: ADX ต่ำมาก (${adx14.toFixed(1)} < 13) ตลาดไม่มีสภาพคล่อง`);
  } else if (!dataHarvestLiveMode && isEmaEntangled && !isSqueezeBreakoutBuy && !isSqueezeBreakoutSell) {
    reasons.push(`🚫 กรองทิ้ง: เส้น EMA9/21/50 พันกันนิ่งในตลาด Sideway (EMA Sep: ${emaSepRatio.toFixed(2)}x ATR < 0.18x)`);
  } else if (buyScore >= minBuyScore && buyScore > sellScore) {
    bias = 'BUY';
    confluenceScore = buyScore;
    qualified = true;

    if (isSqueezeBreakoutBuy) activeTrack = 'SQUEEZE_BREAKOUT';
    else if (isPullbackDipBuy) activeTrack = 'PULLBACK_DIP';
    else if (isTrendRiderBuy) activeTrack = 'TREND_RIDER';
    else activeTrack = 'CONFLUENCE_BUY';

    reasons.push(`📈 [${activeTrack}] คะแนนสอดคล้อง ${confluenceScore}/100 | Supertrend: BUY | RSI: ${rsi9.toFixed(1)} | ADX: ${adx14.toFixed(1)}`);
    if (isSqueezeBreakoutBuy) reasons.push(`⚡ Bollinger Bands ระเบิดกรอบบน (Width ขยายตัว) + MACD เร่งตัว`);
    if (isPullbackDipBuy) reasons.push(`🎯 Stochastic Oversold Cross (${stochK.toFixed(1)} > ${stochD.toFixed(1)}) จบการพักตัว`);
    if (dxyTrend !== 'NEUTRAL') reasons.push(`🌐 Macro DXY: ${dxyTrend} ${isBuyCounterTrend ? '(สวนเทรนด์-ผ่านเกณฑ์เข้มงวด 70pt)' : '(ตามเทรนด์ใหญ่)'}`);
  } else if (sellScore >= minSellScore && sellScore > buyScore) {
    bias = 'SELL';
    confluenceScore = sellScore;
    qualified = true;

    if (isSqueezeBreakoutSell) activeTrack = 'SQUEEZE_BREAKOUT';
    else if (isPullbackDipSell) activeTrack = 'PULLBACK_DIP';
    else if (isTrendRiderSell) activeTrack = 'TREND_RIDER';
    else activeTrack = 'CONFLUENCE_SELL';

    reasons.push(`📉 [${activeTrack}] คะแนนสอดคล้อง ${confluenceScore}/100 | Supertrend: SELL | RSI: ${rsi9.toFixed(1)} | ADX: ${adx14.toFixed(1)}`);
    if (isSqueezeBreakoutSell) reasons.push(`⚡ Bollinger Bands ระเบิดกรอบล่าง (Width ขยายตัว) + MACD กดตัว`);
    if (isPullbackDipSell) reasons.push(`🎯 Stochastic Overbought Cross (${stochK.toFixed(1)} < ${stochD.toFixed(1)}) จบการรีบาวด์`);
    if (dxyTrend !== 'NEUTRAL') reasons.push(`🌐 Macro DXY: ${dxyTrend} ${isSellCounterTrend ? '(สวนเทรนด์-ผ่านเกณฑ์เข้มงวด 70pt)' : '(ตามเทรนด์ใหญ่)'}`);
  } else {
    reasons.push(`🚫 กรองทิ้ง: คะแนนสอดคล้องไม่เพียงพอ (Buy: ${buyScore}/${minBuyScore}, Sell: ${sellScore}/${minSellScore})`);
  }

  return {
    qualified,
    bias,
    activeTrack,
    confluenceScore,
    reasons,
    indicators: {
      close,
      ema9,
      ema21,
      ema50,
      ema20: ema21,
      ema200: ema50,
      adx14,
      rsi14: rsi9,
      macdHist,
      atr14,
      dxyTrend,
      supertrend,
      stochK,
      stochD,
      bbWidth: lastBbWidth,
      isBbExpanding,
      rsiSeries: rsiCalc,
      atrSeries: atrCalc
    }
  };
}
