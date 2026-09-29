import mysql from 'mysql2/promise';
import fs from 'fs';

async function runComparison() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  const timeLimit = '12:32:00';

  // 1. Overall Live Comparison
  const [liveOverall] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      CASE 
        WHEN DATE(entry_time) = '2026-09-24' THEN 'เมื่อวาน (24 ก.ย. - ก่อนเพิ่ม Market Pressure)'
        ELSE 'วันนี้ (25 ก.ย. - หลังเพิ่ม Market Pressure)'
      END as period_label,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_pnl_usd,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 2) as avg_pips_per_trade,
      ROUND(AVG(CASE WHEN is_win = 1 THEN pips ELSE NULL END), 2) as avg_win_pips,
      ROUND(AVG(CASE WHEN is_win = 0 THEN pips ELSE NULL END), 2) as avg_loss_pips
    FROM trade_results
    WHERE (
      (entry_time >= '2026-09-24 00:00:00' AND entry_time <= CONCAT('2026-09-24 ', ?))
      OR
      (entry_time >= '2026-09-25 00:00:00' AND entry_time <= CONCAT('2026-09-25 ', ?))
    )
    AND decision_mode = 'LIVE'
    AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time)
    ORDER BY trade_date ASC
  `, [timeLimit, timeLimit]);

  // 2. Breakdown by Market Type (Live only)
  const [marketBreakdown] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      market_type,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE (
      (entry_time >= '2026-09-24 00:00:00' AND entry_time <= CONCAT('2026-09-24 ', ?))
      OR
      (entry_time >= '2026-09-25 00:00:00' AND entry_time <= CONCAT('2026-09-25 ', ?))
    )
    AND decision_mode = 'LIVE'
    AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time), market_type
    ORDER BY market_type ASC, trade_date ASC
  `, [timeLimit, timeLimit]);

  // 3. Exit Reasons Breakdown (Live only)
  const [exitReasons] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd,
      ROUND(AVG(pips), 2) as avg_pips
    FROM trade_results
    WHERE (
      (entry_time >= '2026-09-24 00:00:00' AND entry_time <= CONCAT('2026-09-24 ', ?))
      OR
      (entry_time >= '2026-09-25 00:00:00' AND entry_time <= CONCAT('2026-09-25 ', ?))
    )
    AND decision_mode = 'LIVE'
    AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time), exit_reason
    ORDER BY DATE(entry_time) ASC, count DESC
  `, [timeLimit, timeLimit]);

  // 4. Forex specific comparison (since Market Pressure was deployed primarily for Forex)
  const [forexSpecific] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_pnl_usd,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 2) as avg_pips,
      ROUND(AVG(CASE WHEN is_win = 0 THEN pips ELSE NULL END), 2) as avg_loss_pips
    FROM trade_results
    WHERE (
      (entry_time >= '2026-09-24 00:00:00' AND entry_time <= CONCAT('2026-09-24 ', ?))
      OR
      (entry_time >= '2026-09-25 00:00:00' AND entry_time <= CONCAT('2026-09-25 ', ?))
    )
    AND decision_mode = 'LIVE'
    AND market_type = 'forex'
    AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time)
  `, [timeLimit, timeLimit]);

  // 5. All trades including Shadow (to see model behavior)
  const [allModes] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      decision_mode,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE (
      (entry_time >= '2026-09-24 00:00:00' AND entry_time <= CONCAT('2026-09-24 ', ?))
      OR
      (entry_time >= '2026-09-25 00:00:00' AND entry_time <= CONCAT('2026-09-25 ', ?))
    )
    AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time), decision_mode
    ORDER BY trade_date ASC, total_trades DESC
  `, [timeLimit, timeLimit]);

  const output = { timeLimit, liveOverall, marketBreakdown, exitReasons, forexSpecific, allModes };
  fs.writeFileSync('scripts/compare_24_vs_25_same_window.json', JSON.stringify(output, null, 2), 'utf8');
  console.log('COMPARISON_QUERY_SUCCESS');
  await conn.end();
}

runComparison().catch(console.error);
