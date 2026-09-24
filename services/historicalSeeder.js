import { getPool } from '../config/database.js';
import { fetchMarketData, UNIVERSE } from './marketData.js';
import { calculateIndicators } from './indicators.js';
import { predictConfidence } from './modelPredictor.js';
import dotenv from 'dotenv';

dotenv.config();

const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.38);

/**
 * Seeds historical market bars and paper signals.
 * Replicates the full behavior of seed_historical.py.
 */
export async function seedHistoricalData() {
  console.log('[*] เริ่มต้นกระบวนการ Seed ข้อมูลตลาดและสัญญาณย้อนหลัง...');
  const pool = await getPool();

  // 1. Fetch 1 year of historical data
  const rawData = await fetchMarketData(UNIVERSE, '1y');
  if (!rawData || Object.keys(rawData).length === 0) {
    throw new Error('ไม่สามารถดึงข้อมูลย้อนหลังจาก Yahoo Finance ได้');
  }

  // 2. Insert market_bars for all symbols
  console.log('[*] กำลังบันทึก Market Bars ย้อนหลังลงฐานข้อมูล...');
  let totalBarsInserted = 0;

  for (const symbol of UNIVERSE) {
    const bars = rawData[symbol];
    if (!bars || bars.length === 0) continue;

    const values = [];
    for (const b of bars) {
      values.push([
        b.time,
        symbol,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        null, // RSI populated on scan or query
        null  // ATR populated on scan or query
      ]);
    }

    if (values.length > 0) {
      const sql = `
        INSERT INTO market_bars (time, symbol, open, high, low, close, volume, rsi, atr)
        VALUES ?
        ON DUPLICATE KEY UPDATE
          open=VALUES(open), high=VALUES(high), low=VALUES(low),
          close=VALUES(close), volume=VALUES(volume),
          last_scanned_at=CURRENT_TIMESTAMP
      `;
      await pool.query(sql, [values]);
      totalBarsInserted += values.length;
    }
  }
  console.log(`✅ บันทึก Market Bars ย้อนหลัง ${totalBarsInserted} แถว เรียบร้อยแล้ว`);

  // 3. Evaluate Historical Signals (last 60 days)
  const spyBars = rawData['SPY'];
  if (!spyBars || spyBars.length < 60) {
    console.warn('⚠️ ไม่พบข้อมูล SPY เพียงพอ ข้ามขั้นตอน Historical Signals');
    return { barsInserted: totalBarsInserted, signalsCreated: 0 };
  }

  console.log('[*] กำลังวิเคราะห์ Historical Signals สำหรับ 60 วันล่าสุด...');
  const dates = spyBars.slice(-60).map(b => b.time);
  let signalsCreated = 0;

  for (const scanDate of dates) {
    // Window slice up to scanDate
    const windowSpy = spyBars.filter(b => b.time <= scanDate);
    if (windowSpy.length < 30) continue;

    for (const symbol of UNIVERSE) {
      if (symbol === 'SPY') continue;
      const fullSymbolBars = rawData[symbol] || [];
      const windowSymbol = fullSymbolBars.filter(b => b.time <= scanDate);
      if (windowSymbol.length < 30) continue;

      const ind = calculateIndicators(windowSymbol, windowSpy);
      if (!ind) continue;

      if (!ind.market_bullish || ind.rs_20d <= 0) continue;

      // Predict confidence
      const pred = await predictConfidence(ind.features);
      const conf = Number(pred.confidence || 0);

      if (conf >= CONFIDENCE_THRESHOLD) {
        const price = Number(ind.close);
        const atr = Number(ind.atr_14);
        const sl = Number((price - (1.5 * atr)).toFixed(4));
        const tp = Number((price + (4.0 * atr)).toFixed(4));

        const [exists] = await pool.query(
          'SELECT id FROM signals WHERE symbol = ? AND DATE(time) = ?',
          [symbol, scanDate]
        );

        if (exists.length === 0) {
          await pool.query(
            `INSERT INTO signals (time, symbol, price, ai_confidence, sl_price, tp_price, action)
             VALUES (?, ?, ?, ?, ?, ?, 'HISTORICAL_BUY')`,
            [`${scanDate} 16:00:00`, symbol, price, conf, sl, tp]
          );

          await pool.query(
            `INSERT INTO active_positions (symbol, entry_date, entry_price, highest_price, sl_price, tp_price, status_note)
             VALUES (?, ?, ?, ?, ?, ?, 'HISTORICAL_PAPER')
             ON DUPLICATE KEY UPDATE
               highest_price = IF(status_note = 'SIGNAL_OPEN', highest_price, VALUES(highest_price)),
               sl_price = IF(status_note = 'SIGNAL_OPEN', sl_price, VALUES(sl_price)),
               tp_price = IF(status_note = 'SIGNAL_OPEN', tp_price, VALUES(tp_price)),
               status_note = IF(status_note = 'SIGNAL_OPEN', status_note, 'HISTORICAL_PAPER')`,
            [symbol, `${scanDate} 16:00:00`, price, price, sl, tp]
          );
          signalsCreated++;
        }
      }
    }
  }

  console.log(`✅ สร้าง Historical Signals เรียบร้อย: ${signalsCreated} รายการ`);
  return {
    barsInserted: totalBarsInserted,
    signalsCreated
  };
}
