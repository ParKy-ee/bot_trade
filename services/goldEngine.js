import { getPool } from '../config/database.js';
import { GOLD_UNIVERSE } from './marketData.js';
import { placeOrder, modifyStopLoss, closePosition, getRates, getOpenPositions } from './mt5Broker.js';
import { recordTradeEntry, recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';
import { predictGoldConfidence } from './modelPredictor.js';
import { EMA, RSI, ATR, BollingerBands } from 'technicalindicators';
import dotenv from 'dotenv';

dotenv.config();

const GOLD_DATA_HARVEST_LIVE_MODE = process.env.GOLD_DATA_HARVEST_LIVE_MODE === 'true';
const GOLD_LIVE_ENABLED = process.env.GOLD_LIVE_ENABLED === 'true';
const GOLD_MT5_LIVE = process.env.MT5_ENABLED === 'true' && GOLD_LIVE_ENABLED;
const GOLD_CONFIDENCE_THRESHOLD = Number(process.env.GOLD_CONFIDENCE_THRESHOLD || 0.50);
const GOLD_MAX_POSITIONS = Math.max(1, Number(process.env.GOLD_MAX_POSITIONS || 1));
const GOLD_LOT_SIZE = Number(process.env.GOLD_LOT_SIZE || 0.01);

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
 * Execute Gold M5 Scan Cycle
 */
export async function executeGoldScanCycle() {
  console.log(`[*] [${new Date().toISOString()}] 🟡 เริ่มรอบการสแกนตลาดทองคำ (GOLD / XAUUSD)...`);
  const pool = await getPool();
  const session = getGoldSession();

  if (session === 'ROLLOVER') {
    console.log(`🛡️ [Gold Guard] ช่วงเวลา Rollover ตลาดทองคำ (04:00 - 05:00 น.) พักการส่งคำสั่งใหม่`);
    return { success: true, message: 'Rollover period - orders blocked' };
  }

  // 1. Fetch live M5 & H1 Gold rates from MT5 in parallel
  let m5Bars = null;
  let h1Bars = null;
  const symbol = 'GOLD';

  try {
    const [m5Res, h1Res] = await Promise.all([
      getRates(symbol, 'M5', 100),
      getRates(symbol, 'H1', 40)
    ]);
    if (m5Res && m5Res.bars && m5Res.bars.length > 0) {
      m5Bars = m5Res.bars;
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

      // 1. Dynamic Break-Even Lock: When price reaches +1.2x ATR profit, move SL to Break-Even +0.3x ATR
      const profitDistance = isBuy ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
      const slPrice = Number(pos.sl_price || 0);

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

      // 2. Micro-Scalp Fast Harvest for Gold: When profit reaches >= $2.50 or >= 1.5x ATR, harvest instantly!
      if (profitDistance >= Math.max(2.5, 1.5 * atr)) {
        console.log(`⚡ [Gold Micro-Scalp Harvest] ไม้ #${ticket} กำไรแตะ +$${profitDistance.toFixed(2)} (>= 1.5 ATR) -> ปิดรวบกำไรทันที!`);
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

      // 3. Strict Scalp Time-Stop for Gold: Configurable hold duration (Default 45 minutes)
      const goldMaxHoldMinutes = Math.max(15, Number(process.env.GOLD_MAX_HOLD_MINUTES || 45));
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

  // Setup 2: Dynamic Trend Pullback to EMA 21 / EMA 50
  if (!signalAction) {
    const isEmaUptrend = lastClose > ema50 && ema50 > ema200 && h1Bullish;
    const isEmaDowntrend = lastClose < ema50 && ema50 < ema200 && !h1Bullish;

    if (isEmaUptrend && lastLow <= ema21 && lastClose > ema21 && rsi >= 35 && rsi <= 55) {
      signalAction = 'BUY';
      setupName = 'Dynamic Trend Pullback to EMA 21';
      emaPullback = true;
    } else if (isEmaDowntrend && lastHigh >= ema21 && lastClose < ema21 && rsi >= 45 && rsi <= 65) {
      signalAction = 'SELL';
      setupName = 'Dynamic Trend Pullback to EMA 21';
      emaPullback = true;
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
  const confidence = aiRes?.confidence || 0.60;
  const modelVersion = aiRes?.model_version || 'gold-v1.0.0';

  console.log(`🟡 [Gold Signal Found] ${signalAction} | Setup: ${setupName} | Confidence: ${(confidence * 100).toFixed(1)}% (Buy: ${((aiRes?.prob_buy || 0) * 100).toFixed(1)}%, Sell: ${((aiRes?.prob_sell || 0) * 100).toFixed(1)}%) | Model: ${aiRes?.model || 'gold_ml_ensemble'} | Price: $${lastClose.toFixed(2)}`);

  if (confidence < GOLD_CONFIDENCE_THRESHOLD) {
    console.log(`🛡️ [Gold Gating] ความมั่นใจ ${(confidence * 100).toFixed(1)}% < ${(GOLD_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% -> ข้ามคำสั่ง`);
    return { success: true, message: `Confidence below threshold: ${confidence}` };
  }

  // Calculate SL/TP with Structural ATR Buffers
  const slBuffer = Math.max(4.00, Number((3.0 * atr).toFixed(2)));
  const tpBuffer = Math.max(6.00, Number((4.5 * atr).toFixed(2)));

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
