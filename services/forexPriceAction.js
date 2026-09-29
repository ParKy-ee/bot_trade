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

/**
 * Check for Regular RSI Divergence (Bullish or Bearish).
 * 
 * Bearish Divergence: Price Higher High (HH), RSI Lower High (LH) -> Signals Bearish Reversal / Distribution.
 * Bullish Divergence: Price Lower Low (LL), RSI Higher Low (HL) -> Signals Bullish Reversal / Accumulation.
 */
export function checkRsiDivergence(bars = [], rsiSeries = [], bias = 'BUY') {
  if (!bars || bars.length < 20 || !rsiSeries || rsiSeries.length < 15) {
    return { hasDivergence: false };
  }
  const isSell = bias.toUpperCase() === 'SELL';
  const isBuy = bias.toUpperCase() === 'BUY';

  const offset = bars.length - rsiSeries.length;
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));

  const lookbackStart = Math.max(2, bars.length - 28);
  const lookbackEnd = bars.length - 1;

  // 1. Bearish Divergence (Opposes BUY / Supports SELL)
  if (isBuy) {
    const swingHighs = [];
    for (let i = lookbackStart; i <= lookbackEnd; i++) {
      if (highs[i] >= highs[i - 1] && highs[i] >= highs[i - 2] &&
          (i === lookbackEnd || highs[i] >= highs[i + 1])) {
        const rsiIdx = i - offset;
        if (rsiIdx >= 0 && rsiIdx < rsiSeries.length) {
          swingHighs.push({ index: i, price: highs[i], rsi: rsiSeries[rsiIdx], time: bars[i].time });
        }
      }
    }
    if (swingHighs.length >= 2) {
      const p1 = swingHighs[swingHighs.length - 2];
      const p2 = swingHighs[swingHighs.length - 1];
      if (p2.price > p1.price && (p1.rsi - p2.rsi) >= 2.5 && p1.rsi >= 55) {
        return {
          hasDivergence: true,
          type: 'BEARISH_DIVERGENCE',
          opposesBias: true,
          reversalDirection: 'SELL',
          pivotPrice: p2.price,
          reason: `Bearish RSI Divergence: ราคาทำ New High (${p2.price.toFixed(4)} > ${p1.price.toFixed(4)}) แต่ RSI หมดแรง (${p2.rsi.toFixed(1)} < ${p1.rsi.toFixed(1)})`
        };
      }
    }
  }

  // 2. Bullish Divergence (Opposes SELL / Supports BUY)
  if (isSell) {
    const swingLows = [];
    for (let i = lookbackStart; i <= lookbackEnd; i++) {
      if (lows[i] <= lows[i - 1] && lows[i] <= lows[i - 2] &&
          (i === lookbackEnd || lows[i] <= lows[i + 1])) {
        const rsiIdx = i - offset;
        if (rsiIdx >= 0 && rsiIdx < rsiSeries.length) {
          swingLows.push({ index: i, price: lows[i], rsi: rsiSeries[rsiIdx], time: bars[i].time });
        }
      }
    }
    if (swingLows.length >= 2) {
      const p1 = swingLows[swingLows.length - 2];
      const p2 = swingLows[swingLows.length - 1];
      if (p2.price < p1.price && (p2.rsi - p1.rsi) >= 2.5 && p1.rsi <= 45) {
        return {
          hasDivergence: true,
          type: 'BULLISH_DIVERGENCE',
          opposesBias: true,
          reversalDirection: 'BUY',
          pivotPrice: p2.price,
          reason: `Bullish RSI Divergence: ราคาทำ New Low (${p2.price.toFixed(4)} < ${p1.price.toFixed(4)}) แต่ RSI ยกฐานขึ้น (${p2.rsi.toFixed(1)} > ${p1.rsi.toFixed(1)})`
        };
      }
    }
  }

  return { hasDivergence: false };
}

/**
 * Check for Multi-Candlestick Reversal Formations (Engulfing, Evening Star, Morning Star).
 */
