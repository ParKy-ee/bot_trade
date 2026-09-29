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

  const [trades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action, market_type, decision_mode,
      ROUND(entry_price, 5) as entry,
      ROUND(exit_price, 5) as exit_p,
      ROUND(pips, 1) as pips,
      ROUND(profit_loss, 2) as pnl,
      is_win, exit_reason,
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_bkk
    FROM trade_results
    WHERE symbol LIKE '%AUDUSD%'
      AND entry_time >= '2026-09-25 00:00:00'
    ORDER BY id ASC
  `);

  console.log(`Total AUDUSD trades today: ${trades.length}`);
  console.table(trades);
  await conn.end();
}

run().catch(console.error);
