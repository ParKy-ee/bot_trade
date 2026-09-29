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
    "SELECT id, mt5_ticket, symbol, action, pips, profit_loss, exit_reason, is_win, created_at FROM trade_results WHERE decision_mode = 'LIVE' AND DATE(created_at) = CURDATE() ORDER BY id ASC"
  );

  let totalTrades = rows.length;
  let closedTrades = rows.filter(r => r.exit_reason !== 'OPEN');
  let openTrades = rows.filter(r => r.exit_reason === 'OPEN');
  let wins = closedTrades.filter(r => Number(r.profit_loss) > 0 || r.is_win === 1);
  let losses = closedTrades.filter(r => Number(r.profit_loss) <= 0 && r.is_win === 0);
  let totalPips = closedTrades.reduce((acc, r) => acc + Number(r.pips || 0), 0);
  let totalUsd = closedTrades.reduce((acc, r) => acc + Number(r.profit_loss || 0), 0);

  console.log(`Total Live Trades: ${totalTrades}`);
  console.log(`Closed: ${closedTrades.length} (Wins: ${wins.length}, Losses: ${losses.length})`);
  console.log(`Win Rate: ${((wins.length / closedTrades.length) * 100).toFixed(1)}%`);
  console.log(`Total Pips: ${totalPips.toFixed(1)} pips`);
  console.log(`Total USD: $${totalUsd.toFixed(2)}`);

  console.log("\nBreakdown by Exit Reason:");
  const byReason = {};
  closedTrades.forEach(r => {
    byReason[r.exit_reason] = byReason[r.exit_reason] || { count: 0, wins: 0, pips: 0, usd: 0 };
    byReason[r.exit_reason].count++;
    if (Number(r.profit_loss) > 0 || r.is_win === 1) byReason[r.exit_reason].wins++;
    byReason[r.exit_reason].pips += Number(r.pips || 0);
    byReason[r.exit_reason].usd += Number(r.profit_loss || 0);
  });
  console.table(byReason);

  await pool.end();
})();
