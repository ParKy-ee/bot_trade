import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  const [closed] = await conn.query(`
    SELECT 
      id, symbol, market_type, action, decision_mode,
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%H:%i') as \`entry_bkk\`,
      DATE_FORMAT(CONVERT_TZ(exit_time, '+00:00', '+07:00'), '%H:%i') as \`exit_bkk\`,
      entry_price, exit_price,
      ROUND(pips, 1) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win, exit_reason
    FROM trade_results
    WHERE exit_time >= '2026-09-24 10:30:00' OR exit_time >= '2026-09-24 03:30:00'
    ORDER BY exit_time DESC
  `);
  console.log('=== CLOSED TRADES SINCE PATCH (10:30) ===');
  console.table(closed);

  const [summary] = await conn.query(`
    SELECT 
      market_type,
      COUNT(*) as trades,
      SUM(is_win = 1) as wins,
      SUM(is_win = 0) as losses,
      ROUND(AVG(is_win = 1)*100, 1) as win_rate,
      ROUND(SUM(profit_loss), 2) as pnl,
      ROUND(SUM(pips), 1) as pips
    FROM trade_results
    WHERE exit_time >= '2026-09-24 10:30:00' OR exit_time >= '2026-09-24 03:30:00'
    GROUP BY market_type
  `);
  console.log('=== SUMMARY SINCE PATCH ===');
  console.table(summary);

  const [open] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, market_type, action, decision_mode,
      DATE_FORMAT(CONVERT_TZ(entry_time, '+00:00', '+07:00'), '%H:%i:%s') as \`entry_bkk\`,
      entry_price, sl_price, tp_price,
      ROUND(ai_confidence * 100, 1) as conf_pct
    FROM trade_results
    WHERE exit_time IS NULL OR exit_reason = 'OPEN'
    ORDER BY entry_time DESC
  `);
  console.log('\n=== CURRENT OPEN TRADES ===');
  console.table(open);

  await conn.end();
}

run().catch(console.error);
