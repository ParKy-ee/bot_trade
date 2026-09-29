import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getMarketPressureDriftMetrics, labelMarketPressureObservations } from '../services/marketPressureObservationTracker.js';

dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log('========================================================================');
  console.log('🧭 Market Pressure Live Observation & Model Drift Diagnostics');
  console.log('========================================================================\n');

  // 1. Run labeling on any pending bars first
  console.log('⚙️ กำลังตรวจสอบและติดป้าย Ground Truth (T+3) ให้กับแท่งที่ค้างอยู่...');
  const labelResult = await labelMarketPressureObservations(conn, 500);
  console.log(`✅ ติดป้ายสำเร็จ: ${labelResult.labeled} แถว | คงเหลือรอแท่งถัดไป: ${labelResult.pending} แถว\n`);

  // 2. Fetch Drift Metrics for last 24h & 7 days
  const metrics24h = await getMarketPressureDriftMetrics(conn, 24);
  const metrics7d = await getMarketPressureDriftMetrics(conn, 168);

  console.log('📊 1. ผลประเมินความแม่นยำและการตรวจจับ Model Drift:');
  console.table([
    {
      'Time Window': '24 Hours',
      'Total Samples': metrics24h.totalSamples,
      'Correct': metrics24h.correctPredictions,
      'Accuracy %': `${metrics24h.accuracyPct}%`,
      'Buy Precision': `${metrics24h.buyPrecisionPct}%`,
      'Sell Precision': `${metrics24h.sellPrecisionPct}%`,
      'Status': metrics24h.statusText
    },
    {
      'Time Window': '7 Days',
      'Total Samples': metrics7d.totalSamples,
      'Correct': metrics7d.correctPredictions,
      'Accuracy %': `${metrics7d.accuracyPct}%`,
      'Buy Precision': `${metrics7d.buyPrecisionPct}%`,
      'Sell Precision': `${metrics7d.sellPrecisionPct}%`,
      'Status': metrics7d.statusText
    }
  ]);

  // 3. View Recent 10 Labeled Observations
  const [recentRows] = await conn.query(`
    SELECT
      id,
      symbol,
      DATE_FORMAT(bar_time, '%H:%i') as bar_bkk,
      predicted_state,
      ROUND(prob_buy*100, 0) as 'buy%',
      ROUND(prob_sell*100, 0) as 'sell%',
      actual_state,
      ROUND(actual_return_atr, 2) as ret_atr,
      CASE WHEN is_correct = 1 THEN '✅ HIT' ELSE '❌ MISS' END as result,
      outcome_status
    FROM market_pressure_observations
    ORDER BY id DESC
    LIMIT 12
  `);

  console.log('\n📝 2. ตัวอย่างการบันทึก Live Snapshot และผลเฉลยจริงล่าสุด (T+3):');
  console.table(recentRows);

  await conn.end();
  process.exit(0);
}

main().catch(console.error);
