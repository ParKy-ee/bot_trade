import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  async function calculateComparison(days) {
    const [rows] = await conn.query(`
      SELECT
        CASE
          WHEN (HOUR(entry_time) = 4 OR HOUR(entry_time) = 5 OR (HOUR(entry_time) = 6 AND MINUTE(entry_time) < 30))
            THEN 'Inside Rollover (04:00 - 06:30 BKK)'
          ELSE 'Clean Hours (Outside 04:00 - 06:30)'
        END as window_category,
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
        ROUND(
          SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
          2
        ) as win_rate_pct,
        ROUND(SUM(profit_loss), 2) as net_usd,
        ROUND(SUM(pips), 1) as net_pips,
        ROUND(
          ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) /
          NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0),
          2
        ) as profit_factor
      FROM trade_results
      WHERE market_type = 'forex'
        AND entry_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
        AND exit_reason != 'OPEN'
      GROUP BY window_category
    `, [days]);

    // Also get overall total
    const [overall] = await conn.query(`
      SELECT
        'All Hours (Original Total)' as window_category,
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
        ROUND(
          SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
          2
        ) as win_rate_pct,
        ROUND(SUM(profit_loss), 2) as net_usd,
        ROUND(SUM(pips), 1) as net_pips,
        ROUND(
          ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) /
          NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0),
          2
        ) as profit_factor
      FROM trade_results
      WHERE market_type = 'forex'
        AND entry_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
        AND exit_reason != 'OPEN'
    `, [days]);

    return [...overall, ...rows];
  }

  console.log('========================================================================');
  console.log('📊 1. ผลการเปรียบเทียบในรอบ 24 ชั่วโมงล่าสุด (1 วัน):');
  console.table(await calculateComparison(1));

  console.log('\n========================================================================');
  console.log('📊 2. ผลการเปรียบเทียบในรอบ 7 วันล่าสุด (1 สัปดาห์):');
  console.table(await calculateComparison(7));

  // 3. What if we ALSO require Market Pressure confirmation (simulation on recent trades)?
  const [pressureSim] = await conn.query(`
    SELECT
      'Clean Hours + Pressure Direction Match' as simulation_scenario,
      COUNT(*) as estimated_trades,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
        2
      ) as estimated_win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as net_pips
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
      AND NOT (HOUR(entry_time) = 4 OR HOUR(entry_time) = 5 OR (HOUR(entry_time) = 6 AND MINUTE(entry_time) < 30))
      AND (
        filter_reasons LIKE '%market pressure%'
        OR filter_reasons LIKE '%PRESSURE%'
        OR ai_confidence >= 0.70
      )
  `);
  console.log('\n========================================================================');
  console.log('🚀 3. จำลองผลลัพธ์ถ้าตัด Rollover + ใช้ Market Pressure/High Confidence (7 วัน):');
  console.table(pressureSim);

  // 4. Exit Reasons during Clean Hours
  const [cleanExit] = await conn.query(`
    SELECT
      exit_reason,
      COUNT(*) as count,
      ROUND(AVG(pips), 2) as avg_pips,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins,
      ROUND(SUM(profit_loss), 2) as sum_usd
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
      AND NOT (HOUR(entry_time) = 4 OR HOUR(entry_time) = 5 OR (HOUR(entry_time) = 6 AND MINUTE(entry_time) < 30))
    GROUP BY exit_reason
    ORDER BY count DESC
  `);
  // 5. Progressive Scenario Simulation (Step 1 Rollover vs Step 1+2 Rollover + Chop Filter)
  const [scenarios] = await conn.query(`
    SELECT
      '1. สถิติเดิมรวมทุกช่วงเวลา (Original 24h)' as scenario,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as net_pips,
      ROUND(ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) as profit_factor
    FROM trade_results
    WHERE market_type = 'forex' AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
    UNION ALL
    SELECT
      '2. [ข้อ 1] ตัดช่วง Rollover 04:00 - 06:30 น. ออก' as scenario,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as net_pips,
      ROUND(ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) as profit_factor
    FROM trade_results
    WHERE market_type = 'forex' AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
      AND NOT (HOUR(entry_time) = 4 OR HOUR(entry_time) = 5 OR (HOUR(entry_time) = 6 AND MINUTE(entry_time) < 30))
    UNION ALL
    SELECT
      '3. [ข้อ 1 + ข้อ 2] ตัด Rollover + กรองตลาด Chop ที่ติดหล่ม Time-Stop ออก' as scenario,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as net_pips,
      ROUND(ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) as profit_factor
    FROM trade_results
    WHERE market_type = 'forex' AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
      AND NOT (HOUR(entry_time) = 4 OR HOUR(entry_time) = 5 OR (HOUR(entry_time) = 6 AND MINUTE(entry_time) < 30))
      AND exit_reason != 'CLOSED_TIME_STOP'
  `);
  console.log('\n========================================================================');
  console.log('🎯 5. สรุปผลกระทบทีละขั้น (Step-by-Step Scenario Analysis):');
  console.table(scenarios);

  await conn.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
