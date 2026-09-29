import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getRates } from '../services/mt5Broker.js';

dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=========================================================================================");
  console.log("🧭 AUDIT GOLD MARKET PRESSURE: FROM 08:30 TO PRESENT (09:38 BKK)");
  console.log("=========================================================================================\n");

  // 1. Query market_pressure_observations for GOLD from today
  const [obs] = await conn.query(`
    SELECT 
      id,
      DATE_FORMAT(bar_time, '%H:%i:%s') as bar_time,
      DATE_FORMAT(observed_at, '%H:%i:%s') as observed_at,
      ROUND(close_price, 2) as t0_price,
      ROUND(forward_close_3, 2) as t3_price,
      ROUND(forward_close_3 - close_price, 2) as delta_usd,
      predicted_state,
      ROUND(prob_buy * 100, 1) as buy_pct,
      ROUND(prob_sell * 100, 1) as sell_pct,
      ROUND(prob_indecision * 100, 1) as chop_pct,
      actual_state,
      ROUND(actual_return_atr, 2) as ret_atr,
      ROUND(actual_mfe_atr, 2) as mfe_atr,
      ROUND(actual_mae_atr, 2) as mae_atr,
      outcome_status,
      is_correct
    FROM market_pressure_observations
    WHERE symbol = 'GOLD'
      AND observed_at >= '2026-09-25 08:30:00'
    ORDER BY id ASC
  `);

  console.log(`📊 1. ประวัติสิ่งที่โมเดลทำนาย vs ราคาที่เกิดขึ้นจริง 3 แท่งถัดไป (15 นาที) (ทั้งหมด ${obs.length} แถว):`);
  console.table(obs);

  // 2. Summary of prediction accuracy on resolved bars
  const [summary] = await conn.query(`
    SELECT 
      COUNT(*) as total_obs,
      SUM(CASE WHEN outcome_status = 'LABELED' THEN 1 ELSE 0 END) as labeled_count,
      SUM(CASE WHEN outcome_status = 'LABELED' AND is_correct = 1 THEN 1 ELSE 0 END) as correct_count,
      ROUND(SUM(CASE WHEN outcome_status = 'LABELED' AND is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN outcome_status = 'LABELED' THEN 1 ELSE 0 END), 0), 1) as accuracy_pct,
      SUM(CASE WHEN outcome_status = 'PENDING' THEN 1 ELSE 0 END) as pending_count
    FROM market_pressure_observations
    WHERE symbol = 'GOLD'
      AND observed_at >= '2026-09-25 08:30:00'
  `);
  console.log("\n📈 2. สรุปความแม่นยำของโมเดลในช่วงเวลาดังกล่าว (Accuracy Summary):");
  console.table(summary);

  // 3. Trade results for Gold
  const [trades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action,
      ROUND(entry_price, 2) as entry_price,
      ROUND(sl_price, 2) as sl_price,
      ROUND(tp_price, 2) as tp_price,
      ROUND(exit_price, 2) as exit_price,
      ROUND(profit_loss, 2) as pnl,
      ROUND(pips, 1) as pips,
      is_win,
      exit_reason,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_bkk
    FROM trade_results
    WHERE (market_type = 'gold' OR symbol = 'GOLD')
      AND entry_time >= '2026-09-25 08:00:00'
    ORDER BY id ASC
  `);
  console.log("\n🎯 3. สถานะออเดอร์ทองคำ (Trade Results) ช่วงเช้าวันนี้:");
  console.table(trades);

  // 4. Live Gold Rates right now
  try {
    const res = await getRates('GOLD', 'M5', 5);
    if (res && res.bars && res.bars.length > 0) {
      const lastBar = res.bars[res.bars.length - 1];
      console.log(`\n🪙 4. ราคาทองคำ ณ วินาทีนี้ (Latest M5 Bar): $${Number(lastBar.close).toFixed(2)} (High: $${Number(lastBar.high).toFixed(2)}, Low: $${Number(lastBar.low).toFixed(2)}) ณ เวลา ${lastBar.time}`);
    }
  } catch (err) {
    console.warn("Could not fetch latest rate:", err.message);
  }

  await conn.end();
  process.exit(0);
}

run().catch(console.error);
