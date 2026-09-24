import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RSI, ATR } from 'technicalindicators';
import { initDatabase, getPool } from '../config/database.js';
import { fetchMarketData, UNIVERSE } from '../services/marketData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper to align indicator array to match original series length
function alignIndicator(calculated, totalLength) {
  const offset = totalLength - calculated.length;
  const full = new Array(totalLength).fill(null);
  for (let i = 0; i < calculated.length; i++) {
    full[offset + i] = calculated[i];
  }
  return full;
}

async function fetchAndStore5Years() {
  console.log('='.repeat(65));
  console.log('📦 สคริปต์ดึงและบันทึกข้อมูลตลาดหุ้นย้อนหลัง 5 ปี (5-Year Historical Loader)');
  console.log(`📌 รายชื่อหุ้น (Universe): ${UNIVERSE.join(', ')}`);
  console.log('='.repeat(65));

  // 1. Initialize Database
  await initDatabase();
  const pool = await getPool();

  // 2. Fetch 5 years data
  console.log('\n[*] กำลังดาวน์โหลดข้อมูลย้อนหลัง 5 ปีจาก Yahoo Finance...');
  const startTime = Date.now();
  let rawData = {};
  try {
    rawData = await fetchMarketData(UNIVERSE, '5y');
  } catch (err) {
    console.error('❌ ดึงข้อมูลตลาดล้มเหลว:', err.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ ดาวน์โหลดเสร็จสิ้นใน ${elapsed} วินาที!`);

  let grandTotalBars = 0;
  const summary = [];

  // 3. Process each symbol & insert into MySQL
  for (const symbol of UNIVERSE) {
    const bars = rawData[symbol];
    if (!bars || bars.length === 0) {
      console.warn(`⚠️ ไม่พบข้อมูลสำหรับ ${symbol}`);
      continue;
    }

    const n = bars.length;
    const closes = bars.map(b => Number(b.close));
    const highs = bars.map(b => Number(b.high));
    const lows = bars.map(b => Number(b.low));

    // Calculate RSI 14 and ATR 14 for all historical bars
    let rsiValues = new Array(n).fill(null);
    let atrValues = new Array(n).fill(null);

    try {
      const rsiCalc = RSI.calculate({ period: 14, values: closes });
      rsiValues = alignIndicator(rsiCalc, n);
    } catch {}

    try {
      const atrCalc = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      atrValues = alignIndicator(atrCalc, n);
    } catch {}

    // Prepare rows for MySQL
    const rows = [];
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      rows.push([
        b.time,
        symbol,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        rsiValues[i] != null ? Number(rsiValues[i].toFixed(2)) : null,
        atrValues[i] != null ? Number(atrValues[i].toFixed(4)) : null
      ]);
    }

    // Chunked batch insertion (500 rows per chunk)
    const CHUNK_SIZE = 500;
    for (let c = 0; c < rows.length; c += CHUNK_SIZE) {
      const chunk = rows.slice(c, c + CHUNK_SIZE);
      const sql = `
        INSERT INTO market_bars (time, symbol, open, high, low, close, volume, rsi, atr)
        VALUES ?
        ON DUPLICATE KEY UPDATE
          open=VALUES(open), high=VALUES(high), low=VALUES(low),
          close=VALUES(close), volume=VALUES(volume),
          rsi=VALUES(rsi), atr=VALUES(atr),
          last_scanned_at=CURRENT_TIMESTAMP
      `;
      await pool.query(sql, [chunk]);
    }

    grandTotalBars += n;
    const startDate = bars[0].time;
    const endDate = bars[bars.length - 1].time;
    summary.push({ symbol, bars: n, from: startDate, to: endDate });
    console.log(`[+] ${symbol.padEnd(5)}: บันทึก ${n} bars (${startDate} ถึง ${endDate})`);
  }

  // 4. Save offline JSON backup
  const backupFile = path.join(DATA_DIR, 'stock_data_5years.json');
  try {
    fs.writeFileSync(backupFile, JSON.stringify(rawData), 'utf8');
    console.log(`\n💾 บันทึกไฟล์สำรอง JSON เรียบร้อย: ${backupFile}`);
  } catch (err) {
    console.warn('⚠️ ไม่สามารถบันทึกไฟล์ JSON สำรอง:', err.message);
  }

  console.log('\n' + '='.repeat(65));
  console.log(`🎉 เสร็จสิ้นสมบูรณ์! บันทึกข้อมูลทั้งหมด ${grandTotalBars.toLocaleString()} แถว ลง MySQL เรียบร้อย`);
  console.log('='.repeat(65));
  process.exit(0);
}

fetchAndStore5Years().catch(err => {
  console.error('❌ เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
