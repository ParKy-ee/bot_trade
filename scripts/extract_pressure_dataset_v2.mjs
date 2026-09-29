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

  console.log("📥 Extracting fresh expanded M5 bars for Market Pressure Retraining...");

  const symbols = [
    'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X',
    'USDCAD=X', 'USDCHF=X', 'NZDUSD=X', 'EURJPY=X', 'GBPJPY=X'
  ];

  let allBars = [];
  const limitPerSymbol = 6500; // ~23 days of 5-minute bars per symbol

  for (const sym of symbols) {
    const [rows] = await conn.query(`
      SELECT symbol, time, open, high, low, close, volume, rsi, atr
      FROM market_bars
      WHERE symbol = ? AND time >= '2026-08-01'
      ORDER BY time DESC
      LIMIT ?
    `, [sym, limitPerSymbol]);

    // Reverse to chronological order (oldest to newest)
    rows.reverse();
    allBars = allBars.concat(rows);
    console.log(`  • ${sym}: loaded ${rows.length} chronological bars (${rows[0]?.time} -> ${rows[rows.length - 1]?.time})`);
  }

  console.log(`\n✅ Total fresh bars extracted: ${allBars.length}`);

  const outDir = path.resolve('data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'market_pressure_bars_v2.json');
  fs.writeFileSync(outPath, JSON.stringify(allBars));
  console.log(`💾 Saved to ${outPath}`);

  await conn.end();
}

run().catch(console.error);
