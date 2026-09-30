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

  const [recentTrades] = await conn.query(`
    SELECT id, mt5_ticket, symbol, market_type, action, decision_mode,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_bkk,
      ROUND(pips, 1) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win, exit_reason
    FROM trade_results
    WHERE exit_time >= '2026-09-24 19:30:00'
    ORDER BY exit_time DESC
    LIMIT 25
  `);

  console.log(`=== 1. TRADES CLOSED IN THE LAST HOUR (19:30 - 20:54) (Total: ${recentTrades.length}) ===`);
  console.table(recentTrades);

  const [exitSummary] = await conn.query(`
    SELECT 
      exit_reason, 
      COUNT(*) as count,
      SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN profit_loss <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(
        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
        1
      ) as win_rate_pct,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(AVG(pips), 1) as avg_pips,
      ROUND(SUM(profit_loss), 2) as total_usd
    FROM trade_results
    WHERE exit_time >= '2026-09-24 19:30:00'
    GROUP BY exit_reason
    ORDER BY count DESC
  `);

  console.log('\n=== 2. EXIT REASON BREAKDOWN (19:30 - 20:54) ===');
  console.table(exitSummary);

  // Check currently open orders
  const [openTrades] = await conn.query(`
    SELECT id, mt5_ticket, symbol, market_type, action, decision_mode,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      entry_price, sl_price, tp_price, ROUND(ai_confidence*100, 1) as conf_pct
    FROM trade_results
    WHERE exit_reason = 'OPEN'
    ORDER BY id DESC
  `);

  console.log(`\n=== 3. CURRENT OPEN ORDERS (Count: ${openTrades.length}) ===`);
  console.table(openTrades);

  await conn.end();
  process.exit(0);
}

main().catch(console.error);
