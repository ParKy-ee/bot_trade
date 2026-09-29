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

  const [openTrades] = await conn.query(`
    SELECT 
      id, 
      symbol, 
      market_type, 
      action, 
      decision_mode, 
      model_source, 
      model_version, 
      entry_price, 
      sl_price, 
      tp_price, 
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk,
      exit_reason,
      prediction_meta
    FROM trade_results
    WHERE exit_time IS NULL AND (market_type LIKE '%shadow%' OR decision_mode LIKE '%SHADOW%')
    ORDER BY id DESC
  `);

  console.log(`=== OPEN SHADOW ORDERS (Total: ${openTrades.length}) ===`);
  const floatingRows = [];

  for (const t of openTrades) {
    const [latestBar] = await conn.query('SELECT close FROM market_bars WHERE symbol = ? ORDER BY time DESC LIMIT 1', [t.symbol]);
    const curr = Number(latestBar[0]?.close || t.entry_price);
    const entry = Number(t.entry_price);
    const isJpy = t.symbol.includes('JPY');
    const mult = isJpy ? 100 : 10000;
    const pips = t.action === 'BUY' ? (curr - entry) * mult : (entry - curr) * mult;

    floatingRows.push({
      id: t.id,
      symbol: t.symbol.replace('=X', ''),
      action: t.action,
      mode: t.decision_mode,
      entry_time: t.entry_bkk,
      entry_price: entry,
      curr_price: curr,
      floating: (pips > 0 ? '+' : '') + pips.toFixed(1) + 'p',
      status: pips > 0 ? '🟢 PROFIT' : (pips < 0 ? '🔴 DRAWDOWN' : '⚪ FLAT')
    });
  }
  console.table(floatingRows);

  const [recentTrades] = await conn.query(`
    SELECT 
      id, 
      symbol, 
      action, 
      decision_mode, 
      pips, 
      profit_loss, 
      is_win, 
      exit_reason, 
      DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk, 
      DATE_FORMAT(exit_time, '%H:%i:%s') as exit_bkk
    FROM trade_results
    WHERE exit_time IS NOT NULL AND (market_type LIKE '%shadow%' OR decision_mode LIKE '%SHADOW%')
    ORDER BY id DESC
    LIMIT 6
  `);

  console.log(`\n=== RECENTLY CLOSED SHADOW ORDERS (Last 6) ===`);
  console.table(recentTrades);

  await conn.end();
}

run().catch(console.error);
