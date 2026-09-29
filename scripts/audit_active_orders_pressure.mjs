import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getOpenPositions } from '../services/mt5Broker.js';

dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=== 1. Active MT5 Positions ===");
  try {
    const pos = await getOpenPositions();
    console.table(pos);
  } catch (err) {
    console.error("Error fetching MT5 positions:", err.message);
  }

  console.log("=== 2. Trade Record in trade_results for ticket #2326605974 ===");
  const [trades] = await conn.query(`
    SELECT id, mt5_ticket, symbol, action, entry_price, pips, profit_loss,
           DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
           exit_reason, reasons
    FROM trade_results
    WHERE mt5_ticket = 2326605974 OR symbol LIKE '%NZDUSD%'
    ORDER BY id DESC
    LIMIT 2
  `);
  console.log(trades);

  await conn.end();
}
main().catch(console.error);
