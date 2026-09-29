import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { predictForexMarketPressure } from '../services/modelPredictor.js';
import {
  initMarketPressureTable,
  recordMarketPressureObservation,
  labelMarketPressureObservations,
  getMarketPressureDriftMetrics
} from '../services/marketPressureObservationTracker.js';

dotenv.config();

async function main() {
  console.log('🔄 เริ่มต้นกระบวนการ Backfill ข้อมูล Market Pressure ย้อนหลัง...');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  await initMarketPressureTable(conn);

  const symbols = [
    'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X',
    'USDCAD=X', 'USDCHF=X', 'NZDUSD=X', 'EURJPY=X', 'GBPJPY=X'
  ];

  let totalRecorded = 0;

  for (const sym of symbols) {
    const [bars] = await conn.query(`
      SELECT time, open, high, low, close, volume, rsi, atr
      FROM market_bars
      WHERE symbol = ? AND market_type = 'forex'
      ORDER BY time ASC
    `, [sym]);

    if (!bars || bars.length < 25) {
      console.log(`⚠️ ${sym}: ข้อมูลแท่งเทียนใน market_bars น้อยเกินไป (${bars ? bars.length : 0} แท่ง) -> ข้าม`);
      continue;
    }

    console.log(`📊 ${sym}: พบ ${bars.length} แท่งเทียน กำลังประมวลผลย้อนหลัง...`);

    // Process from bar index 15 to bars.length - 4 (leaving 3 future bars for labeling)
    const startIndex = Math.max(15, bars.length - 60);
    const endIndex = bars.length - 4;

    for (let i = startIndex; i <= endIndex; i++) {
      const windowBars = bars.slice(0, i + 1);
      const targetBar = windowBars[windowBars.length - 1];

      try {
        const pressureResult = await predictForexMarketPressure(windowBars, sym);
        if (pressureResult && !pressureResult.error) {
          const success = await recordMarketPressureObservation({
            pool: conn,
            symbol: sym,
            barTime: targetBar.time,
            pressureResult
          });
          if (success) totalRecorded++;
        }
      } catch (err) {
        // Skip individual errors
      }
    }
  }

  console.log(`\n📥 บันทึก Snapshot สำเร็จทั้งหมด: ${totalRecorded} จุดสังเกต`);
  console.log('🏷️ กำลังติดป้ายผลลัพธ์จริงล่วงหน้า (T+3 Ground Truth Labeling)...');

  const labelRes = await labelMarketPressureObservations(conn, 2000);
  console.log(`✅ ติดป้ายเฉลยจริงแล้ว: ${labelRes.labeled} รายการ | ค้างรอแท่งอนาคต: ${labelRes.pending} รายการ\n`);

  const metrics24h = await getMarketPressureDriftMetrics(conn, 24);
  console.log('📈 สถิติความแม่นยำหลัง Backfill (รอบ 24 ชั่วโมง):');
  console.table([
    {
      'Total Samples': metrics24h.totalSamples,
      'Correct': metrics24h.correctPredictions,
      'Accuracy %': `${metrics24h.accuracyPct}%`,
      'Buy Precision': `${metrics24h.buyPrecisionPct}%`,
      'Sell Precision': `${metrics24h.sellPrecisionPct}%`,
      'Status': metrics24h.statusText
    }
  ]);

  await conn.end();
  console.log('🎉 เสร็จสิ้นกระบวนการ Backfill เรียบร้อย!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Backfill Error:', err);
  process.exit(1);
});
