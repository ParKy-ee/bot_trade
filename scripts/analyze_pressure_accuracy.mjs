import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function runAnalysis() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log('========================================================================');
  console.log('🧭 MARKET PRESSURE ENGINE ACCURACY & PERFORMANCE DEEP DIVE');
  console.log('========================================================================\n');

  // 1. Overall stats by predicted state
  const [byState] = await conn.query(`
    SELECT
      predicted_state,
      COUNT(*) as total_predictions,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
      ROUND(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as accuracy_pct,
      ROUND(AVG(actual_return_atr), 3) as avg_actual_ret_atr,
      ROUND(AVG(actual_mfe_atr), 3) as avg_mfe_atr,
      ROUND(AVG(actual_mae_atr), 3) as avg_mae_atr
    FROM market_pressure_observations
    WHERE outcome_status = 'LABELED'
    GROUP BY predicted_state
  `);
  console.log('📊 1. ความแม่นยำแยกตามสถานะที่โมเดลบอก (By Predicted State):');
  console.table(byState);

  // 2. Confusion matrix: Predicted vs Actual
  const [matrix] = await conn.query(`
    SELECT
      predicted_state,
      SUM(CASE WHEN actual_state = 'BUY_PRESSURE' THEN 1 ELSE 0 END) as actual_buy,
      SUM(CASE WHEN actual_state = 'SELL_PRESSURE' THEN 1 ELSE 0 END) as actual_sell,
      SUM(CASE WHEN actual_state = 'INDECISION_CHOP' THEN 1 ELSE 0 END) as actual_chop,
      COUNT(*) as total
    FROM market_pressure_observations
    WHERE outcome_status = 'LABELED'
    GROUP BY predicted_state
  `);
  console.log('\n🎯 2. ตารางเทียบการทำนาย vs ผลที่เกิดขึ้นจริง 3 แท่งถัดไป (Confusion Matrix):');
  console.table(matrix);

  // 3. By Symbol
  const [bySymbol] = await conn.query(`
    SELECT
      symbol,
      COUNT(*) as total,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
      ROUND(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as accuracy_pct,
      SUM(CASE WHEN predicted_state = 'BUY_PRESSURE' THEN 1 ELSE 0 END) as pred_buy,
      SUM(CASE WHEN predicted_state = 'SELL_PRESSURE' THEN 1 ELSE 0 END) as pred_sell,
      SUM(CASE WHEN predicted_state = 'INDECISION_CHOP' THEN 1 ELSE 0 END) as pred_chop
    FROM market_pressure_observations
    WHERE outcome_status = 'LABELED'
    GROUP BY symbol
    ORDER BY accuracy_pct DESC
  `);
  console.log('\n💱 3. ความแม่นยำแยกตามคู่เงิน (By Symbol):');
  console.table(bySymbol);

  // 4. Directional Precision Breakdown
  const [directional] = await conn.query(`
    SELECT
      predicted_state,
      COUNT(*) as total_signals,
      SUM(CASE WHEN (predicted_state = 'BUY_PRESSURE' AND actual_return_atr > 0) OR (predicted_state = 'SELL_PRESSURE' AND actual_return_atr < 0) THEN 1 ELSE 0 END) as moved_in_direction,
      ROUND(
        SUM(CASE WHEN (predicted_state = 'BUY_PRESSURE' AND actual_return_atr > 0) OR (predicted_state = 'SELL_PRESSURE' AND actual_return_atr < 0) THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
        2
      ) as directional_win_pct,
      ROUND(AVG(CASE WHEN predicted_state = 'BUY_PRESSURE' THEN actual_return_atr ELSE -actual_return_atr END), 3) as avg_directional_edge_atr
    FROM market_pressure_observations
    WHERE outcome_status = 'LABELED' AND predicted_state IN ('BUY_PRESSURE', 'SELL_PRESSURE')
    GROUP BY predicted_state
  `);
  console.log('\n⚡ 4. อัตราการวิ่งถูกทาง (Directional Win Rate & Edge) เฉพาะไม้ที่เกิดสัญญาณแรงซื้อ/ขาย:');
  console.table(directional);

  // 5. High Conviction vs Low Conviction
  const [conviction] = await conn.query(`
    SELECT
      CASE
        WHEN (prob_buy >= 0.45 OR prob_sell >= 0.45) THEN 'Tier 1: High Conviction (>= 45%)'
        WHEN (prob_buy >= 0.40 OR prob_sell >= 0.40) THEN 'Tier 2: Medium Conviction (40-44%)'
        ELSE 'Tier 3: Low Conviction (< 40%)'
      END as tier,
      COUNT(*) as total_samples,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as strict_hit,
      ROUND(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as strict_acc_pct,
      SUM(CASE WHEN (predicted_state = 'BUY_PRESSURE' AND actual_return_atr > 0) OR (predicted_state = 'SELL_PRESSURE' AND actual_return_atr < 0) THEN 1 ELSE 0 END) as directional_correct,
      ROUND(
        SUM(CASE WHEN (predicted_state = 'BUY_PRESSURE' AND actual_return_atr > 0) OR (predicted_state = 'SELL_PRESSURE' AND actual_return_atr < 0) THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
        2
      ) as directional_acc_pct
    FROM market_pressure_observations
    WHERE outcome_status = 'LABELED' AND predicted_state IN ('BUY_PRESSURE', 'SELL_PRESSURE')
    GROUP BY tier
    ORDER BY tier ASC
  `);
  console.log('\n🎯 5. ความแม่นยำตามระดับความแรงของสัญญาณ (Conviction Tiers):');
  console.table(conviction);

  await conn.end();
  process.exit(0);
}

runAnalysis().catch(err => {
  console.error(err);
  process.exit(1);
});
