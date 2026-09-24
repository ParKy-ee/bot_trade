import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("📥 Extracting 12 entry bars for all historical trades in trade_results (id >= 8500)...");

  const [trades] = await conn.query(`
    SELECT id, symbol, action, entry_price, exit_price, pips, is_win, profit_loss, entry_time, decision_mode, market_type
    FROM trade_results
    WHERE id >= 8500 AND exit_time IS NOT NULL AND market_type IN ('forex', 'forex_shadow')
    ORDER BY id ASC
  `);

  console.log(`Found ${trades.length} trades. Fetching entry bar history for each...`);

  const enrichedTrades = [];

  for (const t of trades) {
    const [bars] = await conn.query(`
      SELECT open, high, low, close, volume, rsi, atr, time
      FROM market_bars
      WHERE symbol = ? AND time <= ?
      ORDER BY time DESC
      LIMIT 12
    `, [t.symbol, t.entry_time]);

    if (bars.length >= 11) {
      bars.reverse(); // Chronological
      enrichedTrades.push({
        trade: t,
        bars: bars
      });
    }
  }

  console.log(`✅ Successfully enriched ${enrichedTrades.length} trades with bar history.`);

  const outPath = path.resolve('data/trades_with_entry_bars.json');
  fs.writeFileSync(outPath, JSON.stringify(enrichedTrades));
  console.log(`💾 Saved to ${outPath}`);

  await conn.end();
}

run().catch(console.error);
