import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

function toFixed(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(Number(num))) return '-';
  return Number(num).toFixed(decimals);
}

async function runRoutineReport() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trading_bot',
    port: Number(process.env.DB_PORT || 3306)
  });

  console.log('========================================================================');
  console.log('🤖 [TRADING ROUTINE & MODEL ANALYTICS REPORT]');
  console.log(`🕒 Generated at: ${new Date().toISOString()}`);
  console.log('========================================================================\n');

  // 1. Overall Performance by Market, Run Mode (Live vs Shadow), and Model Version
  const [marketStats] = await pool.query(`
    SELECT
      market_type,
      CASE
        WHEN decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE') THEN 'LIVE'
        ELSE 'SHADOW'
      END as run_mode,
      COALESCE(model_source, 'unknown') as model_src,
      COALESCE(model_version, 'legacy/default') as model_ver,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) as closed_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 2) as net_pips,
      ROUND(
        ABS(SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss > 0 THEN profit_loss ELSE 0 END)) /
        NULLIF(ABS(SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss < 0 THEN profit_loss ELSE 0 END)), 0),
        2
      ) as profit_factor,
      ROUND(AVG(CASE WHEN exit_reason != 'OPEN' THEN hold_duration_minutes ELSE NULL END), 1) as avg_hold_mins
    FROM trade_results
    WHERE entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY market_type, run_mode, model_src, model_ver
    ORDER BY market_type ASC, run_mode ASC, total_orders DESC
  `);

  console.log('📊 1. ประสิทธิภาพแยกตาม Market, Run Mode (Live/Shadow), และ Model Version (7 วันล่าสุด):');
  console.table(marketStats.map(r => ({
    Market: r.market_type,
    Mode: r.run_mode,
    Source: r.model_src,
    Model: r.model_ver,
    Total: r.total_orders,
    Closed: r.closed_orders,
    Wins: r.wins,
    Losses: r.losses,
    'WinRate%': `${r.win_rate_pct ?? 0}%`,
    'Net USD': `$${r.net_usd ?? 0}`,
    'Net Pips': r.net_pips ?? 0,
    PF: r.profit_factor ?? '-',
    'Avg Hold (min)': r.avg_hold_mins ?? '-'
  })));

  // 2. Exit Reason Breakdown
  const [exitStats] = await pool.query(`
    SELECT
      market_type,
      CASE
        WHEN decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE') THEN 'LIVE'
        ELSE 'SHADOW'
      END as run_mode,
      exit_reason,
      COUNT(*) as count,
      ROUND(SUM(profit_loss), 2) as sum_usd,
      ROUND(SUM(pips), 2) as sum_pips
    FROM trade_results
    WHERE entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND exit_reason != 'OPEN'
    GROUP BY market_type, run_mode, exit_reason
    ORDER BY market_type ASC, run_mode ASC, count DESC
  `);

  console.log('\n🚪 2. สรุปเหตุผลการปิดออเดอร์ (Exit Reason Breakdown):');
  console.table(exitStats.map(r => ({
    Market: r.market_type,
    Mode: r.run_mode,
    'Exit Reason': r.exit_reason,
    Count: r.count,
    'Sum USD': `$${r.sum_usd ?? 0}`,
    'Sum Pips': r.sum_pips ?? 0
  })));

  // 3. Forex ML Observations Dataset Status
  let obsStats = [];
  try {
    const [obs] = await pool.query(`
      SELECT
        outcome_status,
        COUNT(*) as total_count,
        SUM(CASE WHEN target_buy = 1 THEN 1 ELSE 0 END) as buy_targets,
        SUM(CASE WHEN target_sell = 1 THEN 1 ELSE 0 END) as sell_targets,
        MIN(observed_at) as earliest_sample,
        MAX(observed_at) as latest_sample
      FROM forex_ml_observations
      GROUP BY outcome_status
    `);
    obsStats = obs;
  } catch (e) {
    obsStats = [{ error: e.message }];
  }

  console.log('\n🧪 3. สถานะ Dataset ใน forex_ml_observations สำหรับ Retrain:');
  console.table(obsStats);

  // 4. Retrain Readiness Check
  const [labeledRow] = await pool.query(`
    SELECT COUNT(*) as labeled_count
    FROM forex_ml_observations
    WHERE outcome_status = 'LABELED'
  `);
  const labeledCount = labeledRow[0]?.labeled_count || 0;

  const [forexClosedRow] = await pool.query(`
    SELECT COUNT(*) as closed_count
    FROM trade_results
    WHERE market_type = 'forex' AND exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
  `);
  const forexClosedCount = forexClosedRow[0]?.closed_count || 0;

  const [cryptoClosedRow] = await pool.query(`
    SELECT COUNT(*) as closed_count
    FROM trade_results
    WHERE market_type = 'crypto' AND exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
  `);
  const cryptoClosedCount = cryptoClosedRow[0]?.closed_count || 0;

  console.log('\n🚀 4. การประเมินความพร้อมในการ Retrain (Retrain Readiness Evaluation):');
  console.log(`   - Forex Labeled Observations: ${labeledCount} แถว (เกณฑ์ขั้นต่ำ: 200 แถว) -> ${labeledCount >= 200 ? '✅ พร้อม Retrain' : '⏳ รอเก็บข้อมูลเพิ่ม'}`);
  console.log(`   - Forex Valid Closed Trades: ${forexClosedCount} รายการ (เกณฑ์ขั้นต่ำ: 150 รายการ) -> ${forexClosedCount >= 150 ? '✅ พร้อม Retrain' : '⏳ รอเก็บข้อมูลเพิ่ม'}`);
  console.log(`   - Crypto Valid Closed Trades: ${cryptoClosedCount} รายการ (เกณฑ์ขั้นต่ำ: 100 รายการ) -> ${cryptoClosedCount >= 100 ? '✅ พร้อม Retrain' : '⏳ รอเก็บข้อมูลเพิ่ม'}`);

  console.log('\n========================================================================\n');
  await pool.end();
  process.exit(0);
}

runRoutineReport().catch(err => {
  console.error(err);
  process.exit(1);
});
