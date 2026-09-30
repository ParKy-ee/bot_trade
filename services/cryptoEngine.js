import { getPool } from '../config/database.js';
import { CRYPTO_UNIVERSE, fetchBinanceCryptoDataParallel } from './marketData.js';
import { placeOrder, modifyStopLoss, closePosition, getRates, getOpenPositions } from './mt5Broker.js';
import { recordTradeEntry, recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';
import { predictCryptoConfidence, predictForexMarketPressure } from './modelPredictor.js';
import { recordMarketPressureObservation } from './marketPressureObservationTracker.js';
import { checkRejectionCandle, checkComprehensiveReversal, findStructuralInvalidationBarrier } from './forexPriceAction.js';
import { evaluateSrRejectionHarvest } from './forexExitEngine.js';
import { EMA, RSI, ATR, BollingerBands, ADX, MACD } from 'technicalindicators';
import dotenv from 'dotenv';

dotenv.config();

const CRYPTO_DATA_HARVEST_LIVE_MODE = process.env.CRYPTO_DATA_HARVEST_LIVE_MODE === 'true';
const CRYPTO_LIVE_ENABLED = process.env.CRYPTO_LIVE_ENABLED === 'true';
const CRYPTO_CONFIDENCE_THRESHOLD = Number(process.env.CRYPTO_CONFIDENCE_THRESHOLD || (CRYPTO_DATA_HARVEST_LIVE_MODE ? 0.20 : 0.50));
const CRYPTO_RAW_SCORE_THRESHOLD = Number(process.env.CRYPTO_RAW_SCORE_THRESHOLD || 0.22);
const CRYPTO_REJECTION_FILTER_ENABLED = process.env.CRYPTO_REJECTION_FILTER_ENABLED !== 'false';
const CRYPTO_MAX_POSITIONS_PER_SYMBOL = Math.max(1, Number(process.env.CRYPTO_MAX_POSITIONS_PER_SYMBOL || 4));
const CRYPTO_LOT_SIZE = Number(process.env.CRYPTO_LOT_SIZE || 0.01);
const CRYPTO_MODEL_SOURCE_FALLBACK = 'crypto_quantitative_fallback';
const CRYPTO_MARKET_PRESSURE_ENABLED = process.env.CRYPTO_MARKET_PRESSURE_ENABLED !== 'false';
const CRYPTO_PRESSURE_EXIT_ENABLED = process.env.CRYPTO_PRESSURE_EXIT_ENABLED !== 'false';

function validateCryptoExitGeometry(action, entryPrice, slPrice, tpPrice) {
  const entry = Number(entryPrice);
  const sl = Number(slPrice);
  const tp = Number(tpPrice);
  const validNumbers = [entry, sl, tp].every(Number.isFinite);
  if (!validNumbers) return false;
  return String(action).toUpperCase() === 'BUY'
    ? sl < entry && tp > entry
    : sl > entry && tp < entry;
}

/**
 * Check if it is currently weekend (Saturday/Sunday UTC).
 */
export function isWeekendCrypto() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Calculates technical indicators tailored for Crypto (BTCUSD, ETHUSD, SOLUSD) M5 trading.
 */
function calculateCryptoIndicators(bars) {
  if (!bars || bars.length < 35) return null;

  const closes = bars.map(b => Number(b.close));
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const volumes = bars.map(b => Number(b.volume || b.tick_volume || 1));
  const n = closes.length;

  const ema20Values = EMA.calculate({ period: 20, values: closes });
  const ema50Values = EMA.calculate({ period: 50, values: closes });
  const ema200Values = EMA.calculate({ period: Math.min(200, Math.floor(n * 0.9)), values: closes });
  const rsi14Values = RSI.calculate({ period: 14, values: closes });
  const atr14Values = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bbValues = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const adxValues = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  // Volume moving average (20) based on COMPLETED bars (bars[n-2]) to avoid open-bar volume trap
  const closedVolumes = volumes.slice(-21, -1);
  const avgVolume20 = closedVolumes.reduce((a, b) => a + b, 0) / (closedVolumes.length || 1);
  const lastClosedVol = volumes[n - 2] || volumes[n - 1] || 1;
  const volumeRatio = Number((lastClosedVol / (avgVolume20 + 1e-9)).toFixed(2));

  // Bollinger BandWidth calculation and Prior Squeeze detection
  const bandWidths = bbValues.map(b => (b.upper - b.lower) / (b.middle + 1e-9));
  const recentBandWidths = bandWidths.slice(-20);
  const minRecentBw = Math.min(...recentBandWidths);
  const curBw = bandWidths[bandWidths.length - 1] || 0.01;
  const prevBw = bandWidths[bandWidths.length - 2] || curBw;
  const prevBw2 = bandWidths[bandWidths.length - 3] || prevBw;
  // Squeeze is active if bandwidth was compressed within recent 1-3 bars
  const isBbSqueeze = prevBw <= minRecentBw * 1.35 || prevBw2 <= minRecentBw * 1.35 || curBw <= minRecentBw * 1.25;

  const lastClose = closes[n - 1];
  const lastHigh = highs[n - 1];
  const lastLow = lows[n - 1];
  const lastEma20 = ema20Values[ema20Values.length - 1] || lastClose;
  const lastEma50 = ema50Values[ema50Values.length - 1] || lastClose;
  const lastEma200 = ema200Values[ema200Values.length - 1] || lastClose;
  const lastRsi = rsi14Values[rsi14Values.length - 1] || 50;
  const lastAtr = atr14Values[atr14Values.length - 1] || (lastClose * 0.005);
  const lastBb = bbValues[bbValues.length - 1] || { upper: lastClose * 1.01, lower: lastClose * 0.99, middle: lastClose };
  const lastAdx = adxValues[adxValues.length - 1]?.adx || 20;

  // Additional ML Quant features matching the trained model
  const ret1 = (closes[n - 1] - closes[n - 2]) / (closes[n - 2] || 1);
  const ret5 = (closes[n - 1] - closes[Math.max(0, n - 6)]) / (closes[Math.max(0, n - 6)] || 1);
  const atrPct = lastAtr / (lastClose || 1);
  const emaSpread2050 = (lastEma20 - lastEma50) / (lastClose || 1);
  const emaSpread50200 = (lastEma50 - lastEma200) / (lastClose || 1);

  let macdHist = 0;
  try {
    const macdValues = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const lastMacd = macdValues[macdValues.length - 1];
    macdHist = (lastMacd?.histogram || 0) / (lastClose || 1);
  } catch (e) {
    macdHist = 0;
  }

  // Rolling VWAP (24 bars ~ 2 hours session anchor)
  const recentCloses = closes.slice(-24);
  const recentHighs = highs.slice(-24);
  const recentLows = lows.slice(-24);
  const recentVols = volumes.slice(-24);
  let sumPv = 0;
  let sumV = 0;
  for (let i = 0; i < recentCloses.length; i++) {
    const tp = (recentHighs[i] + recentLows[i] + recentCloses[i]) / 3.0;
    const v = recentVols[i] || 1;
    sumPv += tp * v;
    sumV += v;
  }
  const vwap = sumPv / (sumV + 1e-9);
  const vwapDistancePct = (lastClose - vwap) / (vwap + 1e-9);

  // Swing High/Low (24-bar window) & Support/Resistance
  const swingHigh24 = Math.max(...recentHighs);
  const swingLow24 = Math.min(...recentLows);
  const swingRange = swingHigh24 - swingLow24 + 1e-9;
  const distanceToSwingHighLow = (lastClose - swingLow24) / swingRange;

  // Temporal & Funding Window Proximity
  const now = new Date();
  const isWeekendVal = (now.getUTCDay() === 0 || now.getUTCDay() === 6) ? 1.0 : 0.0;
  const utcMinuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const distFunding = Math.min(utcMinuteOfDay % 480, 480 - (utcMinuteOfDay % 480));
  const fundingWindowProximity = 1.0 - (distFunding / 240.0);

  return {
    lastClose,
    lastHigh,
    lastLow,
    ema20: lastEma20,
    ema50: lastEma50,
    ema200: lastEma200,
    rsi: lastRsi,
    atr: lastAtr,
    bb: lastBb,
    adx: lastAdx,
    volumeRatio,
    isBbSqueeze,
    bbWidth: curBw,
    ret1,
    ret5,
    atrPct,
    emaSpread2050,
    emaSpread50200,
    macdHist,
    vwapDistancePct,
    distanceToSwingHighLow,
    isWeekendVal,
    fundingWindowProximity,
    supportPrice: swingLow24,
    resistancePrice: swingHigh24,
    closes,
    highs,
    lows
  };
}

export const CRYPTO_CONFIGS = {
  BTCUSD: { minLot: 0.01, digits: 2, minSlBuffer: 150.0, label: 'Bitcoin' },
  ETHUSD: { minLot: 0.02, digits: 2, minSlBuffer: 10.0, label: 'Ethereum' },
  SOLUSD: { minLot: 0.05, digits: 2, minSlBuffer: 2.50, label: 'Solana' }
};

/**
 * Execute Crypto M5 Scan Cycle (24/7 Engine for High-Volume Coins)
 */
export async function executeCryptoScanCycle() {
  console.log(`[*] [${new Date().toISOString()}] 🪙 เริ่มรอบการสแกนตลาดคริปโท (${CRYPTO_UNIVERSE.join(', ')} 24/7)...`);
  const pool = await getPool();
  const isWeekend = isWeekendCrypto();

  // 1. Synchronize existing Crypto positions with MT5
  try {
    await syncMt5PositionsWithDatabase();
  } catch (err) {
    console.warn('⚠️ Crypto sync with MT5 error:', err.message);
  }

  let openPositions = [];
  try {
    const [rows] = await pool.query(
      `SELECT tr.mt5_ticket, tr.symbol, tr.entry_price, tr.entry_time AS entry_date, tr.sl_price, tr.tp_price, tr.action,
              COALESCE(ap.highest_price, tr.entry_price) AS highest_price,
              COALESCE(ap.status_note, CONCAT('CRYPTO_', tr.action, '_OPEN')) AS status_note
       FROM trade_results tr
       LEFT JOIN active_positions ap ON ap.mt5_ticket = tr.mt5_ticket AND ap.symbol = tr.symbol
       WHERE tr.market_type = 'crypto' AND tr.exit_reason = 'OPEN' AND tr.mt5_ticket IS NOT NULL`
    );
    openPositions = rows;
  } catch (err) {
    console.warn('⚠️ Query active crypto positions error:', err.message);
  }

  let liveCryptoPositions = [];
  let livePositionSnapshotAvailable = !CRYPTO_LIVE_ENABLED || process.env.MT5_ENABLED !== 'true';
  if (CRYPTO_LIVE_ENABLED && process.env.MT5_ENABLED === 'true') {
    try {
      const livePositions = await getOpenPositions();
      if (Array.isArray(livePositions)) {
        livePositionSnapshotAvailable = true;
        liveCryptoPositions = livePositions.filter(p => CRYPTO_UNIVERSE.includes(String(p.symbol)));
      }
    } catch (err) {
      console.warn('⚠️ Cannot read live Crypto positions for entry guard:', err.message);
    }
  }
  const cycleCryptoEntries = {};
  const scanResults = [];

  // A. Fetch Binance Spot M5 bars in parallel for all crypto coins (High-speed concurrent I/O)
  let binanceData = {};
  try {
    binanceData = await fetchBinanceCryptoDataParallel(CRYPTO_UNIVERSE, '5m', 100);
    console.log(`⚡ [Binance Parallel Stream] โหลดแท่งเทียนสดสำเร็จ ${Object.keys(binanceData).length}/${CRYPTO_UNIVERSE.length} เหรียญ`);
  } catch (err) {
    console.warn('⚠️ Binance parallel fetch warning, falling back to MT5:', err.message);
  }

  // B. Parallel fetch MT5 H1/M5 rates concurrently for symbols
  const mt5RatesMap = {};
  if (process.env.MT5_ENABLED === 'true') {
    try {
      const mt5Tasks = CRYPTO_UNIVERSE.map(async (symbol) => {
        try {
          const [m5Res, h1Res] = await Promise.all([
            getRates(symbol, 'M5', 100),
            getRates(symbol, 'H1', 40)
          ]);
          return {
            symbol,
            m5Bars: m5Res?.bars || null,
            h1Bars: h1Res?.bars || null
          };
        } catch {
          return { symbol, m5Bars: null, h1Bars: null };
        }
      });
      const mt5Results = await Promise.all(mt5Tasks);
      for (const res of mt5Results) {
        mt5RatesMap[res.symbol] = res;
      }
    } catch (err) {
      console.warn('⚠️ Parallel MT5 rates fetch failed:', err.message);
    }
  }

  // Pre-calculate BTC lead momentum for cross-correlation across Altcoins
  let btcRet5 = 0;
  const btcBars = binanceData['BTCUSD'] || mt5RatesMap['BTCUSD']?.m5Bars || null;
  if (btcBars && btcBars.length >= 6) {
    const btcCloses = btcBars.map(b => Number(b.close));
    const btcCur = btcCloses[btcCloses.length - 1];
    const btcPrev5 = btcCloses[btcCloses.length - 6] || btcCur;
    btcRet5 = (btcCur - btcPrev5) / (btcPrev5 || 1);
  }

  for (const symbol of CRYPTO_UNIVERSE) {
    const cfg = CRYPTO_CONFIGS[symbol] || { minLot: 0.01, digits: 2, minSlBuffer: 10.0, label: symbol };

    // Select clean Binance Klines (matches model training distribution) or MT5 fallback
    const m5Bars = binanceData[symbol] || mt5RatesMap[symbol]?.m5Bars || null;
    const h1Bars = mt5RatesMap[symbol]?.h1Bars || null;

    if (!m5Bars || m5Bars.length < 35) {
      console.warn(`⚠️ แท่งเทียน ${symbol} M5 ไม่เพียงพอสำหรับการวิเคราะห์`);
      continue;
    }

    const currentPrice = Number(m5Bars[m5Bars.length - 1].close);
    const ind = calculateCryptoIndicators(m5Bars);
    if (!ind) continue;

    // Predict Market Pressure & Indecision for Crypto (BTCUSD, ETHUSD, SOLUSD)
    let marketPressure = null;
    if (CRYPTO_MARKET_PRESSURE_ENABLED) {
      try {
        marketPressure = await predictForexMarketPressure(m5Bars, symbol);
        if (marketPressure) {
          await recordMarketPressureObservation({
            pool,
            symbol,
            barTime: m5Bars[m5Bars.length - 1]?.time || new Date(),
            pressureResult: marketPressure
          });
          console.log(`🧭 [CRYPTO PRESSURE] ${symbol}: ${marketPressure.state} | Buy: ${(marketPressure.probabilities.buy_pressure*100).toFixed(0)}% | Sell: ${(marketPressure.probabilities.sell_pressure*100).toFixed(0)}% | Indecision: ${(marketPressure.probabilities.indecision*100).toFixed(0)}%`);
        }
      } catch (pErr) {
        console.warn(`⚠️ [Crypto] Market Pressure inference skipped for ${symbol}:`, pErr.message);
      }
    }

    const {
      lastClose, lastHigh, lastLow, ema20, ema50, ema200, rsi, atr, bb, adx,
      volumeRatio, isBbSqueeze, bbWidth, ret1, ret5, atrPct, emaSpread2050,
      emaSpread50200, macdHist, vwapDistancePct, distanceToSwingHighLow,
      isWeekendVal, fundingWindowProximity, supportPrice, resistancePrice
    } = ind;

    const btcCorrDivergence = symbol === 'BTCUSD' ? 0.0 : (ret5 - btcRet5);

    // Save recent bars into market_bars table for chart display
    try {
      const recentBars = m5Bars.slice(-60);
      const values = recentBars.map(b => [
        b.time,
        symbol,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume || b.tick_volume || 0,
        Number(rsi.toFixed(2)),
        Number(atr.toFixed(cfg.digits)),
        'crypto'
      ]);
      await pool.query(
        `INSERT INTO market_bars (time, symbol, open, high, low, close, volume, rsi, atr, market_type)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           open=VALUES(open), high=VALUES(high), low=VALUES(low),
           close=VALUES(close), volume=VALUES(volume),
           rsi=VALUES(rsi), atr=VALUES(atr),
           market_type='crypto',
           last_scanned_at=CURRENT_TIMESTAMP`,
        [values]
      );
    } catch (barErr) {
      // Non-fatal bar insert warning
    }

    // B. Manage open positions for this symbol
    const symbolPositions = openPositions.filter(p => p.symbol === symbol);
    for (const pos of symbolPositions) {
      const ticket = Number(pos.mt5_ticket);
      const entryPrice = Number(pos.entry_price);
      let highestPrice = Number(pos.highest_price || entryPrice);
      const isBuy = pos.status_note.includes('BUY');
      const heldMinutes = Math.floor((Date.now() - new Date(pos.entry_date).getTime()) / (1000 * 60));
      const profitDistance = isBuy ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
      const slPrice = Number(pos.sl_price || 0);

      if (isBuy && currentPrice > highestPrice) {
        highestPrice = currentPrice;
        await pool.query('UPDATE active_positions SET highest_price = ? WHERE mt5_ticket = ?', [highestPrice, ticket]);
      } else if (!isBuy && currentPrice < highestPrice) {
        highestPrice = currentPrice;
        await pool.query('UPDATE active_positions SET highest_price = ? WHERE mt5_ticket = ?', [highestPrice, ticket]);
      }

      // 1. Dynamic 2-Tier Break-Even Lock:
      // Tier 1: Fast BE at +0.45x ATR -> Move SL to Positive Break-Even (Spread Buffer Offset)
      if (profitDistance >= 0.45 * atr && !pos.status_note.includes('BE_T1') && !pos.status_note.includes('BE_T2') && !pos.status_note.includes('BE_LOCKED')) {
        const defaultOffset = symbol === 'BTCUSD' ? 12.0 : (symbol === 'ETHUSD' ? 1.00 : 0.20);
        const spreadOffset = Math.max(defaultOffset, 0.08 * atr);
        const beSl = isBuy
          ? Number((entryPrice + spreadOffset).toFixed(cfg.digits))
          : Number((entryPrice - spreadOffset).toFixed(cfg.digits));
        const canMove = isBuy ? (beSl > slPrice) : (slPrice === 0 || beSl < slPrice);
        if (canMove) {
          console.log(`🔒 [Crypto Break-Even T1] ปรับ SL ไม้ #${ticket} (${symbol}) สู่ Positive Break-Even (+Offset ${spreadOffset.toFixed(2)}) ที่ ${beSl}`);
          await modifyStopLoss(ticket, beSl, pos.tp_price);
          await pool.query(
            `UPDATE active_positions SET sl_price = ?, status_note = CONCAT(status_note, '_BE_T1') WHERE mt5_ticket = ?`,
            [beSl, ticket]
          );
          pos.sl_price = beSl;
          pos.status_note += '_BE_T1';
        }
      }

      // Tier 2: Profit Lock at +0.90x ATR -> Lock SL to Entry +/- 0.25x ATR
      if (profitDistance >= 0.90 * atr && !pos.status_note.includes('BE_T2') && !pos.status_note.includes('BE_LOCKED')) {
        const beSl2 = isBuy
          ? Number((entryPrice + 0.25 * atr).toFixed(cfg.digits))
          : Number((entryPrice - 0.25 * atr).toFixed(cfg.digits));
        const canMove = isBuy ? (beSl2 > slPrice) : (slPrice === 0 || beSl2 < slPrice);
        if (canMove) {
          console.log(`🔒 [Crypto Break-Even T2] ล็อกกำไร ไม้ #${ticket} (${symbol}) ที่ +0.25x ATR (${beSl2})`);
          await modifyStopLoss(ticket, beSl2, pos.tp_price);
          await pool.query(
            `UPDATE active_positions SET sl_price = ?, status_note = CONCAT(status_note, '_BE_T2_BE_LOCKED') WHERE mt5_ticket = ?`,
            [beSl2, ticket]
          );
          pos.sl_price = beSl2;
          pos.status_note += '_BE_T2_BE_LOCKED';
        }
      }

      // 1.5 Structural Risk Mitigation SL Tightening (Dynamic Invalidation Behind Major S/R)
      // When trade has not yet reached BE or is consolidating, tighten SL behind verified MAJOR Swing High (SELL) or Swing Low (BUY)
      // to reduce maximum loss while giving price ample room to absorb wick noise and spread.
      if (!pos.status_note.includes('BE_T1') && !pos.status_note.includes('BE_T2') && !pos.status_note.includes('BE_LOCKED')) {
        const minBuf = symbol === 'BTCUSD' ? 45.0 : (symbol === 'ETHUSD' ? 4.50 : 0.60);
        const minImp = symbol === 'BTCUSD' ? 25.0 : (symbol === 'ETHUSD' ? 2.50 : 0.40);
        const minAdvDist = symbol === 'BTCUSD' ? 40.0 : (symbol === 'ETHUSD' ? 4.00 : 0.50);

        const structBarrier = findStructuralInvalidationBarrier(m5Bars, currentPrice, isBuy, slPrice, atr, {
          pivotBars: 3,
          bufferMultiplier: 0.35,
          minBreathingAtr: 0.50,
          minBuffer: minBuf,
          entryPrice,
          minAdverseDistance: minAdvDist
        });

        if (structBarrier && structBarrier.riskReduced >= minImp) {
          const newSl = Number(structBarrier.candidateSl.toFixed(cfg.digits));
          const canMove = isBuy ? (newSl > slPrice) : (slPrice === 0 || newSl < slPrice);
          if (canMove) {
            console.log(`🛡️ [Crypto Structural SL Tightening] ดึง SL ไม้ #${ticket} (${symbol} ${isBuy ? 'BUY' : 'SELL'}) ดักหลังแนว${isBuy ? 'รับ' : 'ต้าน'}หลัก $${structBarrier.barrierPrice.toFixed(cfg.digits)} ที่ $${newSl} (ลดความเสี่ยงลง $${structBarrier.riskReduced.toFixed(2)} | Buffer: $${minBuf})`);
            await modifyStopLoss(ticket, newSl, pos.tp_price);
            await pool.query(
              `UPDATE active_positions SET sl_price = ?, status_note = IF(status_note LIKE '%_STRUCT_SL%', status_note, CONCAT(status_note, '_STRUCT_SL')) WHERE mt5_ticket = ?`,
              [newSl, ticket]
            );
            pos.sl_price = newSl;
          }
        }
      }

      // 2. Trend Rider Chandelier Trailing Stop: If profit expands >= 1.5x ATR, trail SL behind highest price
      if (profitDistance >= 1.5 * atr) {
        const chandelierSl = isBuy
          ? Number((highestPrice - 1.0 * atr).toFixed(cfg.digits))
          : Number((highestPrice + 1.0 * atr).toFixed(cfg.digits));
        const canTrail = isBuy ? (chandelierSl > slPrice) : (slPrice === 0 || chandelierSl < slPrice);
        if (canTrail) {
          console.log(`🚀 [Crypto Trend Trailing] ไม้ #${ticket} (${symbol}) ลาก Trailing Stop สู่ ${chandelierSl} (Highest: ${highestPrice})`);
          await modifyStopLoss(ticket, chandelierSl, pos.tp_price);
          await pool.query(
            `UPDATE active_positions SET sl_price = ?, highest_price = ? WHERE mt5_ticket = ?`,
            [chandelierSl, highestPrice, ticket]
          );
        }
      }

      // 2.7 S/R Rejection Harvest: Lock in profits when price tests structural resistance/support and rejects
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
          console.log(`🎯 [Crypto S/R Rejection Harvest] ไม้ #${ticket} (${symbol} ${isBuy ? 'BUY' : 'SELL'}): ${srHarvestCheck.reason}`);
          const closeRes = await closePosition(ticket);
          if (closeRes && closeRes.success) {
            await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_SR_REJECTION_HARVEST' WHERE mt5_ticket = ?`, [ticket]);
            await recordTradeExit({
              ticket,
              symbol,
              exitPrice: currentPrice,
              exitReason: 'CLOSED_SR_REJECTION_HARVEST',
              realProfit: closeRes.profit ?? null
            });
            continue;
          }
        }
      } catch (srErr) {
        console.warn(`⚠️ [Crypto] Error evaluating S/R harvest exit for ${symbol}:`, srErr.message);
      }

      // 3. AI / Technical Trend Reversal Exit: Confirmed Structural Trend Breakdown (Anti-Shakeout Guard)
      // Prevents premature cuts during temporary liquidity sweeps or shallow dips near entry.
      const bar1 = m5Bars[m5Bars.length - 1];
      const bar2 = m5Bars[m5Bars.length - 2] || bar1;
      const c1 = Number(bar1.close);
      const c2 = Number(bar2.close);

      // Require 2 consecutive completed/forming bar closes beyond EMA50 to filter out single-bar wick sweeps
      const isMultiBarTrendBreak = isBuy
        ? (c1 < ema50 && c2 < ema50 && ema20 < ema50)
        : (c1 > ema50 && c2 > ema50 && ema20 > ema50);

      // Check adverse pressure if available
      const pAdverseTrend = marketPressure
        ? (isBuy ? Number(marketPressure.probabilities?.sell_pressure || 0) : Number(marketPressure.probabilities?.buy_pressure || 0))
        : 0.40;

      // Shakeout Guards:
      // a) Position must be held >= 25 minutes (at least 5 completed M5 bars to allow pullback structure to develop)
      // b) Position must actually be in adverse drawdown (<= -0.80x ATR). Never cut a shallow dip (>-0.5x ATR) right at support!
      // c) Confirmed by multi-bar closes beyond EMA50 AND (adverse pressure >= 38% OR confirmed ADX trend >= 25)
      const isConfirmedTrendBreak = isMultiBarTrendBreak &&
        heldMinutes >= 25 &&
        profitDistance <= -0.80 * atr &&
        (pAdverseTrend >= 0.38 || adx >= 25);

      if (isConfirmedTrendBreak) {
        console.log(`🚨 [Crypto AI Trend Exit] ไม้ #${ticket} (${symbol} ${isBuy ? 'BUY' : 'SELL'}) โครงสร้างเทรนด์ยืนยันการหลุด 2 แท่งซ้อน (Close: $${c1.toFixed(cfg.digits)}, Drawdown: ${profitDistance.toFixed(cfg.digits)} | Adverse: ${(pAdverseTrend*100).toFixed(0)}%) -> สั่งปิดตัดความเสี่ยง`);
        const closeRes = await closePosition(ticket);
        if (closeRes && closeRes.success) {
          await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_AI_TREND_EXIT' WHERE mt5_ticket = ?`, [ticket]);
          await recordTradeExit({
            ticket,
            symbol,
            exitPrice: currentPrice,
            exitReason: 'CLOSED_AI_TREND_EXIT',
            realProfit: closeRes.profit ?? null
          });
          continue;
        }
      }

      // 3.5 Active Market Pressure Intra-Trade Protection for Crypto
      if (CRYPTO_PRESSURE_EXIT_ENABLED && marketPressure) {
        const pAdverse = isBuy 
          ? Number(marketPressure.probabilities?.sell_pressure || 0)
          : Number(marketPressure.probabilities?.buy_pressure || 0);

        // Case A: Profit Lock - If position is in profit >= 1.0x ATR and strong adverse reversal hits (>= 45%)
        if (profitDistance >= 1.0 * atr && pAdverse >= 0.45) {
          console.log(`🛡️ [Crypto Pressure Exit] ไม้ #${ticket} (${symbol}) กำไร +${profitDistance.toFixed(cfg.digits)} แต่เจอแรงสวนกลับ ${(pAdverse*100).toFixed(0)}% -> ล็อกกำไรทันทีก่อนโดนดึงกลับ!`);
          const closeRes = await closePosition(ticket);
          if (closeRes && closeRes.success) {
            await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_PRESSURE_PROFIT_LOCK' WHERE mt5_ticket = ?`, [ticket]);
            await recordTradeExit({
              ticket,
              symbol,
              exitPrice: currentPrice,
              exitReason: 'CLOSED_PRESSURE_PROFIT_LOCK',
              realProfit: closeRes.profit ?? null
            });
            continue;
          }
        }

        // Case B: Severe Adverse Cut - If position is in loss >= 1.0x ATR and severe adverse pressure hits (>= 48%), cut early to prevent large SL!
        if (profitDistance < -1.0 * atr && pAdverse >= 0.48 && heldMinutes >= 5) {
          console.log(`✂️ [Crypto Pressure Early Cut] ไม้ #${ticket} (${symbol}) ติดลบ ${profitDistance.toFixed(cfg.digits)} และเจอแรงสวนกลับรุนแรง ${(pAdverse*100).toFixed(0)}% -> ตัดขาดทุนล่วงหน้าเพื่อรักษาทุน!`);
          const closeRes = await closePosition(ticket);
          if (closeRes && closeRes.success) {
            await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_PRESSURE_EARLY_CUT' WHERE mt5_ticket = ?`, [ticket]);
            await recordTradeExit({
              ticket,
              symbol,
              exitPrice: currentPrice,
              exitReason: 'CLOSED_PRESSURE_EARLY_CUT',
              realProfit: closeRes.profit ?? null
            });
            continue;
          }
        }
      }

      // 4. Time-Decay Hard Exit: If held > CRYPTO_MAX_HOLD_MINUTES (default 180m) with stagnant momentum, close safely
      const cryptoMaxHoldMinutes = Number(process.env.CRYPTO_MAX_HOLD_MINUTES || 180);
      if (heldMinutes >= cryptoMaxHoldMinutes && Math.abs(profitDistance) < 0.5 * atr) {
        console.log(`⏱️ [Crypto Time-Stop] ไม้ #${ticket} (${symbol}) ถือนานเกิน ${cryptoMaxHoldMinutes} นาที ไร้โมเมนตัม ปิดทำความสะอาด`);
        const closeRes = await closePosition(ticket);
        if (closeRes && closeRes.success) {
          await pool.query(`UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP' WHERE mt5_ticket = ?`, [ticket]);
          await recordTradeExit({
            ticket,
            symbol,
            exitPrice: currentPrice,
            exitReason: 'CLOSED_TIME_STOP',
            realProfit: closeRes.profit ?? null
          });
          continue;
        }
      }
    }

    // C. Evaluate New Entry Setups
    let h1Bullish = true;
    if (h1Bars && h1Bars.length >= 20) {
      const h1Closes = h1Bars.map(b => Number(b.close));
      const h1Ema50 = EMA.calculate({ period: Math.min(50, h1Closes.length - 1), values: h1Closes });
      const lastH1Ema50 = h1Ema50[h1Ema50.length - 1] || h1Closes[h1Closes.length - 1];
      h1Bullish = h1Closes[h1Closes.length - 1] > lastH1Ema50;
    }

    let signalAction = null;
    let setupName = '';
    let patternConfirmed = false;

    // Track 1: Bollinger Band Squeeze & Volatility Expansion Breakout
    if (isBbSqueeze && volumeRatio >= (isWeekend ? 1.25 : 1.05)) {
      if (lastClose > bb.upper && h1Bullish) {
        signalAction = 'BUY';
        setupName = 'Bollinger Squeeze Bullish Expansion';
        patternConfirmed = true;
      } else if (lastClose < bb.lower && !h1Bullish) {
        signalAction = 'SELL';
        setupName = 'Bollinger Squeeze Bearish Expansion';
        patternConfirmed = true;
      }
    }

    // Track 2: Trend Rider (EMA 20/50 Momentum & ADX Trend Strength)
    if (!signalAction) {
      const isUptrend = lastClose > ema50 && ema20 > ema50 && h1Bullish && adx >= 18;
      const isDowntrend = lastClose < ema50 && ema20 < ema50 && !h1Bullish && adx >= 18;

      if (isUptrend && rsi >= 48 && rsi <= 72 && lastClose > ema20) {
        signalAction = 'BUY';
        setupName = 'Trend Rider Confluence (EMA20/50 + ADX)';
        patternConfirmed = true;
      } else if (isDowntrend && rsi >= 28 && rsi <= 52 && lastClose < ema20) {
        signalAction = 'SELL';
        setupName = 'Trend Rider Short (EMA20/50 + ADX)';
        patternConfirmed = true;
      }
    }

    // Track 3: Pullback & Support/Resistance Retest (Dip / Rally) with Anti-Falling-Knife Guard
    if (!signalAction) {
      const isUptrend = ema50 > ema200 && h1Bullish;
      const isDowntrend = ema50 < ema200 && !h1Bullish;

      if (isUptrend && lastLow <= ema20 * 1.003 && lastClose >= ema50 * 0.998 && rsi >= 38 && rsi <= 65) {
        // Anti-Falling Knife & Candlestick Confirmation Guard
        const curBar = m5Bars[m5Bars.length - 1];
        const prevBar = m5Bars[m5Bars.length - 2] || curBar;
        const prevBar2 = m5Bars[m5Bars.length - 3] || prevBar;
        const prevBar3 = m5Bars[m5Bars.length - 4] || prevBar2;

        const curOpen = Number(curBar.open);
        const curClose = Number(curBar.close);
        const curHigh = Number(curBar.high);
        const curLow = Number(curBar.low);
        const curRange = curHigh - curLow;
        const curLowerWick = Math.min(curOpen, curClose) - curLow;
        const curLowerWickRatio = curRange > 0 ? (curLowerWick / curRange) : 0;
        const curBody = Math.abs(curClose - curOpen);
        const curBodyRatio = curRange > 0 ? (curBody / curRange) : 0;

        const prevOpen = Number(prevBar.open);
        const prevClose = Number(prevBar.close);
        const prevHigh = Number(prevBar.high);
        const prevLow = Number(prevBar.low);
        const prevRange = prevHigh - prevLow;
        const prevLowerWick = Math.min(prevOpen, prevClose) - prevLow;
        const prevLowerWickRatio = prevRange > 0 ? (prevLowerWick / prevRange) : 0;

        // Check if market is in an aggressive multi-bar waterfall dump
        const isWaterfallDump = (
          Number(prevBar.close) < Number(prevBar.open) &&
          Number(prevBar2.close) < Number(prevBar2.open) &&
          Number(prevBar3.close) < Number(prevBar3.open) &&
          curClose < curOpen
        );

        // Check if current or previous completed bar shows genuine buyer absorption / rejection
        const hasReboundWick = curLowerWickRatio >= 0.25 || prevLowerWickRatio >= 0.30;
        const isBullishCandle = curClose > curOpen || (prevClose > prevOpen && curClose >= prevLow);
        const isBearishMarubozu = curClose < curOpen && curBodyRatio >= 0.60 && curLowerWickRatio < 0.15;

        // Valid Dip Buy requires:
        // 1. Not in a 4-bar consecutive waterfall dump
        // 2. Not a dumping bearish marubozu
        // 3. Demonstrates buyer responsiveness (lower rejection wick >= 25% OR bullish reversal candle)
        if (!isWaterfallDump && !isBearishMarubozu && (hasReboundWick || isBullishCandle)) {
          signalAction = 'BUY';
          setupName = 'Bullish EMA 20 Pullback Dip (Confirmed Rebound)';
          patternConfirmed = true;
        } else {
          console.log(`🛡️ [Crypto Anti-Falling-Knife] ${symbol} BUY Dip ข้ามคำสั่ง: แท่งเทียนยังไม่ยืนยันการเด้ง (Waterfall: ${isWaterfallDump}, Marubozu: ${isBearishMarubozu}, Wick: ${(curLowerWickRatio * 100).toFixed(0)}%, Bullish: ${isBullishCandle})`);
        }
      } else if (isDowntrend && lastHigh >= ema20 * 0.997 && lastClose <= ema50 * 1.002 && rsi >= 35 && rsi <= 62) {
        // Anti-Rocket Short & Candlestick Confirmation Guard
        const curBar = m5Bars[m5Bars.length - 1];
        const prevBar = m5Bars[m5Bars.length - 2] || curBar;
        const prevBar2 = m5Bars[m5Bars.length - 3] || prevBar;
        const prevBar3 = m5Bars[m5Bars.length - 4] || prevBar2;

        const curOpen = Number(curBar.open);
        const curClose = Number(curBar.close);
        const curHigh = Number(curBar.high);
        const curLow = Number(curBar.low);
        const curRange = curHigh - curLow;
        const curUpperWick = curHigh - Math.max(curOpen, curClose);
        const curUpperWickRatio = curRange > 0 ? (curUpperWick / curRange) : 0;
        const curBody = Math.abs(curClose - curOpen);
        const curBodyRatio = curRange > 0 ? (curBody / curRange) : 0;

        const prevOpen = Number(prevBar.open);
        const prevClose = Number(prevBar.close);
        const prevHigh = Number(prevBar.high);
        const prevLow = Number(prevBar.low);
        const prevRange = prevHigh - prevLow;
        const prevUpperWick = prevHigh - Math.max(prevOpen, prevClose);
        const prevUpperWickRatio = prevRange > 0 ? (prevUpperWick / prevRange) : 0;

        // Check if market is in an aggressive vertical rocket rally
        const isRocketRally = (
          Number(prevBar.close) > Number(prevBar.open) &&
          Number(prevBar2.close) > Number(prevBar2.open) &&
          Number(prevBar3.close) > Number(prevBar3.open) &&
          curClose > curOpen
        );

        // Check if current or previous completed bar shows genuine seller absorption / rejection
        const hasRejectionWick = curUpperWickRatio >= 0.25 || prevUpperWickRatio >= 0.30;
        const isBearishCandle = curClose < curOpen || (prevClose < prevOpen && curClose <= prevHigh);
        const isBullishMarubozu = curClose > curOpen && curBodyRatio >= 0.60 && curUpperWickRatio < 0.15;

        // Valid Rally Short requires:
        // 1. Not in a 4-bar consecutive rocket rally
        // 2. Not a pumping bullish marubozu
        // 3. Demonstrates seller responsiveness (upper rejection wick >= 25% OR bearish reversal candle)
        if (!isRocketRally && !isBullishMarubozu && (hasRejectionWick || isBearishCandle)) {
          signalAction = 'SELL';
          setupName = 'Bearish EMA 20 Pullback Rally (Confirmed Rejection)';
          patternConfirmed = true;
        } else {
          console.log(`🛡️ [Crypto Anti-Falling-Knife] ${symbol} SELL Rally ข้ามคำสั่ง: แท่งเทียนยังไม่ยืนยันการกดกลับ (Rocket: ${isRocketRally}, Marubozu: ${isBullishMarubozu}, Wick: ${(curUpperWickRatio * 100).toFixed(0)}%, Bearish: ${isBearishCandle})`);
        }
      }
    }

    // Track 4: Trend Momentum Confluence (EMA20 vs EMA50 & MACD Direction)
    if (!signalAction) {
      if (lastClose > ema50 && ema20 > ema50 && macdHist > 0 && rsi >= 42 && rsi <= 75) {
        signalAction = 'BUY';
        setupName = 'EMA Trend Momentum (Bullish Confluence)';
        patternConfirmed = true;
      } else if (lastClose < ema50 && ema20 < ema50 && macdHist < 0 && rsi >= 25 && rsi <= 58) {
        signalAction = 'SELL';
        setupName = 'EMA Trend Momentum (Bearish Confluence)';
        patternConfirmed = true;
      }
    }

    if (!signalAction) {
      console.log(`[+] [Crypto Engine] 🪙 ${symbol}: $${lastClose.toFixed(cfg.digits)} | RSI: ${rsi.toFixed(1)} | ADX: ${adx.toFixed(1)} | VolRatio: ${volumeRatio} | Squeeze: ${isBbSqueeze} (ไม่มีจังหวะเข้าเทรด)`);
      scanResults.push({ symbol, status: 'NO_SETUP', price: lastClose });
      continue;
    }

    // Evaluate AI Confidence via Dedicated Crypto ML Model (16-Factor Quant Architecture)
    const cryptoFeatures = {
      symbol,
      direction: signalAction,
      ret_1: ret1,
      ret_5: ret5,
      rsi_14: rsi,
      atr_pct: atrPct,
      adx_14: adx,
      ema_spread_20_50: emaSpread2050,
      ema_spread_50_200: emaSpread50200,
      macd_hist: macdHist,
      volume_ratio: volumeRatio,
      bb_width: bbWidth,
      btc_ret_5: btcRet5,
      btc_corr_divergence: btcCorrDivergence,
      is_weekend: isWeekendVal,
      vwap_distance_pct: vwapDistancePct,
      distance_to_swing_high_low: distanceToSwingHighLow,
      funding_window_proximity: fundingWindowProximity,
      // Heuristic fallback metadata
      bb_squeeze: isBbSqueeze,
      pattern_confirmed: patternConfirmed,
      price_above_ema50: lastClose > ema50
    };

    // 1. BTC Alignment Safety Guard: Never buy Altcoin when BTC is in severe dump (< -1.5%) or sell when BTC is pumping (> +1.5%)
    if (symbol !== 'BTCUSD') {
      if (signalAction === 'BUY' && btcRet5 < -0.015) {
        console.log(`🛡️ [Crypto BTC Guard] ${symbol} BUY ข้ามคำสั่ง: BTC กำลังดิ่งแรง (${(btcRet5 * 100).toFixed(2)}%)`);
        scanResults.push({ symbol, status: 'BTC_DUMP_SKIP', btcRet5 });
        continue;
      }
      if (signalAction === 'SELL' && btcRet5 > 0.015) {
        console.log(`🛡️ [Crypto BTC Guard] ${symbol} SELL ข้ามคำสั่ง: BTC กำลังพุ่งแรง (+${(btcRet5 * 100).toFixed(2)}%)`);
        scanResults.push({ symbol, status: 'BTC_PUMP_SKIP', btcRet5 });
        continue;
      }
    }

    const aiRes = await predictCryptoConfidence(cryptoFeatures);
    if (aiRes?.modelAvailable === false) {
      console.warn(`[Crypto Model Gate] ${symbol}: Python model unavailable; skipping this live candidate`);
      scanResults.push({ symbol, status: 'MODEL_UNAVAILABLE', error: aiRes.error || null });
      continue;
    }
    const rawBaseConfidence = aiRes?.confidence || 0.60;
    const rawBaseScore = signalAction === 'BUY'
      ? Number(aiRes?.raw_buy ?? aiRes?.prob_buy ?? rawBaseConfidence)
      : Number(aiRes?.raw_sell ?? aiRes?.prob_sell ?? rawBaseConfidence);

    // =========================================================================
    // Dynamic Modulation Pipeline (Aligns with Forex Pattern & Pressure Engine)
    // Step 1: Technical & Pattern Signal Filter (Base Modifier)
    // Step 2: Market Pressure Confirmation (+/- Modifier)
    // Step 3: Modulate Confidence & Raw Directional Conviction Score
    // =========================================================================
    let patternBonus = 0;
    const filterReasons = [];

    // Pattern 1: Compression Squeeze Breakout Bonus (+5%)
    if (isBbSqueeze) {
      patternBonus += 0.05;
      filterReasons.push('Compression Squeeze Breakout (+5% Conf)');
    }

    // Pattern 2: Overextension Guard (-5% penalty if price is stretched at swing extremes)
    const isOverextended = (signalAction === 'BUY' && distanceToSwingHighLow >= 0.90)
      || (signalAction === 'SELL' && distanceToSwingHighLow <= 0.10);
    if (isOverextended) {
      patternBonus -= 0.05;
      filterReasons.push(`Overextended at swing extreme (distance ${(distanceToSwingHighLow * 100).toFixed(0)}%) (-5% Conf)`);
    }

    // Pattern 3: Wick Rejection Filter (-15% penalty instead of blunt hard-veto)
    if (CRYPTO_REJECTION_FILTER_ENABLED) {
      const rejectionCheck = checkRejectionCandle(m5Bars, signalAction, atr);
      if (rejectionCheck.hasRejection) {
        patternBonus -= 0.15;
        filterReasons.push(`Fake Signal Trap / Rejection Wick: ${rejectionCheck.reason} (-15% Conf)`);
        console.log(`⚠️ [Crypto Rejection Filter] ${symbol} ${signalAction}: ${rejectionCheck.reason} (-15% Conf)`);
      }
    }

    // Pattern 4: Reversal Trap Guard (Divergence, SFP, Reversal Candlesticks)
    try {
      const rsiCalc = RSI.calculate({ period: 14, values: m5Bars.map(b => Number(b.close)) });
      const reversalCheck = checkComprehensiveReversal(m5Bars, { rsiSeries: rsiCalc }, signalAction);
      if (reversalCheck.hasOpposingReversal) {
        patternBonus -= reversalCheck.confidencePenalty;
        filterReasons.push(`Opposing Reversal Trap: ${reversalCheck.reason} (-${(reversalCheck.confidencePenalty * 100).toFixed(0)}% Conf)`);
        console.log(`🚨 [Crypto Reversal Trap] ${symbol} ${signalAction}: ${reversalCheck.reason} (-${(reversalCheck.confidencePenalty * 100).toFixed(0)}% Conf)`);
      }
    } catch {}

    // Step 2: Market Pressure Confirmation (+/- Modifier)
    let pressureDelta = 0;
    let pressureReason = '';
    const pBuy = Number(marketPressure?.probabilities?.buy_pressure || 0);
    const pSell = Number(marketPressure?.probabilities?.sell_pressure || 0);
    const pChop = Number(marketPressure?.probabilities?.indecision || 0);

    const counterThreshold = Number(process.env.CRYPTO_PRESSURE_COUNTER_THRESHOLD || 0.42);
    const chopThreshold = Number(process.env.CRYPTO_PRESSURE_CHOP_THRESHOLD || 0.48);

    const isCounterPressure = (signalAction === 'BUY' && (pSell >= counterThreshold || marketPressure?.state === 'SELL_PRESSURE'))
      || (signalAction === 'SELL' && (pBuy >= counterThreshold || marketPressure?.state === 'BUY_PRESSURE'));
    const isIndecisionChop = marketPressure?.state === 'INDECISION_CHOP' || pChop >= chopThreshold;

    if (CRYPTO_MARKET_PRESSURE_ENABLED && marketPressure) {
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

    console.log(`🎯 [Crypto Confidence Modulation] ${symbol} ${signalAction} | Setup: ${setupName} | Base: ${(rawBaseConfidence * 100).toFixed(1)}% (${netDelta >= 0 ? '+' : ''}${(netDelta * 100).toFixed(1)}%) -> Modulated: ${(confidence * 100).toFixed(1)}% | Raw Score: ${rawBaseScore.toFixed(4)} -> ${rawScore.toFixed(4)} | Price: $${lastClose.toFixed(cfg.digits)}`);
    if (pressureReason) {
      console.log(`   └─ ${pressureReason}`);
    }

    if (confidence < CRYPTO_CONFIDENCE_THRESHOLD) {
      console.log(`🛡️ [Crypto Gating] ${symbol} ความมั่นใจ ${(confidence * 100).toFixed(1)}% < ${CRYPTO_CONFIDENCE_THRESHOLD * 100}% (หลังคำนวณ Market Pressure +/-) -> ข้ามคำสั่ง`);
      scanResults.push({ symbol, status: 'LOW_CONFIDENCE', confidence, netDelta });
      continue;
    }

    if (rawScore < CRYPTO_RAW_SCORE_THRESHOLD) {
      console.log(`🛡️ [Crypto Raw Conviction Guard] ${symbol} ${signalAction}: ความมั่นใจแท้จริง ${(rawScore * 100).toFixed(1)}% < ${(CRYPTO_RAW_SCORE_THRESHOLD * 100).toFixed(1)}% (หลังคำนวณ Market Pressure +/-) -> ข้ามคำสั่ง`);
      scanResults.push({ symbol, status: 'LOW_RAW_CONVICTION', rawScore, netDelta });
      continue;
    }

    // Safety Shield: Extreme Counter-Pressure veto (> 45% opposing push)
    if (isCounterPressure && (signalAction === 'BUY' ? pSell >= 0.45 : pBuy >= 0.45)) {
      console.log(`🛡️ [Crypto Counter-Pressure Shield] ${symbol} ${signalAction}: ตรวจพบแรงฝั่งตรงข้ามสวนมารุนแรง (${signalAction === 'BUY' ? `Sell ${(pSell*100).toFixed(0)}%` : `Buy ${(pBuy*100).toFixed(0)}%`} >= 45%) -> สกัดกั้นคำสั่งเพื่อความปลอดภัย`);
      scanResults.push({ symbol, status: 'COUNTER_PRESSURE_BLOCKED', pBuy, pSell });
      continue;
    }

    // Dynamic Exit Geometry Check: S/R distance & Risk-to-Reward evaluation
    const slMult = Number(process.env.CRYPTO_SL_ATR_MULT || 1.8);
    const tpMult = Number(process.env.CRYPTO_TP_ATR_MULT || 3.0);
    const slBuffer = Math.max(cfg.minSlBuffer, Number((slMult * atr).toFixed(cfg.digits)));
    const defaultTpBuffer = Number((tpMult * atr).toFixed(cfg.digits));

    const minCryptoRr = Number(process.env.CRYPTO_MIN_RISK_REWARD || 1.20);

    if (signalAction === 'BUY') {
      const distToRes = resistancePrice - lastClose;
      if (distToRes > 0 && distToRes < defaultTpBuffer * 0.75) {
        const potentialRr = distToRes / slBuffer;
        if (potentialRr < minCryptoRr) {
          console.log(`🛡️ [Crypto Exit Geometry] ${symbol} BUY: แนวต้านใกล้เกินไป (${distToRes.toFixed(cfg.digits)}) | R:R ต่ำเกณฑ์ (${potentialRr.toFixed(2)} < 1:${minCryptoRr.toFixed(2)}) -> ข้าม`);
          scanResults.push({ symbol, status: 'LOW_RR_SKIP', rr: potentialRr });
          continue;
        }
      }
    } else if (signalAction === 'SELL') {
      const distToSup = lastClose - supportPrice;
      if (distToSup > 0 && distToSup < defaultTpBuffer * 0.75) {
        const potentialRr = distToSup / slBuffer;
        if (potentialRr < minCryptoRr) {
          console.log(`🛡️ [Crypto Exit Geometry] ${symbol} SELL: แนวรับใกล้เกินไป (${distToSup.toFixed(cfg.digits)}) | R:R ต่ำเกณฑ์ (${potentialRr.toFixed(2)} < 1:${minCryptoRr.toFixed(2)}) -> ข้าม`);
          scanResults.push({ symbol, status: 'LOW_RR_SKIP', rr: potentialRr });
          continue;
        }
      }
    }

    // Fail closed in live mode: never place a new crypto order when the broker
    // snapshot needed for duplicate protection is unavailable.
    if (CRYPTO_LIVE_ENABLED && process.env.MT5_ENABLED === 'true' && !livePositionSnapshotAvailable) {
      console.warn(`⚠️ [Crypto Guard] ${symbol}: MT5 position snapshot unavailable -> skip live entry`);
      scanResults.push({ symbol, status: 'POSITION_GUARD_UNAVAILABLE' });
      continue;
    }

    // Check how many positions are currently open for this crypto symbol
    const livePositionsForSymbol = liveCryptoPositions.filter(p => String(p.symbol) === symbol);
    const inCycleCount = cycleCryptoEntries[symbol] || 0;
    const currentActiveCount = Math.max(livePositionsForSymbol.length, symbolPositions.length) + inCycleCount;

    if (currentActiveCount >= CRYPTO_MAX_POSITIONS_PER_SYMBOL) {
      console.log(`🛡️ [Crypto Guard] มีออเดอร์ ${symbol} ครบตามลิมิตแล้ว (${currentActiveCount}/${CRYPTO_MAX_POSITIONS_PER_SYMBOL} ไม้) -> ข้ามคำสั่งใหม่`);
      scanResults.push({ symbol, status: 'MAX_POSITIONS_REACHED', openCount: currentActiveCount });
      continue;
    }

    // If holding 1+ positions, guard against opening multiple orders on the exact same M5 candle bar
    if (currentActiveCount > 0) {
      let isSameBar = false;
      const currentBar = Math.floor(Date.now() / (5 * 60 * 1000));

      if (livePositionsForSymbol.length > 0) {
        const latestTime = Math.max(...livePositionsForSymbol.map(p => new Date(p.time || 0).getTime()));
        if (Number.isFinite(latestTime) && Math.floor(latestTime / (5 * 60 * 1000)) === currentBar) {
          isSameBar = true;
        }
      }

      if (!isSameBar) {
        try {
          const [sigRows] = await pool.query(
            `SELECT time FROM signals WHERE symbol = ? AND market_type = 'crypto' ORDER BY id DESC LIMIT 1`,
            [symbol]
          );
          if (sigRows.length > 0) {
            const sigTime = new Date(sigRows[0].time).getTime();
            if (Number.isFinite(sigTime) && Math.floor(sigTime / (5 * 60 * 1000)) === currentBar) {
              isSameBar = true;
            }
          }
        } catch (e) {}
      }

      if (isSameBar) {
        console.log(`⏳ [Crypto Bar Guard] ${symbol} มีคำสั่งในแท่ง M5 นี้แล้ว (${currentActiveCount}/${CRYPTO_MAX_POSITIONS_PER_SYMBOL} ไม้) -> ข้ามคำสั่งซ้ำในแท่งเดียวกัน`);
        scanResults.push({ symbol, status: 'SAME_BAR_SKIP', openCount: currentActiveCount });
        continue;
      }

      console.log(`📈 [Crypto Scale-In / Re-Entry] ${symbol} ${signalAction} | ไม้ที่ ${currentActiveCount + 1}/${CRYPTO_MAX_POSITIONS_PER_SYMBOL} | Setup: ${setupName} | Confidence: ${(confidence * 100).toFixed(1)}%`);
    }

    // Calculate SL/TP with ATR Buffers & Smart Structural TP Capping
    let tpBuffer = defaultTpBuffer;
    if (signalAction === 'BUY' && resistancePrice > lastClose) {
      const safeDistToRes = Math.max(0, (resistancePrice - lastClose) - (0.20 * atr));
      if (safeDistToRes > 0 && safeDistToRes < tpBuffer) {
        const potentialRr = safeDistToRes / slBuffer;
        if (potentialRr >= minCryptoRr) {
          tpBuffer = Number(safeDistToRes.toFixed(cfg.digits));
          console.log(`🎯 [Crypto Smart TP Cap] ${symbol} BUY: ดักล็อกเป้าหมายหน้าแนวต้าน ($${resistancePrice.toFixed(cfg.digits)}) -> ปรับ TP Buffer เหลือ $${tpBuffer.toFixed(cfg.digits)} (R:R 1:${potentialRr.toFixed(2)})`);
        }
      }
    } else if (signalAction === 'SELL' && supportPrice < lastClose) {
      const safeDistToSup = Math.max(0, (lastClose - supportPrice) - (0.20 * atr));
      if (safeDistToSup > 0 && safeDistToSup < tpBuffer) {
        const potentialRr = safeDistToSup / slBuffer;
        if (potentialRr >= minCryptoRr) {
          tpBuffer = Number(safeDistToSup.toFixed(cfg.digits));
          console.log(`🎯 [Crypto Smart TP Cap] ${symbol} SELL: ดักล็อกเป้าหมายหน้าแนวรับ ($${supportPrice.toFixed(cfg.digits)}) -> ปรับ TP Buffer เหลือ $${tpBuffer.toFixed(cfg.digits)} (R:R 1:${potentialRr.toFixed(2)})`);
        }
      }
    }

    let slPrice = signalAction === 'BUY'
      ? Number((lastClose - slBuffer).toFixed(cfg.digits))
      : Number((lastClose + slBuffer).toFixed(cfg.digits));
    let tpPrice = signalAction === 'BUY'
      ? Number((lastClose + tpBuffer).toFixed(cfg.digits))
      : Number((lastClose - tpBuffer).toFixed(cfg.digits));

    const lotSize = Math.max(cfg.minLot, Number(process.env.CRYPTO_LOT_SIZE || cfg.minLot));

    // Place MT5 Order
    let mt5Result = null;
    if (CRYPTO_LIVE_ENABLED && process.env.MT5_ENABLED === 'true') {
      try {
        mt5Result = await placeOrder({
          symbol,
          action: signalAction,
          lot: lotSize,
          volume: lotSize,
          sl: slPrice,
          tp: tpPrice,
          comment: `AI ${symbol.replace('USD', '')} ${signalAction}`
        });
        if (mt5Result && mt5Result.success) {
          console.log(`🚀 [MT5 Order Executed] ${symbol} ${signalAction} | Ticket: ${mt5Result.ticket} | Price: ${mt5Result.price}`);
        } else {
          console.warn(`⚠️ [MT5 Order Rejected] ${symbol} ${signalAction}: ${mt5Result?.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(`❌ ไม่สามารถส่งคำสั่ง ${symbol} ไปยัง MT5:`, err.message);
      }
    }

    const finalTicket = (mt5Result && mt5Result.success) ? mt5Result.ticket : null;
    const executionPrice = Number(mt5Result?.price || lastClose);

    // Market orders can fill away from the scan price. Re-anchor both exits
    // to the actual fill so a BUY can never keep TP below entry (or SELL TP
    // above entry) after slippage.
    if (finalTicket && Number.isFinite(executionPrice) && executionPrice > 0) {
      const plannedTpDistance = Math.abs(tpPrice - lastClose);
      const plannedSlDistance = Math.abs(lastClose - slPrice);
      const fillMoved = Math.abs(executionPrice - lastClose) > Number.EPSILON;
      if (fillMoved && plannedTpDistance > 0 && plannedSlDistance > 0) {
        const anchoredTp = signalAction === 'BUY'
          ? Number((executionPrice + plannedTpDistance).toFixed(cfg.digits))
          : Number((executionPrice - plannedTpDistance).toFixed(cfg.digits));
        const anchoredSl = signalAction === 'BUY'
          ? Number((executionPrice - plannedSlDistance).toFixed(cfg.digits))
          : Number((executionPrice + plannedSlDistance).toFixed(cfg.digits));
        if (validateCryptoExitGeometry(signalAction, executionPrice, anchoredSl, anchoredTp)) {
          try {
            const modifyRes = await modifyStopLoss(finalTicket, anchoredSl, anchoredTp);
            if (modifyRes && modifyRes.success) {
              slPrice = anchoredSl;
              tpPrice = anchoredTp;
              console.log(`[MT5 CRYPTO EXIT RE-ANCHOR] ${symbol} ${signalAction} fill ${executionPrice} -> SL ${slPrice} / TP ${tpPrice}`);
            } else {
              console.warn(`⚠️ [MT5 CRYPTO EXIT RE-ANCHOR FAILED] ${symbol} #${finalTicket}: ${modifyRes?.error || 'unknown error'}`);
            }
          } catch (modifyErr) {
            console.warn(`⚠️ [MT5 CRYPTO EXIT RE-ANCHOR ERROR] ${symbol} #${finalTicket}: ${modifyErr.message}`);
          }
        }
      }
    }

    if (finalTicket && !validateCryptoExitGeometry(signalAction, executionPrice, slPrice, tpPrice)) {
      console.error(`❌ [CRYPTO EXIT GEOMETRY GUARD] ${symbol} ${signalAction}: entry=${executionPrice}, sl=${slPrice}, tp=${tpPrice}`);
      try {
        await closePosition(finalTicket);
      } catch (closeErr) {
        console.error(`❌ [CRYPTO SAFETY CLOSE FAILED] ${symbol} #${finalTicket}: ${closeErr.message}`);
      }
      scanResults.push({ symbol, status: 'EXIT_GEOMETRY_REJECTED' });
      continue;
    }

    if (CRYPTO_LIVE_ENABLED && process.env.MT5_ENABLED === 'true' && !finalTicket) {
      scanResults.push({ symbol, status: 'ORDER_REJECTED', reason: mt5Result?.error || 'MT5 order placement failed' });
      continue;
    }

    if (finalTicket) {
      cycleCryptoEntries[symbol] = (cycleCryptoEntries[symbol] || 0) + 1;
    }

    // Persist the signal independently from the legacy one-row-per-symbol
    // active_positions table. Collector mode can intentionally hold multiple
    // MT5 tickets for one symbol, while trade_results must contain one row per
    // ticket for accurate P/L and model evaluation.
    try {
      await pool.query(
        `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket, source_tag)
         VALUES (NOW(), ?, ?, ?, ?, ?, ?, 'crypto', ?, 'crypto_engine')`,
        [symbol, executionPrice, confidence, slPrice, tpPrice, signalAction, finalTicket]
      );
    } catch (dbErr) {
      console.error(`❌ บันทึก signal ${symbol} ลงฐานข้อมูลล้มเหลว:`, dbErr.message);
    }

    // Keep the legacy aggregate row synchronized with ON DUPLICATE KEY UPDATE
    try {
      await pool.query(
        `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note, market_type, mt5_ticket)
         VALUES (?, NOW(), ?, ?, ?, ?, ?, 'crypto', ?)
         ON DUPLICATE KEY UPDATE
           entry_date = VALUES(entry_date),
           entry_price = VALUES(entry_price),
           highest_price = VALUES(highest_price),
           sl_price = VALUES(sl_price),
           tp_price = VALUES(tp_price),
           status_note = VALUES(status_note),
           mt5_ticket = VALUES(mt5_ticket)`,
        [symbol, executionPrice, executionPrice, slPrice, tpPrice, `CRYPTO_${signalAction}_OPEN`, finalTicket]
      );
    } catch (dbErr) {
      console.warn(`⚠️ active_positions ${symbol} บันทึกล้มเหลว:`, dbErr.message);
    }

    if (finalTicket) {
      const tradeResultId = await recordTradeEntry({
        ticket: finalTicket,
        symbol,
        marketType: 'crypto',
        action: signalAction,
        lotSize,
        entryPrice: executionPrice,
        sl: slPrice,
        tp: tpPrice,
        confidence,
        indicators: {
          rsi: cryptoFeatures.rsi_14,
          adx: cryptoFeatures.adx_14,
          macdHist: cryptoFeatures.macd_hist,
          atr: cryptoFeatures.atr_pct
        },
        modelSource: aiRes?.model || CRYPTO_MODEL_SOURCE_FALLBACK,
        modelVersion: aiRes?.version || aiRes?.model_version || 'unknown',
        decisionMode: 'LIVE',
        predictionMeta: {
          feature_version: 'crypto16-v2',
          features: cryptoFeatures,
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
        sourceTag: 'crypto_engine'
      });
      if (!tradeResultId) {
        console.error(`❌ [Trade Tracker] ไม่สามารถบันทึก ticket #${finalTicket} ของ ${symbol} ได้`);
      }
    }

    scanResults.push({
      symbol,
      status: 'ORDER_PLACED',
      action: signalAction,
      price: executionPrice,
      ticket: finalTicket,
      confidence
    });
  }

  console.log(`[+] รอบการสแกนตลาดคริปโทเสร็จสิ้น (${CRYPTO_UNIVERSE.length} เหรียญ: ${CRYPTO_UNIVERSE.join(', ')})`);

  return {
    success: true,
    count: CRYPTO_UNIVERSE.length,
    results: scanResults
  };
}
