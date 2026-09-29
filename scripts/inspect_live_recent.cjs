const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trading_bot'
  });
  const [rows] = await pool.query(
    "SELECT id, mt5_ticket, symbol, action, entry_time, exit_time, hold_duration_minutes, exit_reason, pips, profit_loss FROM trade_results WHERE decision_mode = 'LIVE' AND market_type = 'forex' AND exit_reason NOT IN ('OPEN') ORDER BY id DESC LIMIT 15"
  );
  console.table(rows);
  await pool.end();
})();
