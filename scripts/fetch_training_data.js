import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EMA, RSI, ATR, ADX, BollingerBands, MACD } from 'technicalindicators';
import { initDatabase, getPool } from '../config/database.js';
import { fetchMarketData, UNIVERSE, FOREX_UNIVERSE } from '../services/marketData.js';
import { getRates } from '../services/mt5Broker.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Align technical indicator array to original length
function alignSeries(calculated, totalLength, fillValue = null) {
  const offset = totalLength - calculated.length;
  const res = new Array(totalLength).fill(fillValue);
  for (let i = 0; i < calculated.length; i++) {
    res[offset + i] = calculated[i];
  }
  return res;
}

// Convert array of objects to CSV string
function toCSV(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = headers.map(h => {
      const v = r[h];
      if (v === null || v === undefined || Number.isNaN(v)) return '';
      if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return v;
    });
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

/**
 * Computes a standardized suite of technical features for model training.
 */
function enrichFeaturesWithLabels(bars, symbol, marketType) {
  const n = bars.length;
  if (n < 35) return [];

  const closes = bars.map(b => Number(b.close));
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const volumes = bars.map(b => Number(b.volume || 0));

  // 1. EMAs
  const ema20Arr = alignSeries(EMA.calculate({ period: 20, values: closes }), n);
  const ema50Arr = alignSeries(EMA.calculate({ period: 50, values: closes }), n);
  const ema200Arr = alignSeries(EMA.calculate({ period: 200, values: closes }), n);

  // 2. RSI (14)
  const rsiArr = alignSeries(RSI.calculate({ period: 14, values: closes }), n);

  // 3. ATR (14)
  const atrArr = alignSeries(ATR.calculate({ period: 14, high: highs, low: lows, close: closes }), n);

  // 4. ADX (14)
  let adxArr = new Array(n).fill(null);
  try {
    const adxCalc = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    adxArr = alignSeries(adxCalc.map(a => a.adx), n);
  } catch {}

  // 5. Bollinger Bands (20, 2)
  let bbPctArr = new Array(n).fill(null);
  try {
    const bbCalc = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
    const bbPctValues = bbCalc.map(b => {
      const width = (b.upper - b.lower) || 0.0001;
      return (closes[b.period - 1] - b.lower) / width;
    });
    bbPctArr = alignSeries(bbPctValues, n);
  } catch {}

  // 6. MACD Histogram
  let macdHistArr = new Array(n).fill(null);
  try {
    const macdCalc = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    macdHistArr = alignSeries(macdCalc.map(m => m.histogram ?? 0), n);
  } catch {}

  // 7. Assemble ML dataset records with forward-looking labels (target)
  const enriched = [];
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const c = closes[i];
    const prevC1 = i >= 1 ? closes[i - 1] : c;
    const prevC5 = i >= 5 ? closes[i - 5] : c;

    // Feature returns
    const ret1 = (c - prevC1) / (prevC1 || 1);
    const ret5 = (c - prevC5) / (prevC5 || 1);

    // EMA relative spreads
    const ema20 = ema20Arr[i];
    const ema50 = ema50Arr[i];
    const ema200 = ema200Arr[i];
    const emaSpread20_50 = (ema20 && ema50) ? (ema20 - ema50) / ema50 : null;
    const emaSpread50_200 = (ema50 && ema200) ? (ema50 - ema200) / ema200 : null;

    // Target labels: Next 1 bar return & Next 5 bars return (for model supervision)
    const nextC1 = i + 1 < n ? closes[i + 1] : null;
    const nextC5 = i + 5 < n ? closes[i + 5] : null;
    const targetRet1 = nextC1 ? (nextC1 - c) / c : null;
    const targetRet5 = nextC5 ? (nextC5 - c) / c : null;

    // Classification target: 1 if targetRet5 > +1.0%, -1 if < -1.0%, 0 neutral
    let targetClass = 0;
    if (targetRet5 !== null) {
      if (targetRet5 > 0.01) targetClass = 1;
      else if (targetRet5 < -0.01) targetClass = -1;
    }

    const timeStr = typeof b.time === 'string' ? b.time : new Date(b.time).toISOString();

    enriched.push({
      time: timeStr,
      symbol,
      market_type: marketType,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: c,
      volume: volumes[i],
      ret_1: Number(ret1.toFixed(6)),
      ret_5: Number(ret5.toFixed(6)),
      rsi_14: rsiArr[i] !== null ? Number(rsiArr[i].toFixed(2)) : null,
      atr_14: atrArr[i] !== null ? Number(atrArr[i].toFixed(5)) : null,
      atr_pct: atrArr[i] !== null ? Number((atrArr[i] / c).toFixed(5)) : null,
      adx_14: adxArr[i] !== null ? Number(adxArr[i].toFixed(2)) : null,
      ema_20: ema20 !== null ? Number(ema20.toFixed(5)) : null,
      ema_50: ema50 !== null ? Number(ema50.toFixed(5)) : null,
      ema_200: ema200 !== null ? Number(ema200.toFixed(5)) : null,
      ema_spread_20_50: emaSpread20_50 !== null ? Number(emaSpread20_50.toFixed(6)) : null,
      ema_spread_50_200: emaSpread50_200 !== null ? Number(emaSpread50_200.toFixed(6)) : null,
      macd_hist: macdHistArr[i] !== null ? Number(macdHistArr[i].toFixed(6)) : null,
      bb_pct: bbPctArr[i] !== null ? Number(bbPctArr[i].toFixed(4)) : null,
      target_ret_1: targetRet1 !== null ? Number(targetRet1.toFixed(6)) : null,
      target_ret_5: targetRet5 !== null ? Number(targetRet5.toFixed(6)) : null,
      target_class: targetClass
    });
  }

  return enriched;
}

