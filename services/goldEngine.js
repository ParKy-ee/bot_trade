import { getPool } from '../config/database.js';
import { GOLD_UNIVERSE } from './marketData.js';
import { placeOrder, modifyStopLoss, closePosition, getRates, getOpenPositions } from './mt5Broker.js';
import { recordTradeEntry, recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';
import { predictGoldConfidence, predictForexMarketPressure } from './modelPredictor.js';
import { recordMarketPressureObservation } from './marketPressureObservationTracker.js';
import { EMA, RSI, ATR, BollingerBands } from 'technicalindicators';
import { checkRejectionCandle, checkComprehensiveReversal, findStructuralInvalidationBarrier } from './forexPriceAction.js';
import { evaluateSrRejectionHarvest } from './forexExitEngine.js';
import dotenv from 'dotenv';

dotenv.config();

const GOLD_DATA_HARVEST_LIVE_MODE = process.env.GOLD_DATA_HARVEST_LIVE_MODE === 'true';
const GOLD_LIVE_ENABLED = process.env.GOLD_LIVE_ENABLED === 'true';
const GOLD_MT5_LIVE = process.env.MT5_ENABLED === 'true' && GOLD_LIVE_ENABLED;
const GOLD_CONFIDENCE_THRESHOLD = Number(process.env.GOLD_CONFIDENCE_THRESHOLD || 0.50);
const GOLD_RAW_SCORE_THRESHOLD = Number(process.env.GOLD_RAW_SCORE_THRESHOLD || 0.22);
const GOLD_REJECTION_FILTER_ENABLED = process.env.GOLD_REJECTION_FILTER_ENABLED !== 'false';
const GOLD_MAX_POSITIONS = Math.max(1, Number(process.env.GOLD_MAX_POSITIONS || 1));
const GOLD_LOT_SIZE = Number(process.env.GOLD_LOT_SIZE || 0.01);
const GOLD_MARKET_PRESSURE_ENABLED = process.env.GOLD_MARKET_PRESSURE_ENABLED !== 'false';
const GOLD_PRESSURE_EXIT_ENABLED = process.env.GOLD_PRESSURE_EXIT_ENABLED !== 'false';

/**
 * Identify market session for Gold trading (GMT+7 Bangkok Time).
 */
export function getGoldSession(date = new Date()) {
  const utcHours = date.getUTCHours();
  const utcMinutes = date.getUTCMinutes();
  const bangkokTotalMinutes = ((utcHours + 7) % 24) * 60 + utcMinutes;
  const bangkokHour = Math.floor(bangkokTotalMinutes / 60);

  if (bangkokHour >= 6 && bangkokHour < 13) {
    return { name: 'ASIAN', num: 1.0 };
  } else if (bangkokHour >= 14 && bangkokHour < 18) {
    return { name: 'LONDON_OPEN', num: 2.0 };
  } else if (bangkokTotalMinutes >= 19 * 60 + 30 && bangkokTotalMinutes < 23 * 60 + 30) {
    return { name: 'LONDON_NY_OVERLAP', num: 3.0 }; // Golden Window
  } else if (bangkokHour >= 0 && bangkokHour < 4) {
    return { name: 'LATE_NY', num: 4.0 };
  } else if (bangkokHour >= 4 && bangkokHour < 5) {
    return { name: 'ROLLOVER', num: 0.0 }; // Spread Widening / Maintenance
  }
  return { name: 'OTHER', num: 0.0 };
}

/**
 * Calculates 12 technical indicators tailored for Gold M5 Machine Learning model.
 */
function calculateGoldIndicators(bars, dxySlope = 0.0) {
  if (!bars || bars.length < 35) return null;

  const closes = bars.map(b => Number(b.close));
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const n = closes.length;

  const ema21Values = EMA.calculate({ period: 21, values: closes });
  const ema50Values = EMA.calculate({ period: 50, values: closes });
  const ema200Values = EMA.calculate({ period: Math.min(200, Math.floor(n * 0.9)), values: closes });
  const rsi14Values = RSI.calculate({ period: 14, values: closes });
  const atr14Values = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bbValues = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });

  const lastClose = closes[n - 1];
  const lastHigh = highs[n - 1];
  const lastLow = lows[n - 1];
  const prevClose1 = closes[n - 2] || lastClose;
  const prevClose5 = closes[Math.max(0, n - 6)] || lastClose;

  const ret1 = (lastClose - prevClose1) / (prevClose1 + 1e-12);
  const ret5 = (lastClose - prevClose5) / (prevClose5 + 1e-12);

  const lastEma21 = ema21Values[ema21Values.length - 1] || lastClose;
  const lastEma50 = ema50Values[ema50Values.length - 1] || lastClose;
  const lastEma200 = ema200Values[ema200Values.length - 1] || lastClose;
  const lastRsi = rsi14Values[rsi14Values.length - 1] || 50;
  const lastAtr = Math.max(0.5, atr14Values[atr14Values.length - 1] || 2.0);
  const lastBb = bbValues[bbValues.length - 1] || { upper: lastClose + 3, lower: lastClose - 3, middle: lastClose };

  const atrPct = lastAtr / (lastClose + 1e-12);
  const emaSpread2150 = (lastEma21 - lastEma50) / (lastAtr + 1e-12);
  const bbWidth = (lastBb.upper - lastBb.lower) / (lastBb.middle + 1e-12);
  const h1TrendSlope = Math.max(-5.0, Math.min(5.0, (lastClose - lastEma200) / (lastAtr + 1e-12)));

  // ADX 14 proxy / calculation
  let adx14 = 20.0;
  if (highs.length >= 28) {
    let trSum = 0, dmPlus = 0, dmMinus = 0;
    for (let i = n - 14; i < n; i++) {
      const up = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      if (up > down && up > 0) dmPlus += up;
      if (down > up && down > 0) dmMinus += down;
      trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    const diPlus = (dmPlus / (trSum + 1e-12)) * 100;
    const diMinus = (dmMinus / (trSum + 1e-12)) * 100;
    adx14 = ((Math.abs(diPlus - diMinus)) / (diPlus + diMinus + 1e-12)) * 100;
  }

  // Fair Value Gap (FVG)
  let fvgBullBear = 0.0;
  if (n >= 3) {
    if (lows[n - 1] > highs[n - 3]) fvgBullBear = 1.0;
    else if (highs[n - 1] < lows[n - 3]) fvgBullBear = -1.0;
  }

  // Asian Range Sweep
  const recentBars = bars.slice(-60);
  const asianHigh = Math.max(...recentBars.slice(0, 30).map(b => Number(b.high)));
  const asianLow = Math.min(...recentBars.slice(0, 30).map(b => Number(b.low)));
  let asianSweep = 0.0;
  if (lastHigh > asianHigh && lastClose < asianHigh) asianSweep = 1.0; // Bearish sweep
  else if (lastLow < asianLow && lastClose > asianLow) asianSweep = -1.0; // Bullish sweep

  const sessionObj = getGoldSession();

  return {
    lastClose,
    lastHigh,
    lastLow,
    ema21: lastEma21,
    ema50: lastEma50,
    ema200: lastEma200,
    rsi: lastRsi,
    atr: lastAtr,
    bb: lastBb,
    asianHigh,
    asianLow,
    session: sessionObj.name,
    sessionNum: sessionObj.num,
    mlFeatures: {
      ret_1: Number(ret1.toFixed(6)),
      ret_5: Number(ret5.toFixed(6)),
      rsi_14: Number(lastRsi.toFixed(2)),
      atr_pct: Number(atrPct.toFixed(6)),
      adx_14: Number(adx14.toFixed(2)),
      ema_spread_21_50: Number(emaSpread2150.toFixed(4)),
      bb_width: Number(bbWidth.toFixed(6)),
      asian_sweep: asianSweep,
      session_num: sessionObj.num,
      dxy_slope_5: Number(dxySlope.toFixed(4)),
      h1_trend_slope: Number(h1TrendSlope.toFixed(4)),
      fvg_bull_bear: fvgBullBear
    }
  };
}

/**
 * Detect swing highs and lows across expanded M5 bars for structural S/R detection in Gold.
 */
export function findGoldSwingLevels(bars = [], lookbackBars = 180, pivotStrength = 2) {
  const completedBars = (bars || []).slice(0, -1).map(b => ({
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    time: b.time
  })).filter(b => Number.isFinite(b.high) && Number.isFinite(b.low));

  const start = Math.max(pivotStrength, completedBars.length - lookbackBars);
  const end = completedBars.length - pivotStrength;
  const pivotHighs = [];
  const pivotLows = [];

  for (let i = start; i < end; i++) {
    const cur = completedBars[i];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= pivotStrength; offset++) {
      if (cur.high < completedBars[i - offset].high || cur.high < completedBars[i + offset].high) isHigh = false;
      if (cur.low > completedBars[i - offset].low || cur.low > completedBars[i + offset].low) isLow = false;
    }
    if (isHigh) pivotHighs.push({ price: cur.high, time: cur.time });
    if (isLow) pivotLows.push({ price: cur.low, time: cur.time });
  }

  return { pivotHighs, pivotLows };
}

