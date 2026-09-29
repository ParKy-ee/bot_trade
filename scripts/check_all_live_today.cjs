const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trade_bot'
  });
  const [rows] = await pool.query(
    "SELECT id, mt5_ticket, symbol, action, entry_price, exit_price, pips, profit_loss, exit_reason, hold_duration_minutes, is_win FROM trade_results WHERE decision_mode = 'LIVE' AND DATE(created_at) = CURDATE() ORDER BY id DESC"
  );
  console.table(rows);
  await pool.end();
})();
