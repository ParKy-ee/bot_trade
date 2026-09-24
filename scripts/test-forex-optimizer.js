import { getRates } from '../services/mt5Broker.js';
import { FOREX_UNIVERSE } from '../services/marketData.js';
import { evaluateForexFirstStageFilter } from '../services/forexFilter.js';
import { calculateDynamicForexExit } from '../services/forexExitEngine.js';
import 'dotenv/config';

function calculateExitPips(clean, bars, atr14, direction) {
  const isJpy = clean.includes('JPY');
  const pipSize = isJpy ? 0.01 : 0.0001;
  const dynamicEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.FOREX_DYNAMIC_EXIT_ENABLED || 'false').toLowerCase()
  );
  if (!dynamicEnabled) {
    const minTp = isJpy ? 38 : 22;
    const minSl = isJpy ? 24 : 14;
    return {
      mode: 'current_fixed_atr',
      tpPips: Math.max(minTp, (3.3 * atr14) / pipSize),
      slPips: Math.max(minSl, (2.2 * atr14) / pipSize),
      swingPips: null,
    };
  }

  const exit = calculateDynamicForexExit({
    symbol: clean,
    action: direction,
    entryPrice: Number(bars.at(-1).close),
    atrPrice: atr14,
    bars,
    options: {
      lookbackBars: Number(process.env.FOREX_EXIT_LOOKBACK_BARS || 24),
      pivotStrength: Number(process.env.FOREX_EXIT_PIVOT_STRENGTH || 2),
      tpAtrMult: Number(process.env.FOREX_DYNAMIC_TP_ATR_MULT || 0.9),
      slAtrMult: Number(process.env.FOREX_DYNAMIC_SL_ATR_MULT || 0.8),
      bufferAtrFraction: Number(process.env.FOREX_DYNAMIC_BUFFER_ATR_FRACTION || 0.1),
      minBufferPips: Number(process.env.FOREX_DYNAMIC_MIN_BUFFER_PIPS || 1),
      minTpPips: isJpy
        ? Number(process.env.FOREX_DYNAMIC_MIN_TP_JPY || 10)
        : Number(process.env.FOREX_DYNAMIC_MIN_TP_MAJOR || 6),
      minSlPips: isJpy
        ? Number(process.env.FOREX_DYNAMIC_MIN_SL_JPY || 14)
        : Number(process.env.FOREX_DYNAMIC_MIN_SL_MAJOR || 8),
      minRiskReward: Number(process.env.FOREX_DYNAMIC_MIN_RR || 1.15)
    }
  });
  return exit;
}

async function runOptimizerTest() {
  console.log('='.repeat(70));
  console.log('🔬 ทดสอบวิเคราะห์แท่งเทียน M5 ล่าสุดจาก MT5 ทุกคู่เงิน');
  console.log('='.repeat(70));

  for (const symbol of FOREX_UNIVERSE) {
    if (symbol === 'DX-Y.NYB') continue;
    const clean = symbol.replace('=X', '');
    try {
      const res = await getRates(clean, 'M5', 100);
      if (!res || !res.bars || res.bars.length < 35) {
        console.log(`❌ ${clean}: ดึงข้อมูลไม่พอ (${res?.bars?.length || 0} bars)`);
        continue;
      }

      const bars = res.bars;
      const lastBar = bars[bars.length - 1];
      const closes = bars.map(b => Number(b.close));
      const highs = bars.map(b => Number(b.high));
      const lows = bars.map(b => Number(b.low));
      const n = bars.length;

      // Compute Fast EMA 9, 21, 50
      import('technicalindicators').then(({ EMA, RSI, ADX, ATR, MACD }) => {});
      const { EMA, RSI, ADX, ATR, MACD } = await import('technicalindicators');

      const ema9 = EMA.calculate({ period: 9, values: closes }).slice(-1)[0];
      const ema21 = EMA.calculate({ period: 21, values: closes }).slice(-1)[0];
      const ema50 = EMA.calculate({ period: 50, values: closes }).slice(-1)[0];
      const rsi9 = RSI.calculate({ period: 9, values: closes }).slice(-1)[0];
      const adx14 = ADX.calculate({ period: 14, high: highs, low: lows, close: closes }).slice(-1)[0]?.adx || 20;
      const atr14 = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).slice(-1)[0] || (lastBar.close * 0.005);
      const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).slice(-1)[0];
      const macdHist = macd?.histogram || 0;

      const currPrice = Number(lastBar.close);
      
      // Fast Scalper Rules:
      // BUY: Price > EMA9, EMA9 > EMA21, EMA21 > EMA50 (or Price > EMA50), RSI 46-70, ADX >= 18, MACD hist >= -0.0002
      const scalpBuy = (currPrice >= ema9 * 0.999) && (ema9 > ema21) && (currPrice > ema50) && (rsi9 >= 46 && rsi9 <= 70) && (adx14 >= 18) && (macdHist >= -0.0003);
      // SELL: Price < EMA9, EMA9 < EMA21, EMA21 < EMA50 (or Price < EMA50), RSI 30-54, ADX >= 18, MACD hist <= 0.0003
      const scalpSell = (currPrice <= ema9 * 1.001) && (ema9 < ema21) && (currPrice < ema50) && (rsi9 >= 30 && rsi9 <= 54) && (adx14 >= 18) && (macdHist <= 0.0003);

      const status = scalpBuy ? '🟢 FAST BUY' : (scalpSell ? '🔴 FAST SELL' : '⚪ WAITING / NEUTRAL');

      const direction = scalpBuy ? 'BUY' : (scalpSell ? 'SELL' : null);
      const exit = direction ? calculateExitPips(clean, bars, atr14, direction) : null;
      const tpPips = exit ? Math.round(exit.tpPips) : 0;
      const slPips = exit ? Math.round(exit.slPips) : 0;

      console.log(`\n📌 [${clean.padEnd(7)}] ราคา: ${currPrice} | สถานะ Scalper: ${status}`);
      console.log(`   EMA9: ${ema9.toFixed(5)} | EMA21: ${ema21.toFixed(5)} | EMA50: ${ema50.toFixed(5)}`);
      console.log(`   RSI9: ${rsi9?.toFixed(1)} | ADX14: ${adx14?.toFixed(1)} | MACD Hist: ${macdHist.toFixed(5)}`);
      if (exit) {
        console.log(`   Exit mode: ${exit.mode} | TP +${tpPips} pips | SL -${slPips} pips | R:R = 1:${exit.rr.toFixed(2)} | ${exit.tradable ? 'PASS' : `SKIP: ${exit.reason}`}`);
      } else {
        console.log('   Exit mode: WAITING (ยังไม่มีทิศทาง BUY/SELL ที่ผ่าน fast diagnostic)');
      }
    } catch (err) {
      console.error(`Error on ${clean}:`, err.message);
    }
  }
}

runOptimizerTest();