/**
 * Detect Multi-Day & Multi-Timeframe Historical Obstacles (Resistance & Support Zones)
 * and measure the past adverse reaction force, drop/bounce magnitude, rejection wick, and pressure.
 */
export function findGoldHistoricalObstacles({ m5Bars = [], m15Bars = [], h1Bars = [], currentPrice, direction, atr = 5.0 }) {
  const isBuy = direction === 'BUY';
  const obstacles = [];

  function extractSwings(bars, tf, pivotStrength = 2, maxFutureBars = 16) {
    if (!bars || bars.length < pivotStrength * 2 + 1) return;
    const completed = bars.slice(0, -1);
    const n = completed.length;

    for (let i = pivotStrength; i < n - pivotStrength; i++) {
      const cur = completed[i];
      if (isBuy) {
        let isHigh = true;
        for (let o = 1; o <= pivotStrength; o++) {
          if (cur.high < completed[i - o].high || cur.high < completed[i + o].high) {
            isHigh = false;
            break;
          }
        }
        if (isHigh && cur.high > currentPrice) {
          // Invalidation & Stale Filter: Check if price later cleanly broke & closed above this level or whipsawed through it
          let cleanBreak = false;
          let cutThroughCount = 0;
          let minLowNext = Infinity;

          for (let j = i + 1; j < n; j++) {
            const nextBar = completed[j];
            if (nextBar.close > cur.high + (0.25 * atr)) {
              cleanBreak = true;
            }
            if (nextBar.low < cur.high && nextBar.high > cur.high) {
              cutThroughCount++;
            }
            if (j <= i + maxFutureBars && nextBar.low < minLowNext) {
              minLowNext = nextBar.low;
            }
          }

          // Discard levels that have already been cleanly broken (liquidity absorbed) or whipsawed
          if (cleanBreak || cutThroughCount > 3) {
            continue;
          }

          const dropDistance = cur.high - (Number.isFinite(minLowNext) ? minLowNext : cur.close);
          const upperWick = cur.high - Math.max(cur.open, cur.close);
          const totalRange = Math.max(0.1, cur.high - cur.low);
          const wickRatio = upperWick / totalRange;

          obstacles.push({
            timeframe: tf,
            time: cur.time,
            price: Number(cur.high.toFixed(2)),
            reactionDistance: Number(dropDistance.toFixed(2)),
            reactionAtrRatio: Number((dropDistance / (atr + 1e-9)).toFixed(2)),
            wickRatio: Number(wickRatio.toFixed(2)),
            volume: cur.volume || 0
          });
        }
      } else {
        let isLow = true;
        for (let o = 1; o <= pivotStrength; o++) {
          if (cur.low > completed[i - o].low || cur.low > completed[i + o].low) {
            isLow = false;
            break;
          }
        }
        if (isLow && cur.low < currentPrice) {
          // Invalidation & Stale Filter: Check if price later cleanly broke & closed below this level or whipsawed through it
          let cleanBreak = false;
          let cutThroughCount = 0;
          let maxHighNext = -Infinity;

          for (let j = i + 1; j < n; j++) {
            const nextBar = completed[j];
            if (nextBar.close < cur.low - (0.25 * atr)) {
              cleanBreak = true;
            }
            if (nextBar.low < cur.low && nextBar.high > cur.low) {
              cutThroughCount++;
            }
            if (j <= i + maxFutureBars && nextBar.high > maxHighNext) {
              maxHighNext = nextBar.high;
            }
          }

          // Discard levels that have already been cleanly broken (liquidity absorbed) or whipsawed
          if (cleanBreak || cutThroughCount > 3) {
            continue;
          }

          const bounceDistance = (Number.isFinite(maxHighNext) ? maxHighNext : cur.close) - cur.low;
          const lowerWick = Math.min(cur.open, cur.close) - cur.low;
          const totalRange = Math.max(0.1, cur.high - cur.low);
          const wickRatio = lowerWick / totalRange;

          obstacles.push({
            timeframe: tf,
            time: cur.time,
            price: Number(cur.low.toFixed(2)),
            reactionDistance: Number(bounceDistance.toFixed(2)),
            reactionAtrRatio: Number((bounceDistance / (atr + 1e-9)).toFixed(2)),
            wickRatio: Number(wickRatio.toFixed(2)),
            volume: cur.volume || 0
          });
        }
      }
    }
  }

  // Extract across M5 (recent intraday), M15 (multi-day 50h), and H1 (macro multi-day 72h)
  extractSwings(m5Bars.slice(-150), 'M5', 3, 24);
  extractSwings(m15Bars, 'M15', 2, 16);
  extractSwings(h1Bars, 'H1', 2, 12);

  // Group nearby obstacle points into Consolidated Zones (within 0.35 * ATR)
  const zoneTolerance = Math.max(1.50, 0.35 * atr);
  const zones = [];

  obstacles.sort((a, b) => isBuy ? a.price - b.price : b.price - a.price);

  for (const obs of obstacles) {
    let matchedZone = zones.find(z => Math.abs(z.centerPrice - obs.price) <= zoneTolerance);
    if (!matchedZone) {
      matchedZone = {
        centerPrice: obs.price,
        frontEdge: obs.price,
        farEdge: obs.price,
        touches: [],
        maxReactionDistance: obs.reactionDistance,
        maxReactionAtrRatio: obs.reactionAtrRatio,
        maxWickRatio: obs.wickRatio,
        primaryTimeframe: obs.timeframe,
        latestTime: obs.time
      };
      zones.push(matchedZone);
    }

    matchedZone.touches.push(obs);
    matchedZone.frontEdge = isBuy ? Math.min(matchedZone.frontEdge, obs.price) : Math.max(matchedZone.frontEdge, obs.price);
    matchedZone.farEdge = isBuy ? Math.max(matchedZone.farEdge, obs.price) : Math.min(matchedZone.farEdge, obs.price);
    if (obs.reactionDistance > matchedZone.maxReactionDistance) {
      matchedZone.maxReactionDistance = obs.reactionDistance;
      matchedZone.maxReactionAtrRatio = obs.reactionAtrRatio;
    }
    if (obs.wickRatio > matchedZone.maxWickRatio) {
      matchedZone.maxWickRatio = obs.wickRatio;
    }
    if (obs.timeframe === 'H1') matchedZone.primaryTimeframe = 'H1';
  }

  for (const z of zones) {
    const touchCount = z.touches.length;
    let threatScore = (z.maxReactionAtrRatio * 15) + (touchCount * 10) + (z.maxWickRatio * 20);
    if (z.primaryTimeframe === 'H1') threatScore += 15;

    let threatLevel = 'MODERATE';
    if (threatScore >= 45 || z.maxReactionAtrRatio >= 2.5 || touchCount >= 3) {
      threatLevel = 'CRITICAL';
    } else if (threatScore >= 25 || z.maxReactionAtrRatio >= 1.5 || touchCount >= 2) {
      threatLevel = 'STRONG';
    }

    z.threatScore = Number(threatScore.toFixed(1));
    z.threatLevel = threatLevel;
    z.touchCount = touchCount;
    z.historicalPressurePct = Math.min(98, Math.round(50 + (z.maxReactionAtrRatio * 8) + (z.maxWickRatio * 20)));
    z.dominantSide = isBuy ? 'SELL_SUPPLY' : 'BUY_DEMAND';
  }

  zones.sort((a, b) => isBuy ? a.frontEdge - b.frontEdge : b.frontEdge - a.frontEdge);

  const nearestZone = zones[0] || null;

  return {
    direction,
    currentPrice,
    atr,
    zones,
    nearestZone
  };
}

/**
 * Evaluates whether current market pressure, volume, and momentum have the strength
 * to penetrate / break through a historical barrier (Breakout Force Index - BFI).
 */
