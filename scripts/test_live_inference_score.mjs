import { FOREX_UNIVERSE } from '../services/marketData.js';
import { predictForexChallengerConfidence, predictForexConfidence, predictForexMarketPressure } from '../services/modelPredictor.js';
import { buildForexFeatures } from '../services/forexMlObservationTracker.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  console.log('📡 กำลังดึงแท่งเทียน M5 ล่าสุดจากฐานข้อมูล เพื่อทดสอบ Predict คะแนน ML Real-time...');
  
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  const results = [];

  for (const sym of FOREX_UNIVERSE) {
    if (sym === 'DX-Y.NYB') continue;
    const clean = sym.replace('=X', '');

    try {
      const [rows] = await conn.query(
        'SELECT time, open, high, low, close, volume FROM market_bars WHERE symbol = ? ORDER BY time DESC LIMIT 60',
        [sym]
      );

      if (!rows || rows.length < 35) {
        continue;
      }

      // Convert rows so they are in chronological order and numerical format
      const bars = rows.reverse().map(r => ({
        time: r.time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume || 1)
      }));

      const lastBar = bars[bars.length - 1];
      const features = buildForexFeatures({ bars, symbol: sym });
      const challengerBuy = await predictForexChallengerConfidence({ ...features, direction: 'BUY' });
      const challengerSell = await predictForexChallengerConfidence({ ...features, direction: 'SELL' });
      const champion = await predictForexConfidence(features);
      const pressure = await predictForexMarketPressure(bars, sym);

      results.push({
        Pair: clean,
        Price: Number(lastBar.close).toFixed(clean.includes('JPY') ? 3 : 5),
        'Challenger Buy': challengerBuy?.raw_buy ? Number(challengerBuy.raw_buy).toFixed(4) : '-',
        'Challenger Sell': challengerSell?.raw_sell ? Number(challengerSell.raw_sell).toFixed(4) : '-',
        'Champion Conf%': champion?.confidence ? `${(champion.confidence * 100).toFixed(1)}%` : '-',
        'Pressure State': pressure?.state || '-',
        'Buy Press%': pressure?.probabilities ? `${(pressure.probabilities.buy_pressure * 100).toFixed(0)}%` : '-',
        'Sell Press%': pressure?.probabilities ? `${(pressure.probabilities.sell_pressure * 100).toFixed(0)}%` : '-',
        'Exp Pips': pressure?.pip_projections ? `${pressure.pip_projections.expected_net_pips > 0 ? '+' : ''}${pressure.pip_projections.expected_net_pips}p` : '-'
      });
    } catch (e) {
      console.warn(`Error on ${sym}:`, e.message);
    }
  }

  await conn.end();

  console.log('\n🧭 ผลคะแนน Real-time Inference จากแท่งเทียนล่าสุด:');
  console.table(results);
  process.exit(0);
}

main().catch(console.error);
