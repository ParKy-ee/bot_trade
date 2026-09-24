/**
 * Forex Price Action & Pattern Analytics
 * 
 * Provides:
 * 1. Overextended Guard: Detects momentum exhaustion (|Close - EMA21| > 1.8 ATR & RSI extreme)
 * 2. Compression Breakout Gate: Detects coiled pattern breakdowns/breakouts without pullback
 * 3. Rejection Candlestick Filter: Vetoes entries if long rejection wicks (>= 40%) appear at S/R
 * 4. Pullback Entry Calculation: Calculates optimal Limit Order levels (EMA 21 / Structural S/R)
 */

/**
 * Check if market is overextended far from EMA 21.
 * Distance > 1.8 * ATR combined with RSI extreme (< 32 for SELL, > 68 for BUY).
 */
export function checkOverextension(bars = [], indicators = {}, bias = 'SELL') {
  if (!bars || bars.length < 5 || !indicators) {
    return { isOverextended: false, distanceAtr: 0 };
  }

  const latestBar = bars[bars.length - 1];
  const close = Number(latestBar.close);
  const ema21 = Number(indicators.ema21);
  const atr = Number(indicators.atr14 || indicators.atr);
  const rsi = Number(indicators.rsi14 || indicators.rsi);

  if (!Number.isFinite(close) || !Number.isFinite(ema21) || !Number.isFinite(atr) || atr <= 0) {
    return { isOverextended: false, distanceAtr: 0 };
  }

  const distanceAtr = Math.abs(close - ema21) / atr;
  const isSell = bias.toUpperCase() === 'SELL';
  const isBuy = bias.toUpperCase() === 'BUY';

  // Distance threshold: 2.4x ATR (calibrated from 1.8 to avoid skipping healthy momentum)
  const DISTANCE_THRESHOLD = Number(process.env.FOREX_OVEREXTENDED_DISTANCE_ATR || 2.4);
  const RSI_BUY_OVERBOUGHT = Number(process.env.FOREX_OVEREXTENDED_RSI_BUY || 78);
  const RSI_SELL_OVERSOLD = Number(process.env.FOREX_OVEREXTENDED_RSI_SELL || 22);

  if (isSell && (ema21 - close) > (DISTANCE_THRESHOLD * atr) && rsi < RSI_SELL_OVERSOLD) {
    return {
      isOverextended: true,
      bias: 'SELL',
      distanceAtr: Number(distanceAtr.toFixed(2)),
      rsi: Number(rsi.toFixed(1)),
      close,
      ema21,
      atr,
      reason: `ราคาขายยืดตัวห่าง EMA21 ถึง ${distanceAtr.toFixed(2)}x ATR ร่วมกับ RSI ${rsi.toFixed(1)} < ${RSI_SELL_OVERSOLD} (เสี่ยงขายก้นเหว)`
    };
  }

  if (isBuy && (close - ema21) > (DISTANCE_THRESHOLD * atr) && rsi > RSI_BUY_OVERBOUGHT) {
    return {
      isOverextended: true,
      bias: 'BUY',
      distanceAtr: Number(distanceAtr.toFixed(2)),
      rsi: Number(rsi.toFixed(1)),
      close,
      ema21,
      atr,
      reason: `ราคาซื้อยืดตัวห่าง EMA21 ถึง ${distanceAtr.toFixed(2)}x ATR ร่วมกับ RSI ${rsi.toFixed(1)} > ${RSI_BUY_OVERBOUGHT} (เสี่ยงซื้อยอดดอย)`
    };
  }

  return {
    isOverextended: false,
    bias,
    distanceAtr: Number(distanceAtr.toFixed(2)),
    rsi: Number.isFinite(rsi) ? Number(rsi.toFixed(1)) : null
  };
}

/**
 * Check for Rejection Candlesticks (Pinbar, Hammer, Doji with >= 40% wick).
 * Vetoes entry if rejection is opposing our bias.
 */
