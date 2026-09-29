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

  console.log('========================================================================================');
  console.log('📊 สรุปผลลัพธ์ของระบบ Beta 2.0 (ver.beta.0.2 / ver.beta.2 เป็นต้นมา) ถึงปัจจุบัน (24 ก.ย. 2026)');
  console.log('========================================================================================\n');

  // 1. Overview across all markets since 2026-09-09
  const [overall] = await conn.query(`
    SELECT
      market_type,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END) as closed_orders,
      SUM(CASE WHEN exit_reason = 'OPEN' THEN 1 ELSE 0 END) as open_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0),
        1
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 1) as net_pips,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd,
      ROUND(
        ABS(SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss > 0 THEN profit_loss ELSE 0 END)) /
        NULLIF(ABS(SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss < 0 THEN profit_loss ELSE 0 END)), 0),
        2
      ) as profit_factor,
      ROUND(AVG(CASE WHEN exit_reason != 'OPEN' THEN hold_duration_minutes ELSE NULL END), 1) as avg_hold_mins
    FROM trade_results
    WHERE entry_time >= '2026-09-09 00:00:00'
    GROUP BY market_type
    ORDER BY total_orders DESC
  `);

  console.log('🌟 1. ภาพรวมสถิติแยกตามตลาด (Market Type) ตั้งแต่ Beta 2 (9 ก.ย. 2026 - ปัจจุบัน):');
  console.table(overall);

  // 2. Breakdown by Market & Decision Mode & Model
  const [modelBreakdown] = await conn.query(`
    SELECT
      market_type,
      decision_mode,
      model_source,
      model_version,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0),
        1
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 1) as net_pips,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-09 00:00:00'
    GROUP BY market_type, decision_mode, model_source, model_version
    ORDER BY market_type ASC, total_orders DESC
    LIMIT 20
  `);

  console.log('\n🤖 2. สถิติเจาะลึกแยกตาม Model Version & Decision Mode (Beta 2 - ปัจจุบัน):');
  console.table(modelBreakdown);

  // 3. Exit Reason Effectiveness in Beta 2
  const [exitStats] = await conn.query(`
    SELECT
      exit_reason,
      COUNT(*) as count,
      SUM(is_win = 1 OR profit_loss > 0 OR pips > 0) as wins,
      SUM(is_win = 0 OR profit_loss < 0 OR pips < 0) as losses,
      ROUND(
        SUM(is_win = 1 OR profit_loss > 0 OR pips > 0) * 100.0 / COUNT(*),
        1
      ) as win_rate_pct,
      ROUND(SUM(pips), 1) as net_pips,
      ROUND(AVG(pips), 2) as avg_pips,
      ROUND(SUM(profit_loss), 2) as net_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-09 00:00:00' AND exit_reason != 'OPEN'
    GROUP BY exit_reason
    ORDER BY count DESC
    LIMIT 15
  `);

  console.log('\n🎯 3. ประสิทธิภาพของระบบ Exit แต่ละประเภท (Beta 2 - ปัจจุบัน):');
  console.table(exitStats);

  // 4. Daily progression (Last 7 days)
  const [dailyProgression] = await conn.query(`
    SELECT
      DATE(entry_time) as date,
      market_type,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0),
        1
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 1) as net_pips,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-09 00:00:00'
    GROUP BY DATE(entry_time), market_type
    ORDER BY date DESC, total_orders DESC
    LIMIT 25
  `);

  console.log('\n📅 4. วิวัฒนาการผลงานรายวัน (Daily Progression):');
  console.table(dailyProgression);

  await conn.end();
  process.exit(0);
}

main().catch(console.error);
