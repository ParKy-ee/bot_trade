import mysql from 'mysql2/promise';

async function check() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  const [rows] = await conn.query(`
    SELECT id, symbol, 
           entry_time, 
           DATE_FORMAT(entry_time, '%Y-%m-%d %H:%i:%s') as raw_format,
           NOW() as db_now,
           UTC_TIMESTAMP() as db_utc
    FROM trade_results 
    ORDER BY id DESC 
    LIMIT 3
  `);
  console.log('TZ_CHECK:', rows);
  await conn.end();
}

check().catch(console.error);