export function checkRejectionCandle(bars = [], bias = 'SELL', atr = 0) {
  if (process.env.FOREX_REJECTION_FILTER_ENABLED === 'false') {
    return { hasRejection: false };
  }
  if (!bars || bars.length < 3) {
    return { hasRejection: false };
  }

  const threshold = Number(process.env.FOREX_REJECTION_WICK_THRESHOLD || 50.0);

  // Check the last completed bar and current bar
  const checkBars = bars.slice(-2);

  for (let i = 0; i < checkBars.length; i++) {
    const isCurrentBar = (i === checkBars.length - 1);
    const b = checkBars[i];
    const high = Number(b.high);
    const low = Number(b.low);
    const open = Number(b.open);
    const close = Number(b.close);
    const range = high - low;

    if (!Number.isFinite(range) || range <= 0) continue;
    // Skip current bar if it has barely started forming (< 40% of typical ATR)
    if (isCurrentBar && atr > 0 && range < atr * 0.4) continue;

    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const lowerWickPct = (lowerWick / range) * 100;
    const upperWickPct = (upperWick / range) * 100;

    // For SELL: Reject if lower wick >= threshold (buyers rejecting lower prices / Hammer / Pinbar)
    if (bias.toUpperCase() === 'SELL' && lowerWickPct >= threshold) {
      return {
        hasRejection: true,
        bias: 'SELL',
        rejectionWickPct: Number(lowerWickPct.toFixed(1)),
        candleTime: b.time,
        barIndex: isCurrentBar ? 'current' : 'previous',
        reason: `พบแท่งเทียนไส้ล่างยาว ${lowerWickPct.toFixed(1)}% ที่แนวรับ (แรงซื้อดีดกลับ ป้องกันการโดนกวาด Stop Hunt)`
      };
    }

    // For BUY: Reject if upper wick >= threshold (sellers rejecting higher prices / Shooting Star)
    if (bias.toUpperCase() === 'BUY' && upperWickPct >= threshold) {
      return {
        hasRejection: true,
        bias: 'BUY',
        rejectionWickPct: Number(upperWickPct.toFixed(1)),
        candleTime: b.time,
        barIndex: isCurrentBar ? 'current' : 'previous',
        reason: `พบแท่งเทียนไส้บนยาว ${upperWickPct.toFixed(1)}% ที่แนวต้าน (แรงขายกดกลับ ป้องกันการโดนกวาด Stop Hunt)`
      };
    }
  }

  return { hasRejection: false };
}

/**
 * Check if price has formed a Volatility Compression Pattern (Descending Triangle,
 * Bear Flag, Rising Wedge, Symmetrical Triangle) for >= 10 bars, and is currently
 * breaking out cleanly.
 */
