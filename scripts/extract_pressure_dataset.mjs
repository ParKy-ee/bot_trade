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

  console.log("📥 Extracting contiguous M5 bars for Market Pressure & Indecision dataset...");

  const symbols = [
    'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X',
    'USDCAD=X', 'USDCHF=X', 'NZDUSD=X', 'EURJPY=X', 'GBPJPY=X'
  ];

  let allBars = [];

  for (const sym of symbols) {
    const [rows] = await conn.query(`
      SELECT symbol, time, open, high, low, close, volume, rsi, atr
      FROM market_bars
      WHERE symbol = ?
      ORDER BY time DESC
      LIMIT 4000
    `, [sym]);

    // Reverse to chronological order (oldest to newest)
    rows.reverse();
    allBars = allBars.concat(rows);
    console.log(`  • ${sym}: loaded ${rows.length} chronological bars`);
  }

  console.log(`\n✅ Total bars extracted: ${allBars.length}`);

  const outDir = path.resolve('data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'market_pressure_bars.json');
  fs.writeFileSync(outPath, JSON.stringify(allBars));
  console.log(`💾 Saved to ${outPath}`);

  await conn.end();
}

run().catch(console.error);
