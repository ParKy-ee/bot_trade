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
    "SELECT id, mt5_ticket, symbol, action, entry_price, exit_price, pips, profit_loss, exit_reason, hold_duration_minutes, is_win, created_at, model_version FROM trade_results WHERE decision_mode = 'LIVE' AND DATE(created_at) = CURDATE() AND model_version = 'challenger-v1.17.0' ORDER BY id ASC"
  );

  console.log(`Challenger v1.17.0 Live Trades Count: ${rows.length}`);
  const closed = rows.filter(r => r.exit_reason !== 'OPEN');
  const open = rows.filter(r => r.exit_reason === 'OPEN');
  const wins = closed.filter(r => Number(r.profit_loss) > 0 || r.is_win === 1);
  const pips = closed.reduce((acc, r) => acc + Number(r.pips || 0), 0);
  const usd = closed.reduce((acc, r) => acc + Number(r.profit_loss || 0), 0);

  console.log(`Closed: ${closed.length} | Wins: ${wins.length} | Losses: ${closed.length - wins.length}`);
  console.log(`Win Rate: ${closed.length ? ((wins.length / closed.length) * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`Total Pips: ${pips.toFixed(1)}`);
  console.log(`Total USD: $${usd.toFixed(2)}`);
  console.table(rows.map(r => ({
    id: r.id,
    ticket: r.mt5_ticket,
    symbol: r.symbol,
    action: r.action,
    entry: r.entry_price,
    exit: r.exit_price,
    pips: r.pips,
    usd: r.profit_loss,
    exit_reason: r.exit_reason,
    win: r.is_win
  })));

  await pool.end();
})();
