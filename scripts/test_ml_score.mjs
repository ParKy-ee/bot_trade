import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log('========================================================================');
  console.log('📊 รายงานคะแนนและประสิทธิภาพของโมเดล ML พื้นฐาน (Model Score & Analytics)');
  console.log('========================================================================\n');

  // 1. Model Registry Scores (Offline Test Set Metrics)
  console.log('🎯 1. คะแนนความแม่นยำในการทดสอบ (Offline Benchmark Test Metrics):');
  
  // Challenger v1.7.0
  const challengerPath = path.resolve('python/models/challenger_registry.json');
  if (fs.existsSync(challengerPath)) {
    const ch = JSON.parse(fs.readFileSync(challengerPath, 'utf8'));
    console.log('\n--- [A] โมเดลหลักปัจจุบัน: Challenger v1.7.0 (Dual GradientBoosting) ---');
    console.log(`• ขนาดชุดข้อมูลทดสอบ: ${ch.dataset.total_samples.toLocaleString()} แถว (Train: ${ch.dataset.train_samples.toLocaleString()}, Test: ${ch.dataset.test_samples.toLocaleString()})`);
    console.table([
      {
        Direction: 'BUY',
        Threshold: ch.metrics.buy.threshold,
        Accuracy: `${(ch.metrics.buy.accuracy * 100).toFixed(1)}%`,
        Precision: `${(ch.metrics.buy.precision * 100).toFixed(1)}%`,
        Recall: `${(ch.metrics.buy.recall * 100).toFixed(1)}%`,
        'ROC-AUC': ch.metrics.buy.roc_auc.toFixed(4),
        F1: ch.metrics.buy.f1.toFixed(3),
        MCC: ch.metrics.buy.mcc.toFixed(3)
      },
      {
        Direction: 'SELL',
        Threshold: ch.metrics.sell.threshold,
        Accuracy: `${(ch.metrics.sell.accuracy * 100).toFixed(1)}%`,
        Precision: `${(ch.metrics.sell.precision * 100).toFixed(1)}%`,
        Recall: `${(ch.metrics.sell.recall * 100).toFixed(1)}%`,
        'ROC-AUC': ch.metrics.sell.roc_auc.toFixed(4),
        F1: ch.metrics.sell.f1.toFixed(3),
        MCC: ch.metrics.sell.mcc.toFixed(3)
      }
    ]);
  }

  // Champion v1.6.0
  const championPath = path.resolve('python/models/model_registry.json');
  if (fs.existsSync(championPath)) {
    const cp = JSON.parse(fs.readFileSync(championPath, 'utf8'));
    const v16 = cp.versions.find(v => v.version === 'v1.6.0');
    if (v16) {
      console.log('\n--- [B] โมเดลพื้นฐานดั้งเดิม: Champion v1.6.0 (Tri-Ensemble: LGBM+XGB+CatBoost+RF) ---');
      console.log(`• ขนาดชุดข้อมูลทดสอบ: ${v16.dataset.total_samples.toLocaleString()} แถว (Train: ${v16.dataset.train_samples.toLocaleString()}, Test: ${v16.dataset.test_samples.toLocaleString()})`);
      console.table([
        {
          Direction: 'BUY',
          Accuracy: `${(v16.metrics.accuracy_buy * 100).toFixed(1)}%`,
          Precision: `${(v16.metrics.precision_buy * 100).toFixed(1)}%`,
          Recall: `${(v16.metrics.recall_buy * 100).toFixed(1)}%`,
          'ROC-AUC': v16.metrics.roc_auc_buy.toFixed(4),
          F1: v16.metrics.f1_buy.toFixed(3),
          MCC: v16.metrics.mcc_buy.toFixed(3)
        },
        {
          Direction: 'SELL',
          Accuracy: `${(v16.metrics.accuracy_sell * 100).toFixed(1)}%`,
          Precision: `${(v16.metrics.precision_sell * 100).toFixed(1)}%`,
          Recall: `${(v16.metrics.recall_sell * 100).toFixed(1)}%`,
          'ROC-AUC': v16.metrics.roc_auc_sell.toFixed(4),
          F1: v16.metrics.f1_sell.toFixed(3),
          MCC: v16.metrics.mcc_sell.toFixed(3)
        }
      ]);
    }
  }

  // Market Pressure v1.0.0
  const mpPath = path.resolve('python/models/market_pressure_registry.json');
  if (fs.existsSync(mpPath)) {
    const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
    console.log('\n--- [C] โมเดลวัดแรงดันตลาด: Market Pressure & Indecision v1.0.0 (Random Forest) ---');
    console.table([
      {
        Model: mp.model_id,
        Algorithm: 'Balanced Random Forest (100 Trees)',
        'Buy Safe Rate': `${(mp.performance.buy_safe_rate * 100).toFixed(1)}%`,
        'Sell Safe Rate': `${(mp.performance.sell_safe_rate * 100).toFixed(1)}%`,
        'Top Feature 1': mp.top_features[0],
        'Top Feature 2': mp.top_features[1],
        'Top Feature 3': mp.top_features[2]
      }
    ]);
  }

  // 2. Realized Out-of-Sample Performance in Database
  console.log('\n📈 2. ผลการเทรดจริงสะสมแยกตามเวอร์ชันโมเดลในฐานข้อมูล (Realized Trades):');
  const [rows] = await conn.query(`
    SELECT
      market_type,
      model_source,
      model_version,
      decision_mode,
      COUNT(*) as total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0),
        1
      ) as win_rate,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 1) as net_pips,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd
    FROM trade_results
    WHERE market_type IN ('forex', 'forex_shadow')
    GROUP BY market_type, model_source, model_version, decision_mode
    ORDER BY total_trades DESC
    LIMIT 10
  `);
  console.table(rows);

  await conn.end();
  process.exit(0);
}

main().catch(console.error);
