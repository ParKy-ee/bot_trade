import { getPool } from '../config/database.js';
import { CRYPTO_UNIVERSE, fetchBinanceCryptoDataParallel } from './marketData.js';
import { placeOrder, modifyStopLoss, closePosition, getRates, getOpenPositions } from './mt5Broker.js';
import { recordTradeEntry, recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';
import { predictCryptoConfidence } from './modelPredictor.js';
import { checkRejectionCandle } from './forexPriceAction.js';
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

      if (isBuy && currentPrice > highestPrice) {
        highestPrice = currentPrice;
        await pool.query('UPDATE active_positions SET highest_price = ? WHERE mt5_ticket = ?', [highestPrice, ticket]);
      } else if (!isBuy && currentPrice < highestPrice) {
        highestPrice = currentPrice;
        await pool.query('UPDATE active_positions SET highest_price = ? WHERE mt5_ticket = ?', [highestPrice, ticket]);
      }

      // 1. Dynamic Break-Even Lock: When price moves +1.0x ATR, lock SL to Break-Even +0.2x ATR
      const profitDistance = isBuy ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
      const slPrice = Number(pos.sl_price || 0);

      if (profitDistance >= 1.0 * atr && !pos.status_note.includes('BE_LOCKED')) {
        const beSl = isBuy
          ? Number((entryPrice + 0.2 * atr).toFixed(cfg.digits))
          : Number((entryPrice - 0.2 * atr).toFixed(cfg.digits));
        const canMove = isBuy ? (beSl > slPrice) : (slPrice === 0 || beSl < slPrice);
        if (canMove) {
          console.log(`🔒 [Crypto Break-Even] ปรับ SL ไม้ #${ticket} (${symbol}) สู่ Break-Even ที่ ${beSl}`);
          await modifyStopLoss(ticket, beSl, pos.tp_price);
          await pool.query(
            `UPDATE active_positions SET sl_price = ?, status_note = CONCAT(status_note, '_BE_LOCKED') WHERE mt5_ticket = ?`,
            [beSl, ticket]
          );
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

      // 3. AI / Technical Trend Reversal Exit: If market structure breaks against the position, exit proactively
      const isTrendBroken = isBuy
        ? (lastClose < ema50 && ema20 < ema50 && adx >= 20)
        : (lastClose > ema50 && ema20 > ema50 && adx >= 20);

      if (isTrendBroken && heldMinutes >= 15) {
        console.log(`🚨 [Crypto AI Trend Exit] ไม้ #${ticket} (${symbol} ${isBuy ? 'BUY' : 'SELL'}) โครงสร้างเทรนด์กลับทิศทาง (EMA20/50 Cross & ADX ${adx.toFixed(1)}) -> สั่งปิดตัดความเสี่ยงทันที`);
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

    // Track 3: Pullback & Support/Resistance Retest (Dip / Rally)
    if (!signalAction) {
      const isUptrend = ema50 > ema200 && h1Bullish;
      const isDowntrend = ema50 < ema200 && !h1Bullish;

      if (isUptrend && lastLow <= ema20 * 1.003 && lastClose >= ema20 * 0.997 && rsi >= 40 && rsi <= 65) {
        signalAction = 'BUY';
        setupName = 'Bullish EMA 20 Pullback Dip';
        patternConfirmed = true;
      } else if (isDowntrend && lastHigh >= ema20 * 0.997 && lastClose <= ema20 * 1.003 && rsi >= 35 && rsi <= 60) {
        signalAction = 'SELL';
        setupName = 'Bearish EMA 20 Pullback Rally';
        patternConfirmed = true;
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
    const confidence = aiRes?.confidence || 0.60;

    console.log(`🪙 [Crypto Signal Found] ${symbol} ${signalAction} | Setup: ${setupName} | Confidence: ${(confidence * 100).toFixed(1)}% | Price: $${lastClose.toFixed(cfg.digits)}`);

    if (confidence < CRYPTO_CONFIDENCE_THRESHOLD) {
      console.log(`🛡️ [Crypto Gating] ${symbol} ความมั่นใจ ${(confidence * 100).toFixed(1)}% < ${CRYPTO_CONFIDENCE_THRESHOLD * 100}% -> ข้ามคำสั่ง`);
      scanResults.push({ symbol, status: 'LOW_CONFIDENCE', confidence });
      continue;
    }

    // 1.5 Calibrated Raw Probability Floor Guard
    const rawScore = signalAction === 'BUY'
      ? Number(aiRes?.raw_buy ?? aiRes?.prob_buy ?? confidence)
      : Number(aiRes?.raw_sell ?? aiRes?.prob_sell ?? confidence);

    if (rawScore < CRYPTO_RAW_SCORE_THRESHOLD) {
      console.log(`🛡️ [Crypto Raw Conviction Guard] ${symbol} ${signalAction}: ความมั่นใจแท้จริง ${(rawScore * 100).toFixed(1)}% < ${(CRYPTO_RAW_SCORE_THRESHOLD * 100).toFixed(1)}% -> ข้ามคำสั่ง`);
      scanResults.push({ symbol, status: 'LOW_RAW_CONVICTION', rawScore });
      continue;
    }

    // 1.6 Wick Rejection Guard (Prevent buying tops / selling bottoms with >= 45% wick)
    if (CRYPTO_REJECTION_FILTER_ENABLED) {
      const rejectionCheck = checkRejectionCandle(m5Bars, signalAction, atr);
      if (rejectionCheck.hasRejection) {
        console.log(`🛡️ [Crypto Rejection Guard] ${symbol} ${signalAction}: ${rejectionCheck.reason} -> ข้ามคำสั่งป้องกัน Stop Hunt`);
        scanResults.push({ symbol, status: 'REJECTION_VETO', reason: rejectionCheck.reason });
        continue;
      }
    }

    // Dynamic Exit Geometry Check: S/R distance & Risk-to-Reward evaluation
    const slMult = Number(process.env.CRYPTO_SL_ATR_MULT || 1.8);
    const tpMult = Number(process.env.CRYPTO_TP_ATR_MULT || 2.8);
    const slBuffer = Math.max(cfg.minSlBuffer, Number((slMult * atr).toFixed(cfg.digits)));
    const defaultTpBuffer = Number((tpMult * atr).toFixed(cfg.digits));

    if (signalAction === 'BUY') {
      const distToRes = resistancePrice - lastClose;
      if (distToRes > 0 && distToRes < defaultTpBuffer * 0.6) {
        const potentialRr = distToRes / slBuffer;
        if (potentialRr < 0.70) {
          console.log(`🛡️ [Crypto Exit Geometry] ${symbol} BUY: แนวต้านใกล้เกินไป (${distToRes.toFixed(cfg.digits)}) | R:R ต่ำเกณฑ์ (${potentialRr.toFixed(2)} < 1:0.70) -> ข้าม`);
          scanResults.push({ symbol, status: 'LOW_RR_SKIP', rr: potentialRr });
          continue;
        }
      }
    } else if (signalAction === 'SELL') {
      const distToSup = lastClose - supportPrice;
      if (distToSup > 0 && distToSup < defaultTpBuffer * 0.6) {
        const potentialRr = distToSup / slBuffer;
        if (potentialRr < 0.70) {
          console.log(`🛡️ [Crypto Exit Geometry] ${symbol} SELL: แนวรับใกล้เกินไป (${distToSup.toFixed(cfg.digits)}) | R:R ต่ำเกณฑ์ (${potentialRr.toFixed(2)} < 1:0.70) -> ข้าม`);
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

    // Calculate SL/TP with ATR Buffers
    let slPrice = signalAction === 'BUY'
      ? Number((lastClose - slBuffer).toFixed(cfg.digits))
      : Number((lastClose + slBuffer).toFixed(cfg.digits));
    let tpPrice = signalAction === 'BUY'
      ? Number((lastClose + defaultTpBuffer).toFixed(cfg.digits))
      : Number((lastClose - defaultTpBuffer).toFixed(cfg.digits));

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
          prediction: aiRes
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