export function checkReversalCandlestick(bars = [], bias = 'BUY') {
  if (!bars || bars.length < 3) return { hasReversalCandle: false };
  const b1 = bars[bars.length - 3];
  const b2 = bars[bars.length - 2];
  const b3 = bars[bars.length - 1];

  const isBuy = bias.toUpperCase() === 'BUY';
  const isSell = bias.toUpperCase() === 'SELL';

  // 1. Bearish Reversal Candlesticks (opposes BUY)
  if (isBuy) {
    const b2Green = b2.close > b2.open;
    const b3Red = b3.close < b3.open;
    const b3Engulfs = b3.open >= b2.close && b3.close <= b2.open && (b3.open - b3.close) > (b2.close - b2.open) * 1.05;
    if (b2Green && b3Red && b3Engulfs) {
      return {
        hasReversalCandle: true,
        type: 'BEARISH_ENGULFING',
        opposesBias: true,
        reversalDirection: 'SELL',
        pivotPrice: Math.max(b2.high, b3.high),
        reason: `Bearish Engulfing: แท่งเทียนสีแดงกลืนกินแท่งเขียวก่อนหน้ามิดแท่ง`
      };
    }

    const b1Green = b1.close > b1.open;
    const b1Body = b1.close - b1.open;
    const b2Doji = Math.abs(b2.close - b2.open) < b1Body * 0.4 && b2.high > b1.high;
    const b3StrongRed = b3.close < (b1.open + b1.close) / 2 && b3.close < b3.open;
    if (b1Green && b2Doji && b3StrongRed) {
      return {
        hasReversalCandle: true,
        type: 'EVENING_STAR',
        opposesBias: true,
        reversalDirection: 'SELL',
        pivotPrice: b2.high,
        reason: `Evening Star: รูปแบบดาวพลบค่ำ 3 แท่ง ทะลุลงลึกกว่ากึ่งกลางแท่งแรก`
      };
    }
  }

  // 2. Bullish Reversal Candlesticks (opposes SELL)
  if (isSell) {
    const b2Red = b2.close < b2.open;
    const b3Green = b3.close > b3.open;
    const b3Engulfs = b3.open <= b2.close && b3.close >= b2.open && (b3.close - b3.open) > (b2.open - b2.close) * 1.05;
    if (b2Red && b3Green && b3Engulfs) {
      return {
        hasReversalCandle: true,
        type: 'BULLISH_ENGULFING',
        opposesBias: true,
        reversalDirection: 'BUY',
        pivotPrice: Math.min(b2.low, b3.low),
        reason: `Bullish Engulfing: แท่งเทียนสีเขียวกลืนกินแท่งแดงก่อนหน้ามิดแท่ง`
      };
    }

    const b1Red = b1.close < b1.open;
    const b1Body = b1.open - b1.close;
    const b2Doji = Math.abs(b2.close - b2.open) < b1Body * 0.4 && b2.low < b1.low;
    const b3StrongGreen = b3.close > (b1.open + b1.close) / 2 && b3.close > b3.open;
    if (b1Red && b2Doji && b3StrongGreen) {
      return {
        hasReversalCandle: true,
        type: 'MORNING_STAR',
        opposesBias: true,
        reversalDirection: 'BUY',
        pivotPrice: b2.low,
        reason: `Morning Star: รูปแบบดาวรุ่ง 3 แท่ง ดีดทะลุขึ้นสูงกว่ากึ่งกลางแท่งแรก`
      };
    }
  }

  return { hasReversalCandle: false };
}

/**
 * Check for Swing Failure Pattern (SFP / Turtle Soup Liquidity Sweep Reversal).
 */
