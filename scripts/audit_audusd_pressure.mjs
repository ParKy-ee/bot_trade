import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getRates } from '../services/mt5Broker.js';
import { predictForexMarketPressure } from '../services/modelPredictor.js';

dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=========================================================================================");
  console.log("🇦🇺 AUDUSD: MARKET PRESSURE DEEP AUDIT & ORDER OUTCOME VERIFICATION");
  console.log("=========================================================================================\n");

  // 1. Check AUDUSD trades today in trade_results
  const [trades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action, market_type, decision_mode,
      ROUND(entry_price, 5) as entry_price,
      ROUND(exit_price, 5) as exit_price,
      ROUND(pips, 1) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win,
      exit_reason,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_bkk
    FROM trade_results
    WHERE (symbol LIKE '%AUDUSD%')
      AND entry_time >= '2026-09-25 00:00:00'
    ORDER BY id ASC
  `);

  console.log(`🎯 1. ออเดอร์ AUDUSD ที่เกิดขึ้นวันนี้ (ทั้งหมด ${trades.length} ไม้):`);
  console.table(trades);

  // 2. Query market_pressure_observations for AUDUSD today
  const [obs] = await conn.query(`
    SELECT 
      id,
      DATE_FORMAT(bar_time, '%H:%i:%s') as bar_time,
      DATE_FORMAT(observed_at, '%H:%i:%s') as observed_at,
      ROUND(close_price, 5) as t0_price,
      ROUND(forward_close_3, 5) as t3_price,
      ROUND((forward_close_3 - close_price) * 10000, 1) as delta_pips,
      predicted_state,
      ROUND(prob_buy * 100, 1) as buy_pct,
      ROUND(prob_sell * 100, 1) as sell_pct,
      ROUND(prob_indecision * 100, 1) as chop_pct,
      actual_state,
      ROUND(actual_return_atr, 2) as ret_atr,
      outcome_status,
      is_correct
    FROM market_pressure_observations
    WHERE (symbol LIKE '%AUDUSD%')
      AND observed_at >= '2026-09-25 06:30:00'
    ORDER BY id ASC
  `);

  console.log(`\n📊 2. ประวัติ Market Pressure บน AUDUSD ตั้งแต่เปิดตลาดเช้า (06:30 น. - ปัจจุบัน) (ทั้งหมด ${obs.length} แถว):`);
  console.table(obs);

  // 3. Overall accuracy summary for AUDUSD
  const [summary] = await conn.query(`
    SELECT 
      COUNT(*) as total_obs,
      SUM(outcome_status = 'LABELED') as labeled_count,
      SUM(outcome_status = 'LABELED' AND is_correct = 1) as correct_count,
      ROUND(SUM(outcome_status = 'LABELED' AND is_correct = 1) * 100.0 / NULLIF(SUM(outcome_status = 'LABELED'), 0), 1) as accuracy_pct,
      SUM(outcome_status = 'LABELED' AND predicted_state IN ('BUY_PRESSURE', 'SELL_PRESSURE') AND ((predicted_state = 'BUY_PRESSURE' AND forward_close_3 > close_price) OR (predicted_state = 'SELL_PRESSURE' AND forward_close_3 < close_price))) as directional_hits,
      SUM(outcome_status = 'LABELED' AND predicted_state IN ('BUY_PRESSURE', 'SELL_PRESSURE')) as total_directional_signals
    FROM market_pressure_observations
    WHERE (symbol LIKE '%AUDUSD%')
      AND observed_at >= '2026-09-25 00:00:00'
  `);
  console.log("\n📈 3. สรุปความแม่นยำของ Market Pressure บน AUDUSD วันนี้:");
  console.table(summary);

  // 4. Live snapshot of AUDUSD right now
  try {
    const res = await getRates('AUDUSD', 'M5', 40);
    if (res && res.bars && res.bars.length > 0) {
      const livePressure = await predictForexMarketPressure(res.bars, 'AUDUSD=X');
      const lastBar = res.bars[res.bars.length - 1];
      console.log(`\n🧭 4. สถานะ AUDUSD ณ วินาทีนี้ (09:54 BKK):`);
      console.log(`  • ราคาปัจจุบัน:   ${Number(lastBar.close).toFixed(5)} ณ เวลา ${lastBar.time}`);
      console.log(`  • Predicted State: ${livePressure.state}`);
      console.log(`  • Probabilities:   BUY: ${(livePressure.probabilities.buy_pressure * 100).toFixed(1)}% | SELL: ${(livePressure.probabilities.sell_pressure * 100).toFixed(1)}% | CHOP: ${(livePressure.probabilities.indecision * 100).toFixed(1)}%`);
      console.log(`  • Metrics:         BOP: ${livePressure.metrics.bop} | KER 5: ${livePressure.metrics.ker_5} | Dir Disp (3): ${livePressure.metrics.dir_disp_3}x ATR | Wick Asym: ${livePressure.metrics.wick_asymmetry}`);
    }
  } catch (err) {
    console.warn("Live test warning:", err.message);
  }

  await conn.end();
  process.exit(0);
}

run().catch(console.error);