export function evaluateBarrierBreakoutViability({
  currentPressure,
  m5Bars = [],
  obstacleZone,
  direction = 'BUY',
  atr = 5.0,
  adx = 20.0
}) {
  if (!obstacleZone) return { canBreakout: false, bfi: 0, breakoutWinProb: 0, reason: 'No obstacle' };

  const isBuy = direction === 'BUY';
  const pDirect = isBuy ? Number(currentPressure?.probabilities?.buy_pressure || 0) : Number(currentPressure?.probabilities?.sell_pressure || 0);
  const pAdverse = isBuy ? Number(currentPressure?.probabilities?.sell_pressure || 0) : Number(currentPressure?.probabilities?.buy_pressure || 0);

  // 1. Current Attack Force (0 - 100)
  // Calculate relative volume of recent 3 bars vs 20-bar baseline
  let rvol = 1.0;
  if (m5Bars.length >= 25) {
    const recentVol = m5Bars.slice(-3).reduce((sum, b) => sum + (Number(b.volume) || 1), 0) / 3;
    const baseVol = m5Bars.slice(-23, -3).reduce((sum, b) => sum + (Number(b.volume) || 1), 0) / 20;
    rvol = baseVol > 0 ? (recentVol / baseVol) : 1.0;
  }

  // Last bar wick absorption check (Buyers pushing to the absolute high without upper wick)
  const lastBar = m5Bars[m5Bars.length - 1];
  let absorptionBonus = 0;
  if (lastBar) {
    const barRange = Math.max(0.1, Number(lastBar.high) - Number(lastBar.low));
    const adverseWick = isBuy
      ? (Number(lastBar.high) - Math.max(Number(lastBar.open), Number(lastBar.close)))
      : (Math.min(Number(lastBar.open), Number(lastBar.close)) - Number(lastBar.low));
    const wickPct = adverseWick / barRange;
    if (wickPct <= 0.15) absorptionBonus = 15; // Clean impulse pressing into the barrier
    else if (wickPct <= 0.30) absorptionBonus = 8;
  }

  const attackScore = (pDirect * 50) + (Math.min(3.0, rvol) * 15) + (Math.min(40.0, adx) * 0.7) + absorptionBonus;

  // 2. Historical Defense Strength (0 - 100)
  // Note: Repeated tests (3+) with higher lows absorb resting limit orders (Order exhaustion discount)
  const touchCount = obstacleZone.touchCount || 1;
  const exhaustionDiscount = touchCount >= 3 ? 0.75 : 1.0;
  const defenseScore = ((obstacleZone.maxReactionAtrRatio * 12) + (touchCount * 8)) * exhaustionDiscount;

  const bfi = Number((attackScore / Math.max(10, defenseScore)).toFixed(2));
  const breakoutWinProb = Number(Math.min(95, Math.max(5, 50 + (bfi - 1.0) * 25)).toFixed(1));

  // Minimum requirements to confirm a viable breakout through a strong/critical barrier:
  // - BFI >= 1.35
  // - Directional pressure >= 60%
  // - Opposing pressure <= 25%
  // - RVOL >= 1.25
  const canBreakout = bfi >= 1.35 && pDirect >= 0.60 && pAdverse <= 0.25 && rvol >= 1.25;

  return {
    canBreakout,
    bfi,
    breakoutWinProb,
    attackScore: Number(attackScore.toFixed(1)),
    defenseScore: Number(defenseScore.toFixed(1)),
    rvol: Number(rvol.toFixed(2)),
    pDirect: Number((pDirect * 100).toFixed(0)),
    reason: canBreakout
      ? `🟢 โมเมนตัมปัจจุบันทรงพลังพอที่จะทะลุแนวเก่า (BFI ${bfi} >= 1.35 | แรงส่ง ${Number(pDirect * 100).toFixed(0)}% | Vol Surge ${rvol.toFixed(1)}x | โอกาสชนะ ${breakoutWinProb}%)`
      : `🔴 แรงปัจจุบันยังไม่พอที่จะเอาชนะแนวเก่า (BFI ${bfi} < 1.35 | แรงส่งเพียง ${Number(pDirect * 100).toFixed(0)}% | แนวเก่าแข็งแกร่ง ${defenseScore.toFixed(0)} pt | โอกาสชนะ ${breakoutWinProb}%)`
  };
}

/**
 * Execute Gold M5 Scan Cycle
 */