export function checkSwingFailurePattern(bars = [], bias = 'BUY') {
  if (!bars || bars.length < 15) return { hasSfp: false };
  const priorBars = bars.slice(-20, -2);
  const triggerBars = bars.slice(-2);

  const priorHigh = Math.max(...priorBars.map(b => Number(b.high)));
  const priorLow = Math.min(...priorBars.map(b => Number(b.low)));

  const isBuy = bias.toUpperCase() === 'BUY';
  const isSell = bias.toUpperCase() === 'SELL';

  // Bearish SFP (opposes BUY) - pierced high, closed below
  if (isBuy) {
    for (const b of triggerBars) {
      if (b.high > priorHigh && b.close < priorHigh) {
        const range = b.high - b.low;
        const upperWick = b.high - Math.max(b.open, b.close);
        if (range > 0 && (upperWick / range) >= 0.35) {
          return {
            hasSfp: true,
            type: 'BEARISH_SWING_FAILURE',
            opposesBias: true,
            reversalDirection: 'SELL',
            pivotPrice: b.high,
            reason: `Swing Failure Pattern (Bearish SFP): แท่งเทียนทะลุ High เดิม (${priorHigh.toFixed(4)}) กวาด Liquidity แล้วรูดกลับมาปิดต่ำกว่าเดิม`
          };
        }
      }
    }
  }

  // Bullish SFP (opposes SELL) - pierced low, closed above
  if (isSell) {
    for (const b of triggerBars) {
      if (b.low < priorLow && b.close > priorLow) {
        const range = b.high - b.low;
        const lowerWick = Math.min(b.open, b.close) - b.low;
        if (range > 0 && (lowerWick / range) >= 0.35) {
          return {
            hasSfp: true,
            type: 'BULLISH_SWING_FAILURE',
            opposesBias: true,
            reversalDirection: 'BUY',
            pivotPrice: b.low,
            reason: `Swing Failure Pattern (Bullish SFP): แท่งเทียนทะลุ Low เดิม (${priorLow.toFixed(4)}) กวาด Liquidity แล้วดีดกลับมาปิดสูงกว่าเดิม`
          };
        }
      }
    }
  }

  return { hasSfp: false };
}

/**
 * Comprehensive Reversal Evaluation:
 * Aggregates Divergence, Candlesticks, and SFP to evaluate:
 * 1. Trap Veto / Penalty: Protects continuation trades against opposing reversals.
 * 2. Reversal Opportunity: Provides candidate signals for Track 4 (REVERSAL_CONVICTION).
 */
export function checkComprehensiveReversal(bars = [], indicators = {}, bias = 'BUY') {
  if (!bars || bars.length < 15) {
    return { hasOpposingReversal: false, isReversalCandidate: false, confidencePenalty: 0 };
  }

  const rsiSeries = indicators?.rsiSeries || [];
  const divRes = checkRsiDivergence(bars, rsiSeries, bias);
  const candleRes = checkReversalCandlestick(bars, bias);
  const sfpRes = checkSwingFailurePattern(bars, bias);

  const reasons = [];
  let signalCount = 0;
  let pivotAnchor = null;

  if (divRes.hasDivergence) {
    signalCount += 1;
    reasons.push(divRes.reason);
    pivotAnchor = divRes.pivotPrice;
  }
  if (candleRes.hasReversalCandle) {
    signalCount += 1;
    reasons.push(candleRes.reason);
    if (!pivotAnchor) pivotAnchor = candleRes.pivotPrice;
  }
  if (sfpRes.hasSfp) {
    signalCount += 1;
    reasons.push(sfpRes.reason);
    if (!pivotAnchor) pivotAnchor = sfpRes.pivotPrice;
  }

  const hasOpposingReversal = signalCount >= 1;
  const isTrapVeto = signalCount >= 2; // When 2+ reversal patterns stack, hard veto continuation!
  const confidencePenalty = signalCount >= 2 ? 0.30 : (signalCount === 1 ? 0.20 : 0.0);

  return {
    hasOpposingReversal,
    isTrapVeto,
    signalCount,
    confidencePenalty,
    reversalDirection: bias.toUpperCase() === 'BUY' ? 'SELL' : 'BUY',
    pivotAnchor,
    reason: reasons.join(' + ') || 'No opposing reversal'
  };
}

/**
 * Detects the nearest confirmed structural barrier (Swing High for SELL, Swing Low for BUY)
 * between current price and current SL to tighten risk (Dynamic Invalidation SL Tightening).
 * 
 * @param {Array} bars - Recent price bars
 * @param {number} currentPrice - Current market price
 * @param {boolean} isBuy - True if BUY position, false if SELL
 * @param {number} currentSl - Current SL price of the position
 * @param {number} atr - ATR value for buffer & breathing room calculation
 * @param {Object} options - { pivotBars: 3, bufferMultiplier: 0.35, minBreathingAtr: 0.50, minBuffer: 0, entryPrice: null, minAdverseDistance: 0 }
 * @returns {Object|null} { barrierPrice, candidateSl, riskReduced, breathingRoom, barTime } or null
 */
