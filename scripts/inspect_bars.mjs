import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });
  
  const [rows] = await conn.query("SELECT time FROM market_bars WHERE symbol = 'EURUSD=X' AND time >= '2026-01-01' ORDER BY time ASC LIMIT 5");
  console.log('2026 EURUSD bars start:', rows);
  const [count2026] = await conn.query("SELECT COUNT(*) as c FROM market_bars WHERE symbol = 'EURUSD=X' AND time >= '2026-08-01'");
  console.log('Bars since August 2026:', count2026);
  await conn.end();
}
check();