export function checkCompressionBreakout(bars = [], bias = 'SELL', atr = 0) {
  if (!bars || bars.length < 15) {
    return { isCompressionBreakout: false };
  }

  // Look back at previous 10 to 20 bars (excluding current breakout bar)
  const lookback = Math.min(20, bars.length - 1);
  const consolidationBars = bars.slice(-(lookback + 1), -1);
  const currentBar = bars[bars.length - 1];

  if (consolidationBars.length < 10) {
    return { isCompressionBreakout: false };
  }

  const highs = consolidationBars.map(b => Number(b.high)).filter(Number.isFinite);
  const lows = consolidationBars.map(b => Number(b.low)).filter(Number.isFinite);

  if (highs.length < 10 || lows.length < 10) {
    return { isCompressionBreakout: false };
  }

  const patternHigh = Math.max(...highs);
  const patternLow = Math.min(...lows);
  const patternRange = patternHigh - patternLow;

  const curClose = Number(currentBar.close);
  const curHigh = Number(currentBar.high);
  const curLow = Number(currentBar.low);
  const curOpen = Number(currentBar.open);
  const curRange = curHigh - curLow;

  if (curRange <= 0) {
    return { isCompressionBreakout: false };
  }

  const curUpperWick = curHigh - Math.max(curOpen, curClose);
  const curLowerWick = Math.min(curOpen, curClose) - curLow;
  const curUpperWickPct = (curUpperWick / curRange) * 100;
  const curLowerWickPct = (curLowerWick / curRange) * 100;

  // 1. Bearish Breakdown (SELL)
  if (bias.toUpperCase() === 'SELL') {
    // Current bar closed below the consolidation support floor
    const isBreakdown = curClose < patternLow;
    // Lower wick must be < 30% of candle range (strong momentum body, no bottom rejection)
    const cleanClose = curLowerWickPct < 30.0;

    // Count tests of support floor (lows within 0.25 * patternRange from patternLow)
    const threshold = patternLow + (patternRange * 0.25);
    const supportTests = lows.filter(l => l <= threshold).length;

    if (isBreakdown && cleanClose && supportTests >= 2) {
      return {
        isCompressionBreakout: true,
        bias: 'SELL',
        patternType: 'SUPPORT_BREAKDOWN_COMPRESSION',
        consolidationBars: consolidationBars.length,
        patternHigh,
        patternLow,
        supportTests,
        breakoutPrice: curClose,
        breakoutWickPct: Number(curLowerWickPct.toFixed(1)),
        slAnchorPrice: patternHigh,
        reason: `ทะลุกรอบสะสมพลัง (${consolidationBars.length} แท่ง, ทดสอบแนวรับ ${supportTests} ครั้ง) แท่งเบรคไส้ล่างสั้น ${curLowerWickPct.toFixed(1)}% < 30%`
      };
    }
  }

  // 2. Bullish Breakout (BUY)
  if (bias.toUpperCase() === 'BUY') {
    // Current bar closed above the consolidation resistance ceiling
    const isBreakout = curClose > patternHigh;
    // Upper wick must be < 30% of candle range (strong momentum body, no top rejection)
    const cleanClose = curUpperWickPct < 30.0;

    // Count tests of resistance ceiling
    const threshold = patternHigh - (patternRange * 0.25);
    const resistanceTests = highs.filter(h => h >= threshold).length;

    if (isBreakout && cleanClose && resistanceTests >= 2) {
      return {
        isCompressionBreakout: true,
        bias: 'BUY',
        patternType: 'RESISTANCE_BREAKOUT_COMPRESSION',
        consolidationBars: consolidationBars.length,
        patternHigh,
        patternLow,
        resistanceTests,
        breakoutPrice: curClose,
        breakoutWickPct: Number(curUpperWickPct.toFixed(1)),
        slAnchorPrice: patternLow,
        reason: `ทะลุกรอบสะสมพลัง (${consolidationBars.length} แท่ง, ทดสอบแนวต้าน ${resistanceTests} ครั้ง) แท่งเบรคไส้บนสั้น ${curUpperWickPct.toFixed(1)}% < 30%`
      };
    }
  }

  return { isCompressionBreakout: false };
}

/**
 * Calculate optimal Pullback Limit Entry level (EMA 21 or near dynamic resistance).
 */
export function calculatePullbackLevel(indicators = {}, bias = 'SELL', currPrice = 0, pipSize = 0.0001) {
  const ema21 = Number(indicators.ema21);
  const ema9 = Number(indicators.ema9);
  const atr = Number(indicators.atr14 || indicators.atr || 0);
  const isSell = bias.toUpperCase() === 'SELL';

  if (!Number.isFinite(ema9) || ema9 <= 0) {
    return { pullbackPrice: currPrice, method: 'MARKET_FALLBACK' };
  }

  // Instead of setting limit far down at (EMA9+EMA21)/2 which never gets filled in strong trends,
  // target EMA9 or a shallow retracement (0.35 * ATR) from current price
  if (isSell) {
    const shallowRetrace = atr > 0 ? currPrice + (0.35 * atr) : ema9;
    const target = Number.isFinite(ema9) && ema9 > currPrice ? Math.min(ema9, shallowRetrace) : shallowRetrace;
    return {
      pullbackPrice: Math.max(currPrice, target),
      method: 'EMA9_PULLBACK_LIMIT',
      pipsFromCurrent: Math.round((Math.max(currPrice, target) - currPrice) / pipSize)
    };
  }

  // For BUY: We wait for price to micro-retrace to EMA 9 or shallow retracement
  const shallowRetrace = atr > 0 ? currPrice - (0.35 * atr) : ema9;
  const target = Number.isFinite(ema9) && ema9 < currPrice ? Math.max(ema9, shallowRetrace) : shallowRetrace;
  return {
    pullbackPrice: Math.min(currPrice, target),
    method: 'EMA9_PULLBACK_LIMIT',
    pipsFromCurrent: Math.round((currPrice - Math.min(currPrice, target)) / pipSize)
  };
}