export function findStructuralInvalidationBarrier(bars, currentPrice, isBuy, currentSl, atr, options = {}) {
  if (!bars || bars.length < 15 || !Number.isFinite(currentPrice) || !Number.isFinite(atr) || atr <= 0) {
    return null;
  }

  const pivotBars = options.pivotBars || 3;
  const bufferMultiplier = options.bufferMultiplier || 0.35;
  const minBreathingAtr = options.minBreathingAtr || 0.50;
  const minBuffer = options.minBuffer || 0;
  const buffer = Math.max(minBuffer, bufferMultiplier * atr);
  const minBreathingRoom = Math.max(minBuffer * 1.5, minBreathingAtr * atr);
  const entryPrice = Number.isFinite(options.entryPrice) ? Number(options.entryPrice) : null;
  const minAdverseDistance = options.minAdverseDistance || 0;

  // Consider last 40 completed bars
  const completed = bars.slice(0, -1);
  const n = completed.length;
  const startIndex = Math.max(pivotBars, n - 40);

  const candidates = [];

  for (let i = startIndex; i < n - pivotBars; i++) {
    const bar = completed[i];
    if (isBuy) {
      // For BUY: Look for confirmed Swing Low (Support) below current price
      let isSwingLow = true;
      for (let p = 1; p <= pivotBars; p++) {
        if (bar.low > completed[i - p].low || bar.low > completed[i + p].low) {
          isSwingLow = false;
          break;
        }
      }
      if (isSwingLow) {
        const supportPrice = Number(bar.low);
        const candidateSl = supportPrice - buffer;
        const breathingRoom = currentPrice - candidateSl;
        const canMove = currentSl === 0 || candidateSl > currentSl;

        // Anti-Trap Guard: If candidateSl is in adverse territory (candidateSl < entryPrice),
        // ensure it is not sitting dangerously close to entry (within noise/spread zone)
        let safeAdverse = true;
        if (entryPrice !== null && candidateSl < entryPrice) {
          if ((entryPrice - candidateSl) < minAdverseDistance) {
            safeAdverse = false;
          }
        }

        if (supportPrice < currentPrice && canMove && breathingRoom >= minBreathingRoom && safeAdverse) {
          candidates.push({
            barrierPrice: supportPrice,
            candidateSl,
            breathingRoom,
            riskReduced: currentSl > 0 ? (candidateSl - currentSl) : 0,
            barTime: bar.time
          });
        }
      }
    } else {
      // For SELL: Look for confirmed Swing High (Resistance) above current price
      let isSwingHigh = true;
      for (let p = 1; p <= pivotBars; p++) {
        if (bar.high < completed[i - p].high || bar.high < completed[i + p].high) {
          isSwingHigh = false;
          break;
        }
      }
      if (isSwingHigh) {
        const resistancePrice = Number(bar.high);
        const candidateSl = resistancePrice + buffer;
        const breathingRoom = candidateSl - currentPrice;
        const canMove = currentSl === 0 || candidateSl < currentSl;

        // Anti-Trap Guard: If candidateSl is in adverse territory (candidateSl > entryPrice),
        // ensure it is not sitting dangerously close to entry (within noise/spread zone)
        let safeAdverse = true;
        if (entryPrice !== null && candidateSl > entryPrice) {
          if ((candidateSl - entryPrice) < minAdverseDistance) {
            safeAdverse = false;
          }
        }

        if (resistancePrice > currentPrice && canMove && breathingRoom >= minBreathingRoom && safeAdverse) {
          candidates.push({
            barrierPrice: resistancePrice,
            candidateSl,
            breathingRoom,
            riskReduced: currentSl > 0 ? (currentSl - candidateSl) : 0,
            barTime: bar.time
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // For BUY: pick highest candidateSl (protects the most risk while respecting all safety guards)
  // For SELL: pick lowest candidateSl (tightens the most risk while respecting all safety guards)
  if (isBuy) {
    candidates.sort((a, b) => b.candidateSl - a.candidateSl);
  } else {
    candidates.sort((a, b) => a.candidateSl - b.candidateSl);
  }

  return candidates[0];
}
