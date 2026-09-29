const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trade_bot'
  });

  const [rows] = await pool.query(
    "SELECT id, mt5_ticket, symbol, action, entry_price, exit_price, pips, profit_loss, exit_reason, hold_duration_minutes, is_win, created_at, model_version FROM trade_results WHERE decision_mode = 'LIVE' AND DATE(created_at) = CURDATE() AND exit_reason != 'OPEN' ORDER BY id ASC"
  );

  const losses = rows.filter(r => Number(r.profit_loss) <= 0 && r.is_win === 0);
  console.log(`Total Losses Today: ${losses.length}`);

  let spreadTrapLosses = []; // pips > 0 but usd < 0
  let slLosses = []; // CLOSED_SL
  let pressureEarlyCutLosses = []; // CLOSED_PRESSURE_EARLY_CUT
  let timeStopNegativeLosses = []; // CLOSED_TIME_STOP with pips <= 0
  let otherLosses = [];

  losses.forEach(r => {
    const pips = Number(r.pips || 0);
    const usd = Number(r.profit_loss || 0);
    if (pips > 0 && usd < 0) {
      spreadTrapLosses.push(r);
    } else if (r.exit_reason === 'CLOSED_SL') {
      slLosses.push(r);
    } else if (r.exit_reason === 'CLOSED_PRESSURE_EARLY_CUT') {
      pressureEarlyCutLosses.push(r);
    } else if (r.exit_reason === 'CLOSED_TIME_STOP') {
      timeStopNegativeLosses.push(r);
    } else {
      otherLosses.push(r);
    }
  });

  console.log(`\n--- Breakdown of the ${losses.length} Losses ---`);
  console.log(`1. Spread Trap Losses (Pips > 0 แต่เงินติดลบ): ${spreadTrapLosses.length} ไม้ (${((spreadTrapLosses.length/losses.length)*100).toFixed(1)}%)`);
  spreadTrapLosses.forEach(r => console.log(`   #${r.id} (${r.symbol} ${r.action}): Pips ${r.pips}, USD $${r.profit_loss}, Exit: ${r.exit_reason}`));

  console.log(`\n2. Stop Loss Hits (โดนลากชน SL เต็มระยะ -7 ถึง -10 pips): ${slLosses.length} ไม้ (${((slLosses.length/losses.length)*100).toFixed(1)}%)`);
  const slTotalUsd = slLosses.reduce((acc, r) => acc + Number(r.profit_loss), 0);
  const slTotalPips = slLosses.reduce((acc, r) => acc + Number(r.pips), 0);
  console.log(`   รวม SL: ${slTotalPips.toFixed(1)} pips | $${slTotalUsd.toFixed(2)} USD`);

  console.log(`\n3. Market Pressure Early Cut (ตัดขาดทุนไว -3 ถึง -6 pips ก่อนชน SL): ${pressureEarlyCutLosses.length} ไม้ (${((pressureEarlyCutLosses.length/losses.length)*100).toFixed(1)}%)`);
  const pecTotalUsd = pressureEarlyCutLosses.reduce((acc, r) => acc + Number(r.profit_loss), 0);
  const pecTotalPips = pressureEarlyCutLosses.reduce((acc, r) => acc + Number(r.pips), 0);
  console.log(`   รวม Early Cut: ${pecTotalPips.toFixed(1)} pips | $${pecTotalUsd.toFixed(2)} USD`);

  console.log(`\n4. Time-Stop Negative (หมดเวลา 35m ขณะราคาติดลบจริง): ${timeStopNegativeLosses.length} ไม้ (${((timeStopNegativeLosses.length/losses.length)*100).toFixed(1)}%)`);
  timeStopNegativeLosses.forEach(r => console.log(`   #${r.id} (${r.symbol} ${r.action}): Pips ${r.pips}, USD $${r.profit_loss}, Exit: ${r.exit_reason}`));

  // Check how much spread affects the other losses
  console.log(`\n--- Summary of Loss Dollars ---`);
  console.log(`Spread Trap: $${spreadTrapLosses.reduce((a,b)=>a+Number(b.profit_loss),0).toFixed(2)}`);
  console.log(`Stop Loss: $${slTotalUsd.toFixed(2)}`);
  console.log(`Pressure Early Cut: $${pecTotalUsd.toFixed(2)}`);
  console.log(`Time Stop Negative: $${timeStopNegativeLosses.reduce((a,b)=>a+Number(b.profit_loss),0).toFixed(2)}`);

  console.log(`\n--- Losses by Symbol (MT5 Live Today) ---`);
  const [symRows] = await pool.query(
    "SELECT symbol, COUNT(*) as total, SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN profit_loss <= 0 THEN 1 ELSE 0 END) as losses, ROUND(SUM(pips), 1) as total_pips, ROUND(SUM(profit_loss), 2) as total_usd FROM trade_results WHERE decision_mode = 'LIVE' AND DATE(created_at) = CURDATE() AND exit_reason != 'OPEN' GROUP BY symbol ORDER BY total_usd ASC"
  );
  console.table(symRows);

  await pool.end();
})();
