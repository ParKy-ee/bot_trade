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

  const [rows] = await conn.query(`
    SELECT id, mt5_ticket, symbol, market_type, action, lot_size, entry_price, sl_price, tp_price, ROUND(ai_confidence*100, 1) as conf_pct, DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk
    FROM trade_results
    WHERE mt5_ticket IS NOT NULL AND exit_reason = 'OPEN'
    ORDER BY id DESC
  `);
  console.log(`\n=== OPEN LIVE MT5 ORDERS (Total: ${rows.length}) ===`);
  console.table(rows);
  await conn.end();
  process.exit(0);
}

main().catch(console.error);
