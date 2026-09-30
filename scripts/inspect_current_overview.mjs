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

  const [openRows] = await conn.query(`
    SELECT id, mt5_ticket, symbol, market_type, action, decision_mode,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      entry_price, sl_price, tp_price, ROUND(ai_confidence*100, 1) as conf_pct, exit_reason
    FROM trade_results
    WHERE exit_reason = 'OPEN'
    ORDER BY id DESC
  `);

  console.log(`\n=== 1. CURRENT OPEN ORDERS (Count: ${openRows.length}) ===`);
  console.table(openRows);

  const [recentClosed] = await conn.query(`
    SELECT id, mt5_ticket, symbol, market_type, action, decision_mode,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_bkk,
      ROUND(pips, 1) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win, exit_reason
    FROM trade_results
    WHERE exit_time >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
    ORDER BY exit_time DESC
    LIMIT 20
  `);

  console.log(`\n=== 2. RECENTLY CLOSED ORDERS (Last 2 Hours) ===`);
  console.table(recentClosed);

  // Group by decision_mode & market_type for today
  const [todaySummary] = await conn.query(`
    SELECT 
      market_type,
      decision_mode,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN exit_reason != 'OPEN' AND profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END), 0),
        1
      ) as win_rate_pct,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 1) as net_pips,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd
    FROM trade_results
    WHERE entry_time >= DATE_SUB(NOW(), INTERVAL 12 HOUR)
    GROUP BY market_type, decision_mode
    ORDER BY market_type ASC, total_orders DESC
  `);

  console.log(`\n=== 3. TODAY (LAST 12 HOURS) PERFORMANCE BY ENTRY MODE ===`);
  console.table(todaySummary);

  await conn.end();
  process.exit(0);
}

main().catch(console.error);
