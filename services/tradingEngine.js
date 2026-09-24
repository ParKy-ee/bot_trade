import { getPool } from '../config/database.js';
import { fetchMarketData, UNIVERSE } from './marketData.js';
import { calculateIndicators } from './indicators.js';
import { predictConfidence } from './modelPredictor.js';
import { sendTelegramAlert } from './telegramAlert.js';
import { placeOrder, modifyStopLoss, closePosition, getOpenPositions } from './mt5Broker.js';
import { recordTradeEntry, recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';
import dotenv from 'dotenv';

dotenv.config();

const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.45);
const STOCK_MAX_POSITIONS_PER_SYMBOL = Math.max(1, Number(process.env.STOCK_MAX_POSITIONS_PER_SYMBOL || 2));
const STOCK_LIVE_ENABLED = process.env.STOCK_LIVE_ENABLED === 'true';
const STOCK_MT5_LIVE = process.env.MT5_ENABLED === 'true' && STOCK_LIVE_ENABLED;

export const STOCK_BROKER_MAP = {
  NVDA: 'Nvidia',
  TSLA: 'Tesla',
  MSFT: 'Microsoft',
  AMZN: 'Amazon',
  GOOGL: 'Google',
  GOOG: 'Google',
  META: 'Facebook',
  NFLX: 'Netflix',
  AMD: 'AdvMicroDev',
  AVGO: 'Broadcom',
  AAPL: 'Apple',
  SPY: 'SPY'
};

const REVERSE_STOCK_BROKER_MAP = {};
for (const [k, v] of Object.entries(STOCK_BROKER_MAP)) {
  REVERSE_STOCK_BROKER_MAP[v.toUpperCase()] = k.toUpperCase();
}

export function normalizeStockSymbol(sym) {
  if (!sym) return '';
  const clean = String(sym).replace(/=X$/i, '').trim().toUpperCase();
  return REVERSE_STOCK_BROKER_MAP[clean] || clean;
}

/**
 * Check if US stock market (NYSE / NASDAQ) is currently in Regular Trading Hours.
 * Regular Hours: Monday - Friday, 09:30 AM - 04:00 PM Eastern Time (America/New_York).
 * Automatically adjusts for US Daylight Saving Time (DST).
 * In Bangkok Time (GMT+7): ~20:30 - 03:00 (DST) or ~21:30 - 04:00 (Standard).
 */