export async function executeGoldScanCycle() {
  console.log(`[*] [${new Date().toISOString()}] 🟡 เริ่มรอบการสแกนตลาดทองคำ (GOLD / XAUUSD)...`);
  const pool = await getPool();
  const sessionObj = getGoldSession();
  const session = sessionObj.name;

  if (session === 'ROLLOVER') {
    console.log(`🛡️ [Gold Guard] ช่วงเวลา Rollover ตลาดทองคำ (04:00 - 05:00 น.) พักการส่งคำสั่งใหม่`);
    return { success: true, message: 'Rollover period - orders blocked' };
  }

  // 1. Fetch live M5, M15 & H1 Gold rates from MT5 in parallel (M5: 300 bars/25h, M15: 200 bars/50h, H1: 72 bars/3 days)
  let m5Bars = null;
  let m15Bars = null;
  let h1Bars = null;
  const symbol = 'GOLD';

  try {
    const [m5Res, m15Res, h1Res] = await Promise.all([
      getRates(symbol, 'M5', 300),
      getRates(symbol, 'M15', 200),
      getRates(symbol, 'H1', 72)
    ]);
    if (m5Res && m5Res.bars && m5Res.bars.length > 0) {
      m5Bars = m5Res.bars;
    }
    if (m15Res && m15Res.bars && m15Res.bars.length > 0) {
      m15Bars = m15Res.bars;
    }
    if (h1Res && h1Res.bars && h1Res.bars.length > 0) {
      h1Bars = h1Res.bars;
    }
  } catch (err) {
    console.warn('⚠️ ดึงข้อมูลแท่งเทียน GOLD จาก MT5 ล้มเหลว:', err.message);
    return { success: false, error: err.message };
  }

  if (!m5Bars || m5Bars.length < 35) {
    console.warn('⚠️ แท่งเทียน GOLD M5 ไม่เพียงพอสำหรับการวิเคราะห์');
    return { success: false, message: 'Insufficient GOLD bars' };
  }

  // Predict Market Pressure & Indecision for Gold (12 normalized microstructure features)
  let marketPressure = null;
  if (GOLD_MARKET_PRESSURE_ENABLED) {
    try {
      marketPressure = await predictForexMarketPressure(m5Bars, 'GOLD');
      if (marketPressure) {
        await recordMarketPressureObservation({
          pool,
          symbol: 'GOLD',
          barTime: m5Bars[m5Bars.length - 1]?.time || new Date(),
          pressureResult: marketPressure
        });
        console.log(`🧭 [GOLD PRESSURE] GOLD: ${marketPressure.state} | Buy: ${(marketPressure.probabilities.buy_pressure*100).toFixed(0)}% | Sell: ${(marketPressure.probabilities.sell_pressure*100).toFixed(0)}% | Indecision: ${(marketPressure.probabilities.indecision*100).toFixed(0)}%`);
      }
    } catch (pErr) {
      console.warn('⚠️ [Gold] Market Pressure inference skipped:', pErr.message);
    }
  }

  // Save recent Gold bars into market_bars table for chart display & forward outcome resolution
  try {
    const recentBars = m5Bars.slice(-60);
    const values = recentBars.map(b => [
      b.time,
      'GOLD',
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume || b.tick_volume || 0,
      'gold'
    ]);
    await pool.query(
      `INSERT INTO market_bars (time, symbol, open, high, low, close, volume, market_type)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         open=VALUES(open), high=VALUES(high), low=VALUES(low),
         close=VALUES(close), volume=VALUES(volume),
         market_type='gold',
         last_scanned_at=CURRENT_TIMESTAMP`,
      [values]
    );
  } catch (barErr) {}

  // 2. Synchronize existing Gold positions with MT5
  try {
    await syncMt5PositionsWithDatabase();

    const [openPositions] = await pool.query(
      `SELECT symbol, entry_price, entry_date, highest_price, sl_price, tp_price, status_note, mt5_ticket
       FROM active_positions
       WHERE market_type = 'gold' AND status_note NOT LIKE 'CLOSED%'`
    );

    const currentPrice = Number(m5Bars[m5Bars.length - 1].close);
    const ind = calculateGoldIndicators(m5Bars);
    const atr = ind?.atr || 2.0;

    for (const pos of openPositions) {
      const ticket = Number(pos.mt5_ticket);
      const entryPrice = Number(pos.entry_price);
      let highestPrice = Number(pos.highest_price || entryPrice);
      const isBuy = pos.status_note.includes('BUY');
      const heldMinutes = Math.floor((Date.now() - new Date(pos.entry_date).getTime()) / (1000 * 60));

      if (isBuy && currentPrice > highestPrice) {
        highestPrice = currentPrice;
        await pool.query('UPDATE active_positions SET highest_price = ? WHERE mt5_ticket = ?', [highestPrice, ticket]);
      } else if (!isBuy && currentPrice < highestPrice) {
        highestPrice = currentPrice;
        await pool.query('UPDATE active_positions SET highest_price = ? WHERE mt5_ticket = ?', [highestPrice, ticket]);
      }

      // 1. Dynamic Break-Even & Micro-BE Lock
      const profitDistance = isBuy ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
      const slPrice = Number(pos.sl_price || 0);

      // 1.1 Micro Break-Even Lock: When profit reaches >= $2.50 (or 0.65x ATR), move SL to Break-Even + 0.1x ATR
      const microBeTrigger = Math.max(2.50, 0.65 * atr);
      if (profitDistance >= microBeTrigger && !pos.status_note.includes('BE_LOCKED') && !pos.status_note.includes('MICRO_BE')) {
        const microBeSl = isBuy ? Number((entryPrice + 0.1 * atr).toFixed(2)) : Number((entryPrice - 0.1 * atr).toFixed(2));
        const canMove = isBuy ? (microBeSl > slPrice) : (slPrice === 0 || microBeSl < slPrice);
        if (canMove) {
          console.log(`🛡️ [Gold Micro Break-Even] ไม้ #${ticket} กำไร +$${profitDistance.toFixed(2)} (>= $${microBeTrigger.toFixed(2)}) -> ขยับ SL ล็อกทุนที่ $${microBeSl}`);
          await modifyStopLoss(ticket, microBeSl, pos.tp_price);
          await pool.query(
            `UPDATE active_positions SET sl_price = ?, status_note = CONCAT(status_note, '_MICRO_BE') WHERE mt5_ticket = ?`,
            [microBeSl, ticket]
          );
        }
      }

      // 1.2 Full Break-Even Lock: When price reaches +1.2x ATR profit, move SL to Break-Even +0.3x ATR
      if (profitDistance >= 1.2 * atr && !pos.status_note.includes('BE_LOCKED')) {
        const beSl = isBuy ? Number((entryPrice + 0.3 * atr).toFixed(2)) : Number((entryPrice - 0.3 * atr).toFixed(2));
        const canMove = isBuy ? (beSl > slPrice) : (slPrice === 0 || beSl < slPrice);
        if (canMove) {
          console.log(`🔒 [Gold Break-Even] ปรับ SL ไม้ #${ticket} สู่ Break-Even กำไรคุ้มกันที่ $${beSl}`);
          await modifyStopLoss(ticket, beSl, pos.tp_price);
          await pool.query(
            `UPDATE active_positions SET sl_price = ?, status_note = CONCAT(status_note, '_BE_LOCKED') WHERE mt5_ticket = ?`,
            [beSl, ticket]
          );
        }
      }

      // 1.3 Structural Risk Mitigation SL Tightening (Dynamic Invalidation Behind Major S/R)
      // When Gold is floating or in early phase without full BE, tighten SL behind verified MAJOR Swing High (SELL) or Swing Low (BUY)
      // to reduce maximum loss while giving price ample room to absorb wick noise and spread.
      if (!pos.status_note.includes('BE_LOCKED')) {
        const structBarrier = findStructuralInvalidationBarrier(m5Bars, currentPrice, isBuy, slPrice, atr, {
          pivotBars: 3,
          bufferMultiplier: 0.35,
          minBreathingAtr: 0.50,
          minBuffer: 2.50,
          entryPrice,
          minAdverseDistance: 2.50
        });

        if (structBarrier && structBarrier.riskReduced >= 1.20) {
          const newSl = Number(structBarrier.candidateSl.toFixed(2));
          const canMove = isBuy ? (newSl > slPrice) : (slPrice === 0 || newSl < slPrice);
          if (canMove) {
            console.log(`🛡️ [Gold Structural SL Tightening] ดึง SL ไม้ #${ticket} (${isBuy ? 'BUY' : 'SELL'}) ดักหลังแนว${isBuy ? 'รับ' : 'ต้าน'}หลัก $${structBarrier.barrierPrice.toFixed(2)} ที่ $${newSl} (ลดความเสี่ยงลง $${structBarrier.riskReduced.toFixed(2)} | Buffer: $2.50)`);
            await modifyStopLoss(ticket, newSl, pos.tp_price);
            await pool.query(
              `UPDATE active_positions SET sl_price = ?, status_note = IF(status_note LIKE '%_STRUCT_SL%', status_note, CONCAT(status_note, '_STRUCT_SL')) WHERE mt5_ticket = ?`,
              [newSl, ticket]
            );
            pos.sl_price = newSl;
          }
        }
      }

      // 1.8 S/R Rejection Harvest: Lock in profits when price tests structural resistance/support and rejects
      try {
        const srHarvestCheck = evaluateSrRejectionHarvest({
          action: isBuy ? 'BUY' : 'SELL',
          currentPrice,
          entryPrice,
          bars: m5Bars,
          atr,
          pipSize: 1.0,
          holdMinutes: heldMinutes,
          minProfitAtrMult: 0.45,
          minHoldMinutes: 5
        });

        if (srHarvestCheck.shouldExit) {
          console.log(`🎯 [Gold S/R Rejection Harvest] ไม้ #${ticket} (GOLD ${isBuy ? 'BUY' : 'SELL'}): ${srHarvestCheck.reason}`);
          if (GOLD_MT5_LIVE) {
            try {
              await closePosition(ticket);
            } catch (e) {
              console.warn(`⚠️ MT5 close error ticket #${ticket}:`, e.message);
            }
          }
          await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_SR_REJECTION_HARVEST' WHERE mt5_ticket = ?`, [ticket]);
          await recordTradeExit({
            ticket,
            symbol: 'GOLD',
            exitPrice: currentPrice,
            exitReason: 'CLOSED_SR_REJECTION_HARVEST'
          });
          continue;
        }
      } catch (srErr) {
        console.warn('⚠️ [Gold] Error evaluating S/R harvest exit:', srErr.message);
      }

      // 2. Micro-Scalp Fast Harvest for Gold: When profit reaches >= $3.50 (or 1.2x ATR), harvest instantly!
      const harvestTrigger = Math.min(Math.max(3.50, 1.2 * atr), 2.2 * atr);
      if (profitDistance >= harvestTrigger) {
        console.log(`⚡ [Gold Micro-Scalp Harvest] ไม้ #${ticket} กำไรแตะ +$${profitDistance.toFixed(2)} (>= $${harvestTrigger.toFixed(2)}) -> ปิดรวบกำไรทันที!`);
        const closeRes = await closePosition(ticket);
        if (closeRes && closeRes.success) {
          await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_MICRO_SCALP' WHERE mt5_ticket = ?`, [ticket]);
          await recordTradeExit({
            ticket,
            symbol: 'GOLD',
            exitPrice: currentPrice,
            exitReason: 'CLOSED_MICRO_SCALP',
            realProfit: closeRes.profit ?? null
          });
          continue;
        }
      }

      // 2.5 Active Market Pressure & Reversal Intra-Trade Protection for Gold
      if (GOLD_PRESSURE_EXIT_ENABLED && marketPressure) {
        const pAdverse = isBuy 
          ? Number(marketPressure.probabilities?.sell_pressure || 0)
          : Number(marketPressure.probabilities?.buy_pressure || 0);
        const adverseState = isBuy 
          ? marketPressure.state === 'SELL_PRESSURE' 
          : marketPressure.state === 'BUY_PRESSURE';
        const adverseReversalFlow = isBuy
          ? Boolean(marketPressure.reversal_confirmation?.bearish_flow_confirmed)
          : Boolean(marketPressure.reversal_confirmation?.bullish_flow_confirmed);

        let hasOpposingReversal = false;
        let reversalReason = '';
        try {
          const revCheck = checkComprehensiveReversal(m5Bars, ind, isBuy ? 'BUY' : 'SELL');
          hasOpposingReversal = Boolean(revCheck.hasOpposingReversal);
          reversalReason = revCheck.reason || '';
        } catch {}

        const earlyCutAdverseThreshold = Number(process.env.GOLD_PRESSURE_EARLY_CUT_THRESHOLD || 0.42);
        const profitLockAdverseThreshold = Number(process.env.GOLD_PRESSURE_PROFIT_LOCK_THRESHOLD || 0.42);

        // Case A: Profit Lock - If position is in profit (>= $2.80 / 0.8x ATR) and adverse pressure/reversal appears
        if (profitDistance >= Math.max(2.80, 0.8 * atr) && (pAdverse >= profitLockAdverseThreshold || (adverseState && pAdverse >= 0.35) || adverseReversalFlow || (hasOpposingReversal && pAdverse >= 0.35))) {
          console.log(`🛡️ [Gold Pressure Exit] ไม้ #${ticket} กำไร +$${profitDistance.toFixed(2)} แต่เจอแรงสวนกลับ ${(pAdverse*100).toFixed(0)}% (${marketPressure.state}) ${reversalReason ? '| ' + reversalReason : ''} -> ล็อกกำไรทันทีก่อนโดนดึงกลับ!`);
          const closeRes = await closePosition(ticket);
          if (closeRes && closeRes.success) {
            await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_PRESSURE_PROFIT_LOCK' WHERE mt5_ticket = ?`, [ticket]);
            await recordTradeExit({
              ticket,
              symbol: 'GOLD',
              exitPrice: currentPrice,
              exitReason: 'CLOSED_PRESSURE_PROFIT_LOCK',
              realProfit: closeRes.profit ?? null
            });
            continue;
          }
        }

        // Case A.2: Obstacle Wall Collision Lock - If position is in profit and price hits an active CRITICAL/STRONG obstacle without breakout momentum
        try {
          const activeObstacles = findGoldHistoricalObstacles({
            m5Bars,
            m15Bars: m15Bars || [],
            h1Bars: h1Bars || [],
            currentPrice,
            direction: isBuy ? 'BUY' : 'SELL',
            atr
          });
          const hitZone = activeObstacles.nearestZone;
          if (hitZone && profitDistance >= 0.80) {
            const distToZone = isBuy ? (hitZone.frontEdge - currentPrice) : (currentPrice - hitZone.frontEdge);
            if (distToZone <= 0.35 * atr && (hitZone.threatLevel === 'CRITICAL' || hitZone.threatLevel === 'STRONG')) {
              const bEval = evaluateBarrierBreakoutViability({
                currentPressure: marketPressure,
                m5Bars,
                obstacleZone: hitZone,
                direction: isBuy ? 'BUY' : 'SELL',
                atr,
                adx: ind.mlFeatures?.adx_14 || 20.0
              });
              if (!bEval.canBreakout) {
                console.log(`🛡️ [Gold Barrier Collision Lock] ไม้ #${ticket} กำไร +$${profitDistance.toFixed(2)} แต่ชนแนวสำคัญในอดีต $${hitZone.frontEdge.toFixed(2)} (${hitZone.threatLevel} | แรงสวน -$${hitZone.maxReactionDistance}) โดยที่แรงส่งปัจจุบันไม่พอ (${bEval.bfi} < 1.35) -> ชิงปิดล็อกกำไรทันทีที่จุดสูงสุด!`);
                const closeRes = await closePosition(ticket);
                if (closeRes && closeRes.success) {
                  await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_BARRIER_LOCK' WHERE mt5_ticket = ?`, [ticket]);
                  await recordTradeExit({
                    ticket,
                    symbol: 'GOLD',
                    exitPrice: currentPrice,
                    exitReason: 'CLOSED_BARRIER_LOCK',
                    realProfit: closeRes.profit ?? null
                  });
                  continue;
                }
              }
            }
          }
        } catch (obsLockErr) {
          console.warn('⚠️ Obstacle barrier lock check skipped:', obsLockErr.message);
        }

        // Case B: Smart Reversal & Adverse Pressure Early Cut (Save Capital Before Full SL)
        // 1) Pattern Reversal Guard: Opposing pattern (Divergence/SFP/Engulfing) + adverse pressure
        // 2) Severe Adverse Flow: Loss >= 1.0x ATR and adverse pressure >= 42% or adverseState
        // 3) Drawdown Danger Guard: Loss >= 1.35x ATR (>= $6.00) and adverse pressure >= 38%
        const inDrawdown = profitDistance <= -Math.max(3.50, 0.8 * atr);
        const isReversalArmed = (hasOpposingReversal || adverseReversalFlow) && (pAdverse >= 0.35 || adverseState);
        const isSevereAdverse = profitDistance <= -Math.max(4.50, 1.0 * atr) && (pAdverse >= earlyCutAdverseThreshold || adverseState);
        const isDangerAdverse = profitDistance <= -Math.max(6.00, 1.35 * atr) && pAdverse >= 0.38;

        if (inDrawdown && heldMinutes >= 5 && (isReversalArmed || isSevereAdverse || isDangerAdverse)) {
          const cutTrigger = isReversalArmed 
            ? `ตรวจพบรูปแบบกลับตัวสวนทาง (${reversalReason || 'Adverse Flow'}) + แรงสวน ${(pAdverse*100).toFixed(0)}%`
            : (isSevereAdverse ? `แรงผลักสวนทางชัดเจน ${(pAdverse*100).toFixed(0)}% (${marketPressure.state})` : `เสี่ยงชน SL (ติดลบ -$${Math.abs(profitDistance).toFixed(2)})`);
          console.log(`✂️ [Gold Pressure Early Cut] ไม้ #${ticket} ติดลบ -$${Math.abs(profitDistance).toFixed(2)} | ${cutTrigger} -> ชิงตัดขาดทุนล่วงหน้ารักษาทุน!`);
          const closeRes = await closePosition(ticket);
          if (closeRes && closeRes.success) {
            await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_PRESSURE_EARLY_CUT' WHERE mt5_ticket = ?`, [ticket]);
            await recordTradeExit({
              ticket,
              symbol: 'GOLD',
              exitPrice: currentPrice,
              exitReason: 'CLOSED_PRESSURE_EARLY_CUT',
              realProfit: closeRes.profit ?? null
            });
            continue;
          }
        }
      }

      // 3. Strict Scalp Time-Stop for Gold: Configurable hold duration (Default 75 minutes)
      const goldMaxHoldMinutes = Math.max(15, Number(process.env.GOLD_MAX_HOLD_MINUTES || 75));
      if (heldMinutes >= goldMaxHoldMinutes) {
        console.log(`⏱️ [Gold Scalp Time-Stop] ไม้ #${ticket} ถือครบ ${heldMinutes} นาที (>= ${goldMaxHoldMinutes}m) -> ปิดตัดรอบทำความสะอาดทันที ($${profitDistance > 0 ? '+' : ''}${profitDistance.toFixed(2)})`);
        const closeRes = await closePosition(ticket);
        if (closeRes && closeRes.success) {
          await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP' WHERE mt5_ticket = ?`, [ticket]);
          await recordTradeExit({
            ticket,
            symbol: 'GOLD',
            exitPrice: currentPrice,
            exitReason: 'CLOSED_TIME_STOP',
            realProfit: closeRes.profit ?? null
          });
          continue;
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Error during Gold open position management:', err.message);
  }

  // 3. Evaluate New Entry Setups
  const ind = calculateGoldIndicators(m5Bars);
  if (!ind) return { success: false, message: 'Failed to calculate indicators' };

  // Check H1 Trend
  let h1Bullish = true;
  if (h1Bars && h1Bars.length >= 20) {
    const h1Closes = h1Bars.map(b => Number(b.close));
    const h1Ema20 = EMA.calculate({ period: 20, values: h1Closes });
    const lastH1Ema20 = h1Ema20[h1Ema20.length - 1] || h1Closes[h1Closes.length - 1];
    h1Bullish = h1Closes[h1Closes.length - 1] > lastH1Ema20;
  }

  const { lastClose, lastHigh, lastLow, ema21, ema50, ema200, rsi, atr, asianHigh, asianLow } = ind;

  let signalAction = null;
  let setupName = '';
  let hasSweep = false;
  let emaPullback = false;

  // Setup 1: Liquidity Sweep of Asian High/Low during London or Overlap
  if (session === 'LONDON_OPEN' || session === 'LONDON_NY_OVERLAP') {
    if (lastHigh > asianHigh && lastClose < asianHigh && rsi > 65) {
      signalAction = 'SELL';
      setupName = 'London/NY Liquidity Sweep of Asian High';
      hasSweep = true;
    } else if (lastLow < asianLow && lastClose > asianLow && rsi < 35) {
      signalAction = 'BUY';
      setupName = 'London/NY Liquidity Sweep of Asian Low';
      hasSweep = true;
    }
  }

  // Setup 2: Dynamic Trend Pullback to EMA 21 / EMA 50 with Anti-Waterfall Guard
  if (!signalAction) {
    const isEmaUptrend = lastClose > ema50 && ema50 > ema200 && h1Bullish;
    const isEmaDowntrend = lastClose < ema50 && ema50 < ema200 && !h1Bullish;

    if (isEmaUptrend && lastLow <= ema21 && lastClose > ema21 && rsi >= 35 && rsi <= 55) {
      const curBar = m5Bars[m5Bars.length - 1];
      const prevBar = m5Bars[m5Bars.length - 2] || curBar;
      const prevBar2 = m5Bars[m5Bars.length - 3] || prevBar;
      const prevBar3 = m5Bars[m5Bars.length - 4] || prevBar2;

      const isWaterfallDump = (
        Number(prevBar.close) < Number(prevBar.open) &&
        Number(prevBar2.close) < Number(prevBar2.open) &&
        Number(prevBar3.close) < Number(prevBar3.open) &&
        Number(curBar.close) < Number(curBar.open)
      );

      if (!isWaterfallDump) {
        signalAction = 'BUY';
        setupName = 'Dynamic Trend Pullback to EMA 21';
        emaPullback = true;
      } else {
        console.log(`🛡️ [Gold Anti-Falling-Knife] GOLD BUY Pullback ข้าม: แท่งเทียนดิ่งรวดเดียว 4 แท่งซ้อน (Waterfall Dump)`);
      }
    } else if (isEmaDowntrend && lastHigh >= ema21 && lastClose < ema21 && rsi >= 45 && rsi <= 65) {
      const curBar = m5Bars[m5Bars.length - 1];
      const prevBar = m5Bars[m5Bars.length - 2] || curBar;
      const prevBar2 = m5Bars[m5Bars.length - 3] || prevBar;
      const prevBar3 = m5Bars[m5Bars.length - 4] || prevBar2;

      const isRocketRally = (
        Number(prevBar.close) > Number(prevBar.open) &&
        Number(prevBar2.close) > Number(prevBar2.open) &&
        Number(prevBar3.close) > Number(prevBar3.open) &&
        Number(curBar.close) > Number(curBar.open)
      );

      if (!isRocketRally) {
        signalAction = 'SELL';
        setupName = 'Dynamic Trend Pullback to EMA 21';
        emaPullback = true;
      } else {
        console.log(`🛡️ [Gold Anti-Falling-Knife] GOLD SELL Pullback ข้าม: แท่งเทียนพุ่งเขียว 4 แท่งซ้อน (Rocket Rally)`);
      }
    }
  }

  // Setup 3: Gold Trend Momentum (EMA 21/50 Alignment & RSI Momentum)
  if (!signalAction) {
    if (lastClose > ema21 && ema21 > ema50 && rsi >= 42 && rsi <= 75) {
      signalAction = 'BUY';
      setupName = 'Gold Trend Momentum (Bullish Confluence)';
      emaPullback = true;
    } else if (lastClose < ema21 && ema21 < ema50 && rsi >= 25 && rsi <= 58) {
      signalAction = 'SELL';
      setupName = 'Gold Trend Momentum (Bearish Confluence)';
      emaPullback = true;
    }
  }

  if (!signalAction) {
    console.log(`[+] [Gold Engine] 🟡 ราคา: $${lastClose.toFixed(2)} | RSI: ${rsi.toFixed(1)} | ATR: $${atr.toFixed(2)} | Session: ${session} (ไม่มีจังหวะเข้าเทรด)`);
    return {
      success: true,
      message: `GOLD วิเคราะห์เสร็จสิ้น: ไม่มีจังหวะเข้าเทรด (Close: ${lastClose}, RSI: ${rsi.toFixed(1)}, Session: ${session})`
    };
  }

  // Evaluate AI Confidence using Dedicated Gold ML Model (12 features)
  const goldFeatures = {
    ...ind.mlFeatures,
    direction: signalAction,
    session: session,
    has_sweep: hasSweep,
    ema_pullback: emaPullback
  };

  const aiRes = await predictGoldConfidence(goldFeatures);
  if (aiRes?.modelAvailable === false) {
    console.warn('[Gold Model Gate] Python model unavailable; skipping this live candidate');
    return { success: false, status: 'MODEL_UNAVAILABLE', error: aiRes.error || null };
  }
  const rawBaseConfidence = aiRes?.confidence || 0.60;
  const rawBaseScore = signalAction === 'BUY'
    ? Number(aiRes?.raw_buy ?? aiRes?.prob_buy ?? rawBaseConfidence)
    : Number(aiRes?.raw_sell ?? aiRes?.prob_sell ?? rawBaseConfidence);
  const modelVersion = aiRes?.model_version || 'gold-v1.1.0';

  // =========================================================================
  // Dynamic Modulation Pipeline (Aligns with Forex & Crypto Pattern & Pressure)
  // Step 1: Technical & Pattern Signal Filter (Base Modifier)
  // Step 2: Market Pressure Confirmation (+/- Modifier)
  // Step 3: Modulate Confidence & Raw Directional Conviction Score
  // =========================================================================
  let patternBonus = 0;
  const filterReasons = [];

  // Pattern 1: Liquidity Sweep of Asian High/Low (+5% confidence)
  if (hasSweep) {
    patternBonus += 0.05;
    filterReasons.push('Liquidity Sweep of Asian High/Low (+5% Conf)');
  }

  // Pattern 2: Dynamic Trend Pullback to EMA (+3% confidence)
  if (emaPullback) {
    patternBonus += 0.03;
    filterReasons.push('Dynamic EMA Trend Pullback (+3% Conf)');
  }

  // Pattern 3: Overextension Guard (-5% penalty if RSI is deeply overbought/oversold)
  const isOverextended = (signalAction === 'BUY' && rsi >= 75) || (signalAction === 'SELL' && rsi <= 25);
  if (isOverextended) {
    patternBonus -= 0.05;
    filterReasons.push(`Overextended RSI ${rsi.toFixed(1)} (-5% Conf)`);
  }

  // Pattern 4: Wick Rejection Filter (-15% penalty instead of blunt hard-veto)
  if (GOLD_REJECTION_FILTER_ENABLED) {
    const rejectionCheck = checkRejectionCandle(m5Bars, signalAction, atr);
    if (rejectionCheck.hasRejection) {
      patternBonus -= 0.15;
      filterReasons.push(`Fake Signal Trap / Rejection Wick: ${rejectionCheck.reason} (-15% Conf)`);
      console.log(`⚠️ [Gold Rejection Filter] GOLD ${signalAction}: ${rejectionCheck.reason} (-15% Conf)`);
    }
  }

  // Pattern 5: Reversal Trap Guard (Divergence, SFP, Reversal Candlesticks)
  try {
    const rsiCalc = RSI.calculate({ period: 14, values: m5Bars.map(b => Number(b.close)) });
    const reversalCheck = checkComprehensiveReversal(m5Bars, { rsiSeries: rsiCalc }, signalAction);
    if (reversalCheck.hasOpposingReversal) {
      patternBonus -= reversalCheck.confidencePenalty;
      filterReasons.push(`Opposing Reversal Trap: ${reversalCheck.reason} (-${(reversalCheck.confidencePenalty * 100).toFixed(0)}% Conf)`);
      console.log(`🚨 [Gold Reversal Trap] GOLD ${signalAction}: ${reversalCheck.reason} (-${(reversalCheck.confidencePenalty * 100).toFixed(0)}% Conf)`);
    }
  } catch {}

  // Step 2: Market Pressure Confirmation (+/- Modifier)
  let pressureDelta = 0;
  let pressureReason = '';
  const pBuy = Number(marketPressure?.probabilities?.buy_pressure || 0);
  const pSell = Number(marketPressure?.probabilities?.sell_pressure || 0);
  const pChop = Number(marketPressure?.probabilities?.indecision || 0);

  const counterThreshold = Number(process.env.GOLD_PRESSURE_COUNTER_THRESHOLD || 0.42);
  const chopThreshold = Number(process.env.GOLD_PRESSURE_CHOP_THRESHOLD || 0.48);

  const isCounterPressure = (signalAction === 'BUY' && (marketPressure?.state === 'SELL_PRESSURE' || pSell >= counterThreshold))
    || (signalAction === 'SELL' && (marketPressure?.state === 'BUY_PRESSURE' || pBuy >= counterThreshold));
  const isIndecisionChop = marketPressure?.state === 'INDECISION_CHOP' || pChop >= chopThreshold;

  if (GOLD_MARKET_PRESSURE_ENABLED && marketPressure) {
    if (signalAction === 'BUY') {
      if (marketPressure.state === 'BUY_PRESSURE') {
        pressureDelta = 0.08 + Math.min(0.06, Math.max(0, (pBuy - 0.40) * 0.5)); // +8% to +14%
        pressureReason = `🟢 Market Pressure ยืนยันแรงซื้อ BUY_PRESSURE (${(pBuy * 100).toFixed(0)}%) -> เพิ่มความมั่นใจ +${(pressureDelta * 100).toFixed(1)}%`;
      } else if (pBuy > pSell && pBuy >= 0.35 && marketPressure.state !== 'SELL_PRESSURE') {
        pressureDelta = 0.04;
        pressureReason = `🟢 Market Pressure โอนเอียงฝั่งซื้อ (${(pBuy * 100).toFixed(0)}% > ${(pSell * 100).toFixed(0)}%) -> เพิ่มความมั่นใจ +4.0%`;
      } else if (isCounterPressure) {
        pressureDelta = -0.25;
        pressureReason = `🔴 Counter-Pressure ตรวจพบแรงฝั่งตรงข้ามสวนมา (${(pSell * 100).toFixed(0)}%) -> ลดความมั่นใจ -25.0%`;
      } else if (isIndecisionChop) {
        const chopWeight = Math.min(0.08, Math.max(0, (pChop - 0.35) * 0.5));
        pressureDelta = -(0.08 + chopWeight); // -8% to -16%
        pressureReason = `🟡 Market Pressure สภาวะ INDECISION_CHOP (${(pChop * 100).toFixed(0)}% ไร้แรงขับเคลื่อน) -> ปรับลดความมั่นใจ -${(Math.abs(pressureDelta) * 100).toFixed(1)}%`;
      }
    } else if (signalAction === 'SELL') {
      if (marketPressure.state === 'SELL_PRESSURE') {
        pressureDelta = 0.08 + Math.min(0.06, Math.max(0, (pSell - 0.40) * 0.5)); // +8% to +14%
        pressureReason = `🔴 Market Pressure ยืนยันแรงขาย SELL_PRESSURE (${(pSell * 100).toFixed(0)}%) -> เพิ่มความมั่นใจ +${(pressureDelta * 100).toFixed(1)}%`;
      } else if (pSell > pBuy && pSell >= 0.35 && marketPressure.state !== 'BUY_PRESSURE') {
        pressureDelta = 0.04;
        pressureReason = `🔴 Market Pressure โอนเอียงฝั่งขาย (${(pSell * 100).toFixed(0)}% > ${(pBuy * 100).toFixed(0)}%) -> เพิ่มความมั่นใจ +4.0%`;
      } else if (isCounterPressure) {
        pressureDelta = -0.25;
        pressureReason = `🔴 Counter-Pressure ตรวจพบแรงฝั่งตรงข้ามสวนมา (${(pBuy * 100).toFixed(0)}%) -> ลดความมั่นใจ -25.0%`;
      } else if (isIndecisionChop) {
        const chopWeight = Math.min(0.08, Math.max(0, (pChop - 0.35) * 0.5));
        pressureDelta = -(0.08 + chopWeight); // -8% to -16%
        pressureReason = `🟡 Market Pressure สภาวะ INDECISION_CHOP (${(pChop * 100).toFixed(0)}% ไร้แรงขับเคลื่อน) -> ปรับลดความมั่นใจ -${(Math.abs(pressureDelta) * 100).toFixed(1)}%`;
      }
    }
  }

  // Step 3: Modulate Confidence & Raw Score proportionally
  const netDelta = pressureDelta + patternBonus;
  const confidence = Number(Math.min(0.98, Math.max(0.05, rawBaseConfidence + netDelta)).toFixed(4));
  const pressureMultiplier = 1 + (netDelta / Math.max(0.20, rawBaseConfidence));
  const rawScore = Number(Math.min(0.95, Math.max(0.01, rawBaseScore * pressureMultiplier)).toFixed(4));

  console.log(`🎯 [Gold Confidence Modulation] ${signalAction} | Setup: ${setupName} | Base: ${(rawBaseConfidence * 100).toFixed(1)}% (${netDelta >= 0 ? '+' : ''}${(netDelta * 100).toFixed(1)}%) -> Modulated: ${(confidence * 100).toFixed(1)}% | Raw Score: ${rawBaseScore.toFixed(4)} -> ${rawScore.toFixed(4)} | Price: $${lastClose.toFixed(2)}`);
  if (pressureReason) {
    console.log(`   └─ ${pressureReason}`);
  }

  if (confidence < GOLD_CONFIDENCE_THRESHOLD) {
    console.log(`🛡️ [Gold Gating] ความมั่นใจ ${(confidence * 100).toFixed(1)}% < ${(GOLD_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% (หลังคำนวณ Market Pressure +/-) -> ข้ามคำสั่ง`);
    return { success: true, message: `Confidence below threshold: ${confidence}` };
  }

  if (rawScore < GOLD_RAW_SCORE_THRESHOLD) {
    console.log(`🛡️ [Gold Raw Conviction Guard] ความมั่นใจแท้จริง ${(rawScore * 100).toFixed(1)}% < ${(GOLD_RAW_SCORE_THRESHOLD * 100).toFixed(1)}% (หลังคำนวณ Market Pressure +/-) -> ข้ามคำสั่ง`);
    return { success: true, message: `Raw score below threshold: ${rawScore}` };
  }

  // Safety Shield: Extreme Counter-Pressure veto (> 45% opposing push)
  if (isCounterPressure && (signalAction === 'BUY' ? pSell >= 0.45 : pBuy >= 0.45)) {
    console.log(`🛡️ [Gold Counter-Pressure Shield] ตรวจพบแรงฝั่งตรงข้ามสวนมารุนแรง (${signalAction === 'BUY' ? `Sell ${(pSell*100).toFixed(0)}%` : `Buy ${(pBuy*100).toFixed(0)}%`} >= 45%) -> สกัดกั้นคำสั่งเพื่อความปลอดภัย`);
    return { success: true, message: 'Blocked by Market Counter-Pressure Shield' };
  }

  // Calculate SL/TP with Multi-Day Historical Obstacle Pressure & Safe Geometry Guard
  let slBuffer = Math.max(4.00, Number((3.0 * atr).toFixed(2)));
  const defaultTpBuffer = Math.max(6.00, Number((4.5 * atr).toFixed(2)));

  // Analyze Multi-Day Historical Obstacles across M5, M15 (50h), and H1 (72h / 3 days)
  const obstacleAnalysis = findGoldHistoricalObstacles({
    m5Bars,
    m15Bars: m15Bars || [],
    h1Bars: h1Bars || [],
    currentPrice: lastClose,
    direction: signalAction,
    atr
  });

  const nearestZone = obstacleAnalysis.nearestZone;
  const goldMinRr = Number(process.env.GOLD_MIN_RISK_REWARD || 1.15);
  const minTargetRoom = Math.max(6.00, 1.5 * atr);
  const safeBuffer = Math.max(1.20, Number((0.25 * atr).toFixed(2)));

  // Determine Safe TP before nearest structural obstacle and evaluate Breakout Viability
  let tpBuffer = defaultTpBuffer;
  if (nearestZone) {
    const rawDistanceToBarrier = signalAction === 'BUY'
      ? nearestZone.frontEdge - lastClose
      : lastClose - nearestZone.frontEdge;

    const safeDistanceToBarrier = rawDistanceToBarrier - safeBuffer;

    // Evaluate if Current Momentum & Market Pressure have the strength to Break Through this Barrier
    const breakoutCheck = evaluateBarrierBreakoutViability({
      currentPressure: marketPressure,
      m5Bars,
      obstacleZone: nearestZone,
      direction: signalAction,
      atr,
      adx: ind.mlFeatures.adx_14
    });

    console.log(`🧭 [Gold Historical Obstacle Analysis] ${signalAction} | ตรวจพบแนวขวางใกล้สุด: $${nearestZone.frontEdge.toFixed(2)} (ระดับ: ${nearestZone.threatLevel} | ชนซ้ำ: ${nearestZone.touchCount} ครั้ง | แรงสวนอดีต: $${nearestZone.maxReactionDistance.toFixed(2)} [${nearestZone.maxReactionAtrRatio.toFixed(1)}x ATR] | Wick: ${(nearestZone.maxWickRatio*100).toFixed(0)}% | ล่าสุด: ${nearestZone.latestTime})`);
    console.log(`   └─ การประเมินโอกาสทะลุแนว: ${breakoutCheck.reason}`);

    if (breakoutCheck.canBreakout) {
      // MODE A: CONFIRMED BREAKOUT EXPANSION (Current force is strong enough to pierce old barrier!)
      console.log(`🚀 [Gold Breakout Expansion] ปรับกลยุทธ์เป็น Breakout Ride ทะลุแนว $${nearestZone.frontEdge.toFixed(2)}! ขยายเป้าหมาย TP ไปยังแนวต้านถัดไป`);
      // Target next tier obstacle if available
      const nextZone = obstacleAnalysis.zones[1];
      if (nextZone) {
        const nextDist = signalAction === 'BUY' ? nextZone.frontEdge - lastClose : lastClose - nextZone.frontEdge;
        tpBuffer = Math.max(defaultTpBuffer, Number((nextDist - safeBuffer).toFixed(2)));
      } else {
        tpBuffer = Number((defaultTpBuffer * 1.25).toFixed(2));
      }
      // Tighten SL just below the broken barrier (Resistance flipped to Support)
      slBuffer = Math.max(3.50, Number((Math.abs(lastClose - nearestZone.frontEdge) + 0.5 * atr).toFixed(2)));
      console.log(`🎯 [Gold Breakout Execution] TP ตั้งที่ $${signalAction === 'BUY' ? (lastClose + tpBuffer).toFixed(2) : (lastClose - tpBuffer).toFixed(2)} | SL กระชับหลังแนวทะลุที่ $${signalAction === 'BUY' ? (lastClose - slBuffer).toFixed(2) : (lastClose + slBuffer).toFixed(2)} (Buffer $${slBuffer})`);
    } else {
      // MODE B: REJECTION & COLLISION AVOIDANCE (Current force is NOT enough to break the wall)
      // Veto Guard 1: Direct Obstacle Collision (ชนแนวต้าน/รับสำคัญทันที หรือพื้นที่วิ่งเหลือน้อยเกินไป)
      if (safeDistanceToBarrier < minTargetRoom) {
        console.log(`🛡️ [Gold Obstacle Guard] ${signalAction} VETO: มีแนวสำคัญในอดีต ($${nearestZone.frontEdge.toFixed(2)} | แรงสวน -$${nearestZone.maxReactionDistance.toFixed(2)}) ขวางอยู่ใกล้เกินไป (พื้นที่ปลอดภัยเหลือเพียง $${safeDistanceToBarrier.toFixed(2)} < เกณฑ์ขั้นต่ำ $${minTargetRoom.toFixed(2)}) -> สกัดกั้นคำสั่งเพื่อความปลอดภัย`);
        return { success: true, message: `Blocked by Gold Historical Obstacle Guard (room: ${safeDistanceToBarrier.toFixed(2)} < min: ${minTargetRoom.toFixed(2)})` };
      }

      // Veto Guard 2: Safe Risk-to-Reward Unviability
      const potentialRr = safeDistanceToBarrier / slBuffer;
      if (potentialRr < goldMinRr) {
        console.log(`🛡️ [Gold Obstacle Guard] ${signalAction} VETO: R:R ถึงเป้าหมายปลอดภัยหน้าแนวต้าน/รับ ($${nearestZone.frontEdge.toFixed(2)}) ไม่คุ้มค่า (1:${potentialRr.toFixed(2)} < เกณฑ์ 1:${goldMinRr.toFixed(2)}) -> สกัดกั้นคำสั่งเพื่อความปลอดภัย`);
        return { success: true, message: `Blocked by Gold Obstacle R:R Guard (R:R: ${potentialRr.toFixed(2)} < ${goldMinRr.toFixed(2)})` };
      }

      // Veto Guard 3: Critical Multi-Day Threat Zone within 2.0x ATR
      if (nearestZone.threatLevel === 'CRITICAL' && safeDistanceToBarrier < 2.0 * atr) {
        console.log(`🛡️ [Gold Obstacle Guard] ${signalAction} VETO: ชนแนวสำคัญรุนแรงข้ามวัน ($${nearestZone.frontEdge.toFixed(2)} | แรงสวนอดีต -$${nearestZone.maxReactionDistance.toFixed(2)} [${nearestZone.maxReactionAtrRatio.toFixed(1)}x ATR]) ในระยะกระชั้นชิด ($${safeDistanceToBarrier.toFixed(2)} < ${(2.0 * atr).toFixed(2)}) -> สกัดกั้นคำสั่งเพื่อความปลอดภัย`);
        return { success: true, message: `Blocked by Gold Critical Obstacle Proximity Guard` };
      }

      // If Passed All Safety Checks: Set TP safely in front of the structural barrier
      if (safeDistanceToBarrier < defaultTpBuffer) {
        tpBuffer = Number(safeDistanceToBarrier.toFixed(2));
        console.log(`🎯 [Gold Safe TP Placement] ล็อกเป้าหมายปลอดภัยหน้าแนวสำคัญ ($${nearestZone.frontEdge.toFixed(2)} - Buffer $${safeBuffer.toFixed(2)}) -> TP Buffer ปรับเป็น $${tpBuffer.toFixed(2)} (R:R 1:${potentialRr.toFixed(2)})`);
      }
    }
  }

  const slPrice = signalAction === 'BUY'
    ? Number((lastClose - slBuffer).toFixed(2))
    : Number((lastClose + slBuffer).toFixed(2));
  const tpPrice = signalAction === 'BUY'
    ? Number((lastClose + tpBuffer).toFixed(2))
    : Number((lastClose - tpBuffer).toFixed(2));

  // Gold is intentionally shadow-only until GOLD_LIVE_ENABLED is enabled.
  // Keep a signal record for later evaluation, but never call the MT5 broker.
  if (!GOLD_LIVE_ENABLED) {
    try {
      const [recentShadow] = await pool.query(
        `SELECT id FROM signals
         WHERE symbol = 'GOLD' AND market_type = 'gold'
           AND source_tag = 'gold_shadow'
           AND time >= NOW() - INTERVAL 5 MINUTE
         LIMIT 1`
      );
      if (recentShadow.length === 0) {
        await pool.query(
          `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket, source_tag)
           VALUES (NOW(), 'GOLD', ?, ?, ?, ?, ?, 'gold', NULL, 'gold_shadow')`,
          [lastClose, confidence, slPrice, tpPrice, signalAction]
        );
      }
    } catch (shadowErr) {
      console.warn('⚠️ ไม่สามารถบันทึก Gold shadow signal:', shadowErr.message);
    }
    console.log(`🟡 [GOLD SHADOW] ${signalAction} @ $${lastClose.toFixed(2)} | Confidence: ${(confidence * 100).toFixed(1)}% | SL: $${slPrice} | TP: $${tpPrice} | Model: ${modelVersion} (Shadow Mode)`);
    return {
      success: true,
      mode: 'SHADOW',
      action: signalAction,
      symbol: 'GOLD',
      price: lastClose,
      ticket: null,
      confidence,
      modelVersion
    };
  }

  // Check active positions count for GOLD / XAUUSD
  let liveGoldPositions = [];
  if (GOLD_MT5_LIVE) {
    try {
      const livePositions = await getOpenPositions();
      if (Array.isArray(livePositions)) {
        liveGoldPositions = livePositions.filter(p =>
          ['GOLD', 'XAUUSD', 'XAUUSD=X'].includes(String(p.symbol || '').toUpperCase())
        );
      }
    } catch (e) {}
  }

  const [dbGoldPositions] = await pool.query(
    `SELECT mt5_ticket FROM trade_results WHERE market_type = 'gold' AND exit_reason = 'OPEN' AND mt5_ticket IS NOT NULL`
  );

  const activeGoldCount = Math.max(liveGoldPositions.length, dbGoldPositions.length);

  if (activeGoldCount >= GOLD_MAX_POSITIONS) {
    console.log(`🛡️ [Gold Guard] มีออเดอร์ GOLD ครบตามลิมิตแล้ว (${activeGoldCount}/${GOLD_MAX_POSITIONS} ไม้) -> ข้ามคำสั่งใหม่`);
    return { success: true, message: `Active GOLD positions reached limit: ${activeGoldCount}/${GOLD_MAX_POSITIONS}` };
  }

  // Place MT5 Order
  let mt5Result = null;
  if (GOLD_MT5_LIVE) {
    try {
      mt5Result = await placeOrder({
        symbol: 'GOLD',
        action: signalAction,
        lot: GOLD_LOT_SIZE,
        volume: GOLD_LOT_SIZE,
        sl: slPrice,
        tp: tpPrice,
        comment: `AI GOLD ${modelVersion}`
      });
      console.log(`🚀 [MT5 Order Executed] GOLD ${signalAction} | Ticket: ${mt5Result?.ticket} | Price: ${mt5Result?.price}`);
    } catch (err) {
      console.error('❌ ไม่สามารถส่งคำสั่ง GOLD ไปยัง MT5:', err.message);
    }
  }

  const finalTicket = mt5Result?.ticket || null;
  const executionPrice = Number(mt5Result?.price || lastClose);

  // Never persist a blocked/failed MT5 request as a live GOLD position.
  if (GOLD_MT5_LIVE && !finalTicket) {
    console.warn(`⏭️ [GOLD SHADOW GUARD] ${signalAction} ไม่มี MT5 ticket -> ไม่บันทึกเป็น live position`);
    return {
      success: true,
      skipped: true,
      mode: 'SHADOW',
      reason: mt5Result?.error || 'MT5 order was not executed',
      action: signalAction,
      symbol: 'GOLD'
    };
  }

  // Record into Database
  try {
    await pool.query(
      `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket)
       VALUES (NOW(), 'GOLD', ?, ?, ?, ?, ?, 'gold', ?)`,
      [executionPrice, confidence, slPrice, tpPrice, signalAction, finalTicket]
    );

    await pool.query(
      `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note, market_type, mt5_ticket)
       VALUES ('GOLD', NOW(), ?, ?, ?, ?, ?, 'gold', ?)
       ON DUPLICATE KEY UPDATE
         entry_date = VALUES(entry_date),
         entry_price = VALUES(entry_price),
         highest_price = VALUES(highest_price),
         sl_price = VALUES(sl_price),
         tp_price = VALUES(tp_price),
         status_note = VALUES(status_note),
         mt5_ticket = VALUES(mt5_ticket)`,
      [executionPrice, executionPrice, slPrice, tpPrice, `GOLD_${signalAction}_OPEN`, finalTicket]
    );

    if (finalTicket) {
      await recordTradeEntry({
        ticket: finalTicket,
        symbol: 'GOLD',
        marketType: 'gold',
        action: signalAction,
        lotSize: GOLD_LOT_SIZE,
        entryPrice: executionPrice,
        sl: slPrice,
        tp: tpPrice,
        confidence,
        modelSource: 'gold_ml_ensemble',
        modelVersion: modelVersion,
        indicators: {
          rsi: goldFeatures.rsi_14,
          atr,
          adx: goldFeatures.adx_14,
          bb_width: goldFeatures.bb_width,
          session: session,
          has_sweep: hasSweep
        },
        reasons: [setupName],
        predictionMeta: {
          feature_version: 'gold12-v1',
          features: goldFeatures,
          prediction: aiRes,
          modulation: {
            rawBaseConfidence,
            rawBaseScore,
            patternBonus,
            pressureDelta,
            netDelta,
            filterReasons,
            modulatedConfidence: confidence,
            modulatedRawScore: rawScore
          }
        },
        sourceTag: 'gold_engine'
      });
    }
  } catch (dbErr) {
    console.error('❌ บันทึกสถานะ GOLD ลงฐานข้อมูลล้มเหลว:', dbErr.message);
  }

  return {
    success: true,
    action: signalAction,
    symbol: 'GOLD',
    price: executionPrice,
    ticket: finalTicket,
    confidence
  };
}
