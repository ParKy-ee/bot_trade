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
    "SELECT id, market_type, decision_mode, symbol, action, pips, profit_loss, exit_reason, model_version, model_source, created_at FROM trade_results WHERE DATE(created_at) = CURDATE() ORDER BY id DESC"
  );

  console.log(`Total Trades Today (Live + Shadow): ${rows.length}`);
  console.table(rows.slice(0, 25).map(r => ({
    id: r.id,
    market: r.market_type,
    mode: r.decision_mode,
    symbol: r.symbol,
    action: r.action,
    model: r.model_version,
    reason: r.exit_reason,
    pips: r.pips,
    usd: r.profit_loss,
    time: r.created_at
  })));

  // Group by market and mode
  const summary = {};
  rows.forEach(r => {
    const key = `${r.market_type} | ${r.decision_mode} | ${r.model_version}`;
    summary[key] = summary[key] || { count: 0, wins: 0, losses: 0, pips: 0, usd: 0 };
    summary[key].count++;
    if (Number(r.profit_loss) > 0) summary[key].wins++;
    else if (Number(r.profit_loss) < 0) summary[key].losses++;
    summary[key].pips += Number(r.pips || 0);
    summary[key].usd += Number(r.profit_loss || 0);
  });
  console.log('\n--- Grouped Today Summary ---');
  console.table(summary);

  await pool.end();
})();