export function checkUSStockMarket(date = new Date()) {
  const nyTimeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const nyDate = new Date(nyTimeStr);
  const day = nyDate.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = nyDate.getHours();
  const minute = nyDate.getMinutes();
  const totalMinutes = hour * 60 + minute;
  const isWeekend = day === 0 || day === 6;

  const openMinutes = 9 * 60 + 30; // 09:30 AM ET (570)
  const closeMinutes = 16 * 60;     // 04:00 PM ET (960)

  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET`;

  if (isWeekend) {
    return {
      isOpen: false,
      isWeekend: true,
      hour,
      minute,
      timeStr,
      reason: `ตลาดหุ้นสหรัฐปิดช่วงสุดสัปดาห์ (วันเสาร์-อาทิตย์ | ${timeStr})`
    };
  }

  if (totalMinutes < openMinutes) {
    const remainingMin = openMinutes - totalMinutes;
    const remH = Math.floor(remainingMin / 60);
    const remM = remainingMin % 60;
    const remText = remH > 0 ? `${remH} ชม. ${remM} นาที` : `${remM} นาที`;
    return {
      isOpen: false,
      isWeekend: false,
      hour,
      minute,
      timeStr,
      reason: `ตลาดหุ้นสหรัฐยังไม่เปิดทำการ (เวลาปัจจุบัน: ${timeStr} | เปิด 09:30 ET / ~20:30 น. ไทย | อีก ${remText})`
    };
  }

  if (totalMinutes >= closeMinutes) {
    return {
      isOpen: false,
      isWeekend: false,
      hour,
      minute,
      timeStr,
      reason: `ตลาดหุ้นสหรัฐปิดทำการประจำวันแล้ว (เวลาปัจจุบัน: ${timeStr} | ปิด 16:00 ET / ~03:00 น. ไทย)`
    };
  }

  return {
    isOpen: true,
    isWeekend: false,
    hour,
    minute,
    timeStr,
    reason: `ตลาดหุ้นสหรัฐเปิดทำการปกติ (${timeStr} | 09:30 - 16:00 ET)`
  };
}

/**
 * Executes a single market scan cycle.
 * Fetches data, calculates indicators, updates trailing stops, evaluates signals.
 */
export async function executeScanCycle(options = {}) {
  const { force = false } = options;
  const marketCheck = checkUSStockMarket();
  const enforceMarketHours = process.env.STOCK_MARKET_HOURS_ONLY !== 'false';

  if (!force && enforceMarketHours && !marketCheck.isOpen) {
    console.log(`[*] [${new Date().toISOString()}] ⏸️ ตลาดหุ้นสหรัฐปิดทำการ (${marketCheck.reason}) -> ข้ามรอบสแกนหุ้น`);
    return {
      success: true,
      skipped: true,
      reason: marketCheck.reason,
      marketCheck
    };
  }

  console.log(`[*] [${new Date().toISOString()}] 📈 เริ่มรอบการสแกนตลาดหุ้นสหรัฐ (${marketCheck.timeStr})...`);
  const pool = await getPool();

  // 1. Fetch market data for universe
  let rawData = {};
  try {
    rawData = await fetchMarketData(UNIVERSE, '1y');
  } catch (err) {
    console.error('❌ ดึงข้อมูลตลาดล้มเหลว:', err.message);
    return { success: false, error: err.message };
  }

  if (!rawData || Object.keys(rawData).length === 0) {
    console.warn('⚠️ ไม่มีข้อมูลตลาดที่ได้รับในรอบนี้');
    return { success: false, message: 'No market data returned' };
  }

  const spyBars = rawData['SPY'] || null;
  if (!spyBars || spyBars.length < 30) {
    console.warn('⚠️ ข้อมูล SPY ไม่เพียงพอสำหรับการตรวจสอบสภาวะตลาด');
    return { success: false, message: 'Insufficient SPY bars' };
  }

  // 2. Calculate indicators & features for each symbol
  const processedData = {};
  for (const symbol of UNIVERSE) {
    if (symbol === 'SPY') continue;
    const bars = rawData[symbol];
    if (!bars || bars.length < 30) continue;

    const ind = calculateIndicators(bars, spyBars);
    if (ind) {
      processedData[symbol] = ind;
    }
  }

  // 3. Process Active Positions: Chandelier Multi-Stage Exit & ATR Trailing Stop
  for (const [symbol, row] of Object.entries(processedData)) {
    try {
      const [posRows] = await pool.query(
        "SELECT highest_price, sl_price, tp_price, entry_price, entry_date, status_note, mt5_ticket FROM active_positions WHERE symbol = ? AND market_type = 'stock' AND status_note NOT LIKE 'CLOSED%'",
        [symbol]
      );
      if (posRows.length > 0) {
        const position = posRows[0];
        const price = Number(row.close);
        const atr = Number(row.atr_14);
        const entryPrice = Number(position.entry_price) || price;
        const currentHighest = Number(position.highest_price) || price;
        const highestPrice = Math.max(currentHighest, price);
        let currentSl = Number(position.sl_price) || (price - 1.5 * atr);
        const tpPrice = Number(position.tp_price);
        const statusNote = String(position.status_note || 'SIGNAL_OPEN');
        const isMt5Live = Boolean(position.mt5_ticket && STOCK_MT5_LIVE);

        const entryTime = position.entry_date ? new Date(position.entry_date).getTime() : Date.now();
        const holdDays = (Date.now() - entryTime) / (1000 * 60 * 60 * 24);

        // 0. Time-Stop Hard Exit for Stale Stocks: Held >= 7 calendar days with no profit progress
        if (holdDays >= 7.0 && price <= entryPrice) {
          console.log(`⏰ [Stock Time-Stop Exit] ${symbol} ถือครองครบ ${holdDays.toFixed(1)} วันแต่ราคาไม่ไปไหน ($${price.toFixed(2)} <= $${entryPrice.toFixed(2)}) -> ปิดเพื่อคืนสภาพคล่อง`);
          if (isMt5Live) {
            try { await closePosition(position.mt5_ticket); } catch (e) {}
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_TIME_STOP', highest_price = ? WHERE symbol = ? AND market_type = 'stock'",
            [highestPrice, symbol]
          );
          try {
            await recordTradeExit({
              ticket: position.mt5_ticket,
              symbol,
              exitPrice: price,
              exitReason: 'CLOSED_TIME_STOP'
            });
          } catch (e) {}
          continue;
        }

        // 0.5. AI Market Structure & Trend Breakdown Exit:
        // If holding stock >= 1 day and (Market turns Bearish or RS turns negative < -0.03 or Price drops below EMA50)
        const isDistEma50Negative = (row.features?.dist_ema_50 ?? 0) < -0.02;
        if (holdDays >= 1.0 && (!row.market_bullish || row.rs_20d < -0.03 || isDistEma50Negative)) {
          console.log(`🚨 [Stock AI Trend Exit] ${symbol} โมเดลตรวจพบเทรนด์อ่อนกำลัง (Market Bullish: ${row.market_bullish}, RS: ${(row.rs_20d*100).toFixed(1)}%, <EMA50: ${isDistEma50Negative}) -> ขายตัดความเสี่ยงทันที @ $${price.toFixed(2)}`);
          if (isMt5Live) {
            try { await closePosition(position.mt5_ticket); } catch (e) {}
          }
          await pool.query(
            "UPDATE active_positions SET status_note = 'CLOSED_AI_TREND_EXIT', highest_price = ? WHERE symbol = ? AND market_type = 'stock'",
            [highestPrice, symbol]
          );
          try {
            await recordTradeExit({
              ticket: position.mt5_ticket,
              symbol,
              exitPrice: price,
              exitReason: 'CLOSED_AI_TREND_EXIT'
            });
          } catch (e) {}
          continue;
        }

        // Only trigger local virtual close if NOT running live on MT5
        if (!isMt5Live) {
          // Check if Stop Loss hit
          if (currentSl && price <= currentSl) {
            await pool.query(
              `UPDATE active_positions
               SET status_note = 'CLOSED_SL', highest_price = ?
               WHERE symbol = ? AND market_type = 'stock'`,
              [highestPrice, symbol]
            );
            try {
              await recordTradeExit({
                ticket: position.mt5_ticket,
                symbol,
                exitPrice: price,
                exitReason: 'CLOSED_SL'
              });
            } catch (e) {}
            console.log(`[Stock Position] ${symbol} ชน Stop Loss ที่ราคา $${price.toFixed(2)} (SL: $${currentSl.toFixed(2)})`);
            continue;
          }

          // Check if Take Profit hit
          if (tpPrice && price >= tpPrice) {
            await pool.query(
              `UPDATE active_positions
               SET status_note = 'CLOSED_TP', highest_price = ?
               WHERE symbol = ? AND market_type = 'stock'`,
              [highestPrice, symbol]
            );
            try {
              await recordTradeExit({
                ticket: position.mt5_ticket,
                symbol,
                exitPrice: price,
                exitReason: 'CLOSED_TP'
              });
            } catch (e) {}
            console.log(`[Stock Position] ${symbol} ถึงเป้า Take Profit ที่ราคา $${price.toFixed(2)} (TP: $${tpPrice.toFixed(2)})`);
            continue;
          }
        }

        // Chandelier Multi-Stage Exit Strategy:
        // Stage 1 (Core 50% TP): When price reaches +2.5 ATR above entry
        let nextStatusNote = statusNote;
        const coreTpThreshold = entryPrice + (2.5 * atr);
        if (statusNote !== 'STOCK_RUNNER_OPEN' && price >= coreTpThreshold) {
          console.log(`🎯 [Chandelier Core TP1] ${symbol} กำไรแตะ +2.5 ATR ($${price.toFixed(2)} >= $${coreTpThreshold.toFixed(2)}) -> ดำเนินการ Partial Close 50%`);
          
          if (isMt5Live) {
            try {
              const partialRes = await closePosition(position.mt5_ticket, 0.01);
              if (partialRes?.success) {
                console.log(`🚀 [MT5 Partial Close] Ticket #${position.mt5_ticket} (${symbol}) ปิดทำกำไรกึ่งหนึ่งสำเร็จ @ $${partialRes.price}`);
              }
            } catch (e) {
              console.warn(`⚠️ MT5 Partial close warning (${symbol}):`, e.message);
            }
          }

          // Lock in Break-Even (+0.5 ATR) for the remaining Runner portion
          const breakEvenSl = Number((entryPrice + (0.5 * atr)).toFixed(2));
          currentSl = Math.max(currentSl, breakEvenSl);
          nextStatusNote = 'STOCK_RUNNER_OPEN';
          console.log(`🔒 [Chandelier Break-Even] ${symbol} เลื่อน SL การันตีกำไรต้นทุนไปที่ $${currentSl.toFixed(2)}`);
        }

        // Stage 1.5: 3-Day Follow-Through Failure Guard (Minervini Stale Stock Rule)
        // If held >= 3 days without expanding to +1.2 ATR, tighten SL floor towards Break-Even (+0.2 ATR)
        if (holdDays >= 3.0 && nextStatusNote !== 'STOCK_RUNNER_OPEN') {
          const isStagnant = price < (entryPrice + (1.2 * atr));
          if (isStagnant) {
            const staleFloor = Number((entryPrice + (0.2 * atr)).toFixed(2));
            currentSl = Math.max(currentSl, staleFloor);
            console.log(`⏱️ [Stock 3-Day Stagnation Guard] ${symbol} ถือมาแล้ว ${holdDays.toFixed(1)} วัน ไร้ Follow-Through -> ร่น SL กระชับความเสี่ยงสู่ Break-Even ($${currentSl.toFixed(2)})`);
          }
        }

        // Stage 2 (Runner Chandelier Trailing): Highest High - 3.0 * ATR
        let trailingSl;
        if (nextStatusNote === 'STOCK_RUNNER_OPEN') {
          const chandelierStop = highestPrice - (3.0 * atr);
          const breakEvenFloor = entryPrice + (0.5 * atr);
          trailingSl = Math.max(currentSl, chandelierStop, breakEvenFloor);
        } else {
          // Standard dynamic trailing before Core TP
          trailingSl = Math.max(currentSl, highestPrice - (1.5 * atr));
        }

        trailingSl = Number(trailingSl.toFixed(2));

        await pool.query(
          `UPDATE active_positions
           SET highest_price = ?, sl_price = ?, status_note = ?
           WHERE symbol = ? AND market_type = 'stock'`,
          [highestPrice, trailingSl, nextStatusNote, symbol]
        );

        // Sync Trailing SL to MT5 if ticket exists
        if (position.mt5_ticket && STOCK_MT5_LIVE) {
          try {
            await modifyStopLoss(position.mt5_ticket, trailingSl, tpPrice);
          } catch (err) {
            console.warn(`⚠️ MT5 Stock SL Modify warning (ticket #${position.mt5_ticket}):`, err.message);
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Error updating trailing stop for ${symbol}:`, err.message);
    }
  }

  // 4. Record latest bars and evaluate buy signals
  const scanResults = [];

  for (const [symbol, row] of Object.entries(processedData)) {
    const currPrice = Number(row.close);
    const atr = Number(row.atr_14);

    // Save latest bar into market_bars
    try {
      await pool.query(
        `INSERT INTO market_bars (time, symbol, open, high, low, close, volume, rsi, atr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           open=VALUES(open), high=VALUES(high), low=VALUES(low),
           close=VALUES(close), volume=VALUES(volume),
           rsi=VALUES(rsi), atr=VALUES(atr),
           last_scanned_at=CURRENT_TIMESTAMP`,
        [
          row.time, symbol, row.open, row.high, row.low,
          currPrice, row.volume, row.rsi_14, atr
        ]
      );
    } catch (err) {
      console.warn(`⚠️ Error saving bar for ${symbol}:`, err.message);
    }

    // AI Prediction
    let aiConf = 0;
    try {
      const pred = await predictConfidence(row.features);
      aiConf = Number(pred.confidence || 0);
    } catch (err) {
      console.warn(`⚠️ Prediction error for ${symbol}:`, err.message);
    }

    const tpPrice = Number((currPrice + (4.0 * atr)).toFixed(4));
    const slPrice = Number((currPrice - (1.5 * atr)).toFixed(4));
    const rsPct = (row.rs_20d * 100).toFixed(1);

    const isAboveEma50 = (row.features?.dist_ema_50 ?? 0) >= 0;
    console.log(`[${symbol}] ราคา: $${currPrice.toFixed(2)} | ความมั่นใจ AI: ${(aiConf * 100).toFixed(1)}% | RS: ${rsPct > 0 ? '+' : ''}${rsPct}% | >EMA50: ${isAboveEma50} | Market Bullish: ${row.market_bullish}`);

    const isBuySignal = (aiConf >= CONFIDENCE_THRESHOLD) && row.market_bullish && (row.rs_20d > 0) && isAboveEma50;

    scanResults.push({
      symbol,
      price: currPrice,
      confidence: aiConf,
      market_bullish: row.market_bullish,
      rs_20d: row.rs_20d,
      isBuySignal,
      slPrice,
      tpPrice
    });

    // If Buy Signal is triggered
    if (isBuySignal) {
      if (!STOCK_MT5_LIVE) {
        try {
          const [recentShadow] = await pool.query(
            `SELECT id FROM signals
             WHERE symbol = ? AND market_type = 'stock'
               AND source_tag = 'stock_shadow'
               AND time >= NOW() - INTERVAL 5 MINUTE
             LIMIT 1`,
            [symbol]
          );
          if (recentShadow.length === 0) {
            await pool.query(
              `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket, source_tag)
               VALUES (NOW(), ?, ?, ?, ?, ?, 'BUY', 'stock', NULL, 'stock_shadow')`,
              [symbol, currPrice, aiConf, slPrice, tpPrice]
            );
          }
        } catch (shadowErr) {
          console.warn(`⚠️ ไม่สามารถบันทึก Stock shadow signal สำหรับ ${symbol}:`, shadowErr.message);
        }
        console.log(`📊 [STOCK SHADOW] ${symbol} BUY | ไม่ส่งคำสั่ง MT5`);
        continue;
      }
      try {
        // 1. Guard against opening multiple orders in the same 5-minute candle
        const [recentSignals] = await pool.query(
          `SELECT id FROM signals WHERE symbol = ? AND market_type = 'stock' AND time >= NOW() - INTERVAL 5 MINUTE`,
          [symbol]
        );
        if (recentSignals.length > 0) {
          console.log(`⏳ [Stock Bar Guard] ${symbol} มีคำสั่งซื้อในรอบนี้แล้ว -> ข้าม`);
          continue;
        }

        // 2. MT5 Duplicate & Max Positions Guard with Broker Symbol Normalization
        if (STOCK_MT5_LIVE) {
          const livePositions = await getOpenPositions();
          if (!Array.isArray(livePositions)) {
            console.warn(`⚠️ [MT5 POSITION CHECK] ตรวจสอบหุ้น ${symbol} ไม่ได้ -> ข้ามการยิงเพื่อความปลอดภัย`);
            continue;
          }

          const livePositionsForSymbol = livePositions.filter(pos =>
            normalizeStockSymbol(pos.symbol) === symbol.toUpperCase()
          );

          if (livePositionsForSymbol.length >= STOCK_MAX_POSITIONS_PER_SYMBOL) {
            console.log(`⏭️ [MT5 DUPLICATE GUARD] ${symbol} มี position อยู่บน MT5 ครบตามลิมิตแล้ว (${livePositionsForSymbol.length}/${STOCK_MAX_POSITIONS_PER_SYMBOL} ไม้) -> ข้าม`);
            continue;
          }
        }

        console.log(`🔥 [BUY SIGNAL] ตรวจพบสัญญาณซื้อ ${symbol} @ $${currPrice.toFixed(2)} (ความมั่นใจ ${(aiConf * 100).toFixed(1)}%)`);

          const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

          // Attempt Auto-Execution on MT5 Demo (Stock CFD) if enabled
          let mt5Ticket = null;
          if (STOCK_MT5_LIVE) {
            try {
              const lot = Number(process.env.MT5_STOCK_LOT || process.env.MT5_DEFAULT_LOT || 0.1);
              const orderRes = await placeOrder({
                symbol,
                action: 'BUY',
                lot,
                sl: slPrice,
                tp: tpPrice,
                comment: `AI BUY ${symbol}`
              });
              if (orderRes && orderRes.success) {
                mt5Ticket = orderRes.ticket;
                console.log(`🚀 [MT5 STOCK ORDER FILLED] Ticket #${mt5Ticket} | BUY ${symbol} @ ${orderRes.price}`);
              } else if (orderRes && orderRes.error) {
                console.warn(`⚠️ MT5 Stock Order skipped/failed: ${orderRes.error}`);
              }
            } catch (err) {
              console.warn(`⚠️ MT5 Stock Order exception: ${err.message}`);
            }
          }

          // Do not persist a real stock trade when MT5 did not fill it.
          if (STOCK_MT5_LIVE && !(Number(mt5Ticket) > 0)) {
            console.warn(`⏭️ [INSERT GUARD] ${symbol} ไม่มี MT5 ticket หลังส่งคำสั่ง -> ไม่ Insert trade record`);
            continue;
          }

          // Insert into signals table
          await pool.query(
            `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action, market_type, mt5_ticket)
             VALUES (?, ?, ?, ?, ?, ?, 'BUY', 'stock', ?)`,
            [nowStr, symbol, currPrice, aiConf, slPrice, tpPrice, mt5Ticket]
          );

          // Insert/Update active_positions table
          await pool.query(
            `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note, market_type, mt5_ticket)
             VALUES (?, ?, ?, ?, ?, ?, 'SIGNAL_OPEN', 'stock', ?)
             ON DUPLICATE KEY UPDATE
               highest_price = GREATEST(highest_price, VALUES(highest_price)),
               sl_price = GREATEST(sl_price, VALUES(sl_price)),
               tp_price = VALUES(tp_price),
               status_note = 'SIGNAL_OPEN',
               mt5_ticket = COALESCE(VALUES(mt5_ticket), mt5_ticket)`,
            [symbol, nowStr, currPrice, currPrice, slPrice, tpPrice, mt5Ticket]
          );

          // Record Stock trade into trade_results for ML & Analytics
          try {
            await recordTradeEntry({
              ticket: mt5Ticket,
              symbol,
              marketType: 'stock',
              action: 'BUY',
              lotSize: 1.0,
              entryPrice: currPrice,
              confidence: aiConf,
              sl: slPrice,
              tp: tpPrice,
              indicators: {
                rsi: row.rsi_14,
                atr: atr
              },
              reasons: [`AI Confidence: ${(aiConf * 100).toFixed(1)}%`, `RS: ${rsPct}%`, `Market Bullish: ${row.market_bullish}`]
            });
          } catch (trErr) {
            console.warn(`⚠️ Warning recording trade result entry for ${symbol}:`, trErr.message);
          }

          // Telegram Alert
          const tpGainPct = (((tpPrice - currPrice) / currPrice) * 100).toFixed(1);
          const slLossPct = (((slPrice - currPrice) / currPrice) * 100).toFixed(1);

          const alertMsg =
            `🚨 *AI Swing Trading Signal: ซื้อ ${symbol}*\n` +
            `• ราคาปัจจุบัน: \`$${currPrice.toFixed(2)}\`\n` +
            `• ความมั่นใจ AI: \`${(aiConf * 100).toFixed(1)}%\`\n` +
            `• จุด Take Profit (เป้าหมาย): \`$${tpPrice.toFixed(2)}\` (+${tpGainPct}%)\n` +
            `• จุด Stop Loss (คัตลอส): \`$${slPrice.toFixed(2)}\` (${slLossPct}%)\n` +
            `• บันทึกลง XAMPP MySQL Database เรียบร้อย`;

          await sendTelegramAlert(alertMsg);
        } catch (err) {
          console.error(`❌ Error recording signal for ${symbol}:`, err.message);
        }
      }
    }

  console.log(`[+] รอบการสแกนเสร็จสิ้นเรียบร้อย (${scanResults.length} สัญลักษณ์)`);
  return {
    success: true,
    scannedAt: new Date().toISOString(),
    results: scanResults
  };
}