/**
 * Saves bars to MySQL market_bars in chunks.
 */
async function saveBarsToMySQL(pool, records) {
  if (!records || records.length === 0) return 0;
  const CHUNK_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const values = chunk.map(r => [
      r.time,
      r.symbol,
      r.open,
      r.high,
      r.low,
      r.close,
      r.volume,
      r.rsi_14,
      r.atr_14,
      r.market_type
    ]);

    await pool.query(
      `INSERT INTO market_bars (time, symbol, open, high, low, close, volume, rsi, atr, market_type)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         open=VALUES(open), high=VALUES(high), low=VALUES(low),
         close=VALUES(close), volume=VALUES(volume),
         rsi=VALUES(rsi), atr=VALUES(atr),
         market_type=VALUES(market_type),
         last_scanned_at=CURRENT_TIMESTAMP`,
      [values]
    );
    inserted += chunk.length;
  }
  return inserted;
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const doStocks = args.includes('--stocks') || args.includes('--all') || args.length === 0;
  const doForexM5 = args.includes('--m5') || args.includes('--forex') || args.includes('--all') || args.length === 0;
  const doForexDaily = args.includes('--forex-daily') || args.includes('--forex') || args.includes('--all') || args.length === 0;

  console.log('='.repeat(70));
  console.log('🚀 AI TRADING MODEL DATASET COLLECTOR & PREPROCESSOR');
  console.log('='.repeat(70));
  console.log(`• เก็บข้อมูลหุ้น 5 ปี (Stocks Daily): ${doStocks ? 'เปิดใช้งาน (Yes)' : 'ข้าม (Skip)'}`);
  console.log(`• เก็บข้อมูล Forex M5 จาก MT5 (Forex M5): ${doForexM5 ? 'เปิดใช้งาน (Yes)' : 'ข้าม (Skip)'}`);
  console.log(`• เก็บข้อมูล Forex 5 ปี (Forex Daily): ${doForexDaily ? 'เปิดใช้งาน (Yes)' : 'ข้าม (Skip)'}`);
  console.log('='.repeat(70));

  await initDatabase();
  const pool = await getPool();

  const manifestPath = path.join(DATA_DIR, 'dataset_manifest.json');
  let manifest = {
    generated_at: new Date().toISOString(),
    datasets: {}
  };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.generated_at = new Date().toISOString();
    } catch {}
  }

  // ==========================================
  // 1. STOCKS DATASET (5 Years Daily from Yahoo Finance)
  // ==========================================
  if (doStocks) {
    console.log('\n[1/3] 📈 กำลังดึงข้อมูลหุ้นสหรัฐ 5 ปีย้อนหลัง (10 สัญลักษณ์)...');
    try {
      const stockRaw = await fetchMarketData(UNIVERSE, '5y');
      const allStockRecords = [];

      for (const sym of UNIVERSE) {
        const bars = stockRaw[sym];
        if (!bars || bars.length === 0) continue;
        const enriched = enrichFeaturesWithLabels(bars, sym, 'stock');
        allStockRecords.push(...enriched);
        console.log(`   • ${sym.padEnd(6)} : ${bars.length.toLocaleString()} bars -> ${enriched.length.toLocaleString()} features`);
      }

      // Save to MySQL
      const dbCount = await saveBarsToMySQL(pool, allStockRecords);

      // Export CSV and JSON
      const csvPath = path.join(DATA_DIR, 'dataset_stocks_daily_5y.csv');
      const jsonPath = path.join(DATA_DIR, 'dataset_stocks_daily_5y.json');
      fs.writeFileSync(csvPath, toCSV(allStockRecords));
      fs.writeFileSync(jsonPath, JSON.stringify(allStockRecords, null, 2));

      manifest.datasets.stocks_daily = {
        samples: allStockRecords.length,
        symbols: UNIVERSE,
        timeframe: '1D',
        csv_file: 'data/dataset_stocks_daily_5y.csv',
        json_file: 'data/dataset_stocks_daily_5y.json',
        mysql_synced_bars: dbCount
      };
      console.log(`   ✅ บันทึกชุดข้อมูลหุ้นสำเร็จ: ${allStockRecords.length.toLocaleString()} ตัวอย่าง -> ${csvPath}`);
    } catch (err) {
      console.error('   ❌ เกิดข้อผิดพลาดในการดึงข้อมูลหุ้น:', err.message);
    }
  }

  // ==========================================
  // 2. FOREX M5 DATASET (5,000 Bars from MT5)
  // ==========================================
  if (doForexM5) {
    console.log('\n[2/3] 💱 กำลังดึงข้อมูล Forex M5 จาก MetaTrader 5 (5,000 แท่งต่อคู่เงิน)...');
    try {
      const allForexM5Records = [];
      const tf = 'M5';
      const count = 5000;

      for (const sym of FOREX_UNIVERSE) {
        if (sym === 'DX-Y.NYB') continue;
        const cleanSymbol = sym.replace('=X', '');
        console.log(`   • กำลังดึง ${cleanSymbol} (M5 x ${count} bars จาก MT5)...`);
        const res = await getRates(cleanSymbol, tf, count);
        if (res && res.bars && res.bars.length > 0) {
          const enriched = enrichFeaturesWithLabels(res.bars, sym, 'forex');
          allForexM5Records.push(...enriched);
          console.log(`     -> สำเร็จ: ${res.bars.length.toLocaleString()} bars (Tick volume ครบถ้วน)`);
        } else {
          console.warn(`     ⚠️ ไม่สามารถดึง M5 สำหรับ ${cleanSymbol} ได้:`, res?.error || 'No bars');
        }
      }

      if (allForexM5Records.length > 0) {
        // Save to MySQL
        const dbCount = await saveBarsToMySQL(pool, allForexM5Records);

        // Export CSV and JSON
        const csvPath = path.join(DATA_DIR, 'dataset_forex_m5.csv');
        const jsonPath = path.join(DATA_DIR, 'dataset_forex_m5.json');
        fs.writeFileSync(csvPath, toCSV(allForexM5Records));
        fs.writeFileSync(jsonPath, JSON.stringify(allForexM5Records, null, 2));

        manifest.datasets.forex_m5 = {
          samples: allForexM5Records.length,
          timeframe: 'M5',
          csv_file: 'data/dataset_forex_m5.csv',
          json_file: 'data/dataset_forex_m5.json',
          mysql_synced_bars: dbCount
        };
        console.log(`   ✅ บันทึกชุดข้อมูล Forex M5 สำเร็จ: ${allForexM5Records.length.toLocaleString()} ตัวอย่าง -> ${csvPath}`);
      }
    } catch (err) {
      console.error('   ❌ เกิดข้อผิดพลาดในการดึง Forex M5:', err.message);
    }
  }

  // ==========================================
  // 3. FOREX DAILY DATASET (5 Years Daily from Yahoo Finance)
  // ==========================================
  if (doForexDaily) {
    console.log('\n[3/3] 🌍 กำลังดึงข้อมูล Forex 5 ปีย้อนหลัง (Daily Macro Trend)...');
    try {
      const forexRaw = await fetchMarketData(FOREX_UNIVERSE, '5y');
      const allForexDailyRecords = [];

      for (const sym of FOREX_UNIVERSE) {
        const bars = forexRaw[sym];
        if (!bars || bars.length === 0) continue;
        const enriched = enrichFeaturesWithLabels(bars, sym, 'forex');
        allForexDailyRecords.push(...enriched);
        console.log(`   • ${sym.padEnd(10)} : ${bars.length.toLocaleString()} bars -> ${enriched.length.toLocaleString()} features`);
      }

      // Save to MySQL
      const dbCount = await saveBarsToMySQL(pool, allForexDailyRecords);

      // Export CSV and JSON
      const csvPath = path.join(DATA_DIR, 'dataset_forex_daily_5y.csv');
      const jsonPath = path.join(DATA_DIR, 'dataset_forex_daily_5y.json');
      fs.writeFileSync(csvPath, toCSV(allForexDailyRecords));
      fs.writeFileSync(jsonPath, JSON.stringify(allForexDailyRecords, null, 2));

      manifest.datasets.forex_daily = {
        samples: allForexDailyRecords.length,
        timeframe: '1D',
        csv_file: 'data/dataset_forex_daily_5y.csv',
        json_file: 'data/dataset_forex_daily_5y.json',
        mysql_synced_bars: dbCount
      };
      console.log(`   ✅ บันทึกชุดข้อมูล Forex Daily สำเร็จ: ${allForexDailyRecords.length.toLocaleString()} ตัวอย่าง -> ${csvPath}`);
    } catch (err) {
      console.error('   ❌ เกิดข้อผิดพลาดในการดึง Forex Daily:', err.message);
    }
  }

  // Save Manifest metadata
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('\n' + '='.repeat(70));
  console.log('🎉 สรุปการเตรียมชุดข้อมูลสำหรับ AI Model:');
  console.log(`📁 ไฟล์ Manifest: ${manifestPath}`);
  for (const [k, v] of Object.entries(manifest.datasets)) {
    console.log(`• [${k}]: ${v.samples.toLocaleString()} samples | File: ${v.csv_file}`);
  }
  console.log('='.repeat(70));
  console.log('💡 ตัวอย่างโค้ด Python ในการโหลดข้อมูลไปเทรน Model:');
  console.log('   import pandas as pd');
  console.log("   df_stocks = pd.read_csv('data/dataset_stocks_daily_5y.csv')");
  console.log("   df_forex_m5 = pd.read_csv('data/dataset_forex_m5.csv')");
  console.log("   print(df_forex_m5.head())");
  console.log('='.repeat(70));

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
