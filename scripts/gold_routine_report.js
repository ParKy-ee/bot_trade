import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function runGoldRoutine() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trading_bot',
    port: Number(process.env.DB_PORT || 3306)
  });

  console.log('========================================================================');
  console.log('🥇 [GOLD ENGINE (XAUUSD) ROUTINE & PERFORMANCE REPORT]');
  console.log(`🕒 Generated at: ${new Date().toISOString()}`);
  console.log('========================================================================\n');

  // 1. Overview
  const [summary] = await pool.query(`
    SELECT
      symbol,
      market_type,
      decision_mode,
      COALESCE(model_source, 'rule_based') as model_src,
      COALESCE(model_version, 'default') as model_ver,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0), 2
      ) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 2) as net_pips,
      ROUND(
        ABS(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END)) /
        NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2
      ) as profit_factor,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins,
      ROUND(AVG(CASE WHEN profit_loss > 0 THEN profit_loss ELSE NULL END), 2) as avg_win_usd,
      ROUND(AVG(CASE WHEN profit_loss < 0 THEN profit_loss ELSE NULL END), 2) as avg_loss_usd
    FROM trade_results
    WHERE market_type = 'gold' AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY symbol, market_type, decision_mode, model_src, model_ver
  `);
  console.log('📊 1. ภาพรวมผลการเทรดทองคำ (XAUUSD) 7 วันล่าสุด:');
  console.table(summary);

  // 2. Daily breakdown
  const [daily] = await pool.query(`
    SELECT
      DATE_FORMAT(entry_time, '%Y-%m-%d') as trade_date,
      COUNT(*) as total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 0 OR profit_loss < 0 OR pips < 0) THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND (is_win = 1 OR profit_loss > 0 OR pips > 0) THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(COUNT(*), 0), 2
      ) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 2) as net_pips
    FROM trade_results
    WHERE market_type = 'gold' AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND exit_reason != 'OPEN'
    GROUP BY DATE_FORMAT(entry_time, '%Y-%m-%d')
    ORDER BY trade_date DESC
  `);
  console.log('\n📅 2. ผลการเทรดทองคำแยกตามรายวัน:');
  console.table(daily);

  // 3. Exit reasons
  const [exits] = await pool.query(`
    SELECT
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 OR profit_loss < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 2) as net_pips,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins,
      ROUND(AVG(profit_loss), 2) as avg_pnl_usd
    FROM trade_results
    WHERE market_type = 'gold' AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND exit_reason != 'OPEN'
    GROUP BY exit_reason
    ORDER BY count DESC
  `);
  console.log('\n🚪 3. สรุปเหตุผลการปิดออเดอร์ทองคำ (Exit Breakdown):');
  console.table(exits);

  // 4. Action breakdown (BUY vs SELL)
  const [actions] = await pool.query(`
    SELECT
      action,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 OR profit_loss < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN is_win = 1 OR profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2
      ) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as net_usd,
      ROUND(SUM(pips), 2) as net_pips,
      ROUND(AVG(profit_loss), 2) as avg_pnl_usd
    FROM trade_results
    WHERE market_type = 'gold' AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND exit_reason != 'OPEN'
    GROUP BY action
  `);
  console.log('\n🎯 4. ผลลัพธ์แยกตามทิศทาง BUY vs SELL:');
  console.table(actions);

  // 5. Recent 10 trades
  const [recent] = await pool.query(`
    SELECT id, symbol, action, entry_price, exit_price, exit_reason, pips, profit_loss, is_win, hold_duration_minutes,
           DATE_FORMAT(entry_time, '%m-%d %H:%i') as entry_at,
           DATE_FORMAT(exit_time, '%m-%d %H:%i') as exit_at
    FROM trade_results
    WHERE market_type = 'gold'
    ORDER BY entry_time DESC
    LIMIT 10
  `);
  console.log('\n🕒 5. รายการเทรดทองคำล่าสุด 10 รายการ:');
  console.table(recent);

  console.log('\n========================================================================\n');
  await pool.end();
  process.exit(0);
}

runGoldRoutine().catch(err => {
  console.error(err);
  process.exit(1);
});
