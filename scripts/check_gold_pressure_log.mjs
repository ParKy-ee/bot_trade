import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getRates } from '../services/mt5Broker.js';
import { predictForexMarketPressure } from '../services/modelPredictor.js';

dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  // 1. Observations from DB
  const [rows] = await conn.query(`
    SELECT 
      id, symbol, 
      DATE_FORMAT(bar_time, '%H:%i:%s') as bar_time,
      DATE_FORMAT(observed_at, '%H:%i:%s') as observed_at,
      close_price, atr, predicted_state,
      ROUND(prob_buy * 100, 1) as buy_pct,
      ROUND(prob_sell * 100, 1) as sell_pct,
      ROUND(prob_indecision * 100, 1) as chop_pct,
      expected_net_pips, bop, body_ratio, wick_asym, rel_range, ker_5, dir_disp_3, vol_skew,
      outcome_status, actual_state, is_correct
    FROM market_pressure_observations
    WHERE symbol = 'GOLD'
    ORDER BY id DESC
    LIMIT 10
  `);

  console.log("=== 1. RECENT LOGGED GOLD OBSERVATIONS IN DATABASE ===");
  console.table(rows);

  // 2. Fetch fresh live bars right now from MT5
  console.log("\n=== 2. REAL-TIME GOLD MARKET PRESSURE RIGHT NOW ===");
  try {
    const res = await getRates('GOLD', 'M5', 40);
    if (res && res.bars && res.bars.length > 0) {
      const livePressure = await predictForexMarketPressure(res.bars, 'GOLD');
      const lastBar = res.bars[res.bars.length - 1];
      console.log(`Current Gold Price: $${Number(lastBar.close).toFixed(2)} at ${lastBar.time}`);
      console.log(`Predicted State:   ${livePressure.state}`);
      console.log(`Probabilities:     BUY: ${(livePressure.probabilities.buy_pressure * 100).toFixed(1)}% | SELL: ${(livePressure.probabilities.sell_pressure * 100).toFixed(1)}% | INDECISION (CHOP): ${(livePressure.probabilities.indecision * 100).toFixed(1)}%`);
      console.log("\nDetailed Microstructure Metrics:");
      console.log(`  • Balance of Power (BOP):      ${livePressure.metrics.bop} (ช่วง -1 ถึง +1, บวก=แรงซื้อคุม, ลบ=แรงขายคุม)`);
      console.log(`  • Body Ratio:                  ${(livePressure.metrics.body_ratio * 100).toFixed(1)}% ของความยาวแท่ง`);
      console.log(`  • Wick Asymmetry:              ${livePressure.metrics.wick_asymmetry} (บวก=ไส้ล่างยาวกว่ามีแรงดัน, ลบ=ไส้บนยาวกว่ามีแรงกด)`);
      console.log(`  • Relative Range (vs ATR):     ${livePressure.metrics.rel_range}x ATR`);
      console.log(`  • Kaufman Efficiency (KER 5):  ${livePressure.metrics.ker_5} (0=วิ่งวกวน/Chop, 1=วิ่งเป็นเทรนด์เส้นตรง)`);
      console.log(`  • Directional Disp (3 bars):   ${livePressure.metrics.dir_disp_3}x ATR (การกระจัดทิศทางใน 3 แท่ง)`);
      console.log(`  • Volume Skew Proxy:           ${livePressure.metrics.vol_skew}`);
      console.log(`  • Current ATR(14):             $${Number(livePressure.metrics.atr).toFixed(2)}`);
    } else {
      console.log("Could not fetch live rates from MT5");
    }
  } catch (err) {
    console.error("Live test error:", err.message);
  }

  // 3. Check active position of GOLD
  const [activePos] = await conn.query(`
    SELECT id, mt5_ticket, symbol, action, entry_price, sl_price, tp_price, profit_loss, exit_reason, DATE_FORMAT(entry_time, '%H:%i:%s') as entry_bkk
    FROM trade_results
    WHERE (market_type = 'gold' OR symbol = 'GOLD') AND exit_reason = 'OPEN'
    ORDER BY id DESC LIMIT 5
  `);
  console.log("\n=== 3. CURRENT ACTIVE OPEN GOLD POSITIONS ===");
  console.table(activePos);

  await conn.end();
  process.exit(0);
}

run().catch(console.error);
