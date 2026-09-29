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

  console.log('========================================================================');
  console.log('🔍 FORENSIC AUDIT: WHY IS LIVE TRADE WIN RATE AT ~38%?');
  console.log('========================================================================\n');

  // 1. Exit reasons in Live Forex (24 Hours)
  const [lossBreakdown] = await conn.query(`
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
    GROUP BY exit_reason
    ORDER BY count DESC
  `);
  console.log('1. สรุปเหตุผลการปิดออเดอร์ใน Live Trade (24 ชม. ล่าสุด):');
  console.table(lossBreakdown);

  // 2. Strategy / Action in Live Forex
  const [strategyBreakdown] = await conn.query(`
    SELECT
      action,
      COALESCE(strategy_version, 'unknown') as setup,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
    GROUP BY action, setup
    ORDER BY count DESC
  `);
  console.log('\n2. สรุป Win Rate แยกตาม Action และ Strategy:');
  console.table(strategyBreakdown);

  // 3. By Symbol Win Rate
  const [symBreakdown] = await conn.query(`
    SELECT
      symbol,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 1) as sum_pips
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
    GROUP BY symbol
    ORDER BY win_rate_pct ASC
  `);
  console.log('\n3. สรุป Win Rate แยกตามคู่เงินใน Live:');
  console.table(symBreakdown);

  // 4. Sample 10 SL trades: What happened? Check duration, entry price, exit price
  const [slSamples] = await conn.query(`
    SELECT
      id,
      symbol,
      action,
      DATE_FORMAT(entry_time, '%H:%i') as entry_bkk,
      entry_price,
      exit_price,
      hold_duration_minutes as hold_mins,
      pips,
      profit_loss as pnl,
      exit_reason
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason = 'CLOSED_SL'
    ORDER BY id DESC
    LIMIT 8
  `);
  console.log('\n4. ตัวอย่างออเดอร์ที่โดน Stop Loss (CLOSED_SL) ล่าสุด:');
  console.table(slSamples);

  // 5. Check performance by hour of day (Bangkok time)
  const [byHour] = await conn.query(`
    SELECT
      HOUR(entry_time) as hour_bkk,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
    GROUP BY hour_bkk
    ORDER BY hour_bkk ASC
  `);
  console.log('\n5. สถิติ Win Rate แยกตามชั่วโมงในแต่ละวัน (เวลาไทย):');
  console.table(byHour);

  // 6. Check trades with Market Pressure confirmation vs without
  const [pressureCheck] = await conn.query(`
    SELECT
      CASE
        WHEN filter_reasons LIKE '%market pressure%' OR filter_reasons LIKE '%PRESSURE%' THEN 'Pressure Supported / Bypassed'
        ELSE 'Standard Filter Track'
      END as entry_category,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd
    FROM trade_results
    WHERE market_type = 'forex'
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason != 'OPEN'
    GROUP BY entry_category
  `);
  console.log('\n6. ผลลัพธ์เปรียบเทียบระหว่างไม้ที่ใช้ Market Pressure กับไม้ทั่วไป:');
  console.table(pressureCheck);

  await conn.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
