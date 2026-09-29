const mysql = require('mysql2/promise');

(async () => {
  const pool = mysql.createPool({ host: '127.0.0.1', user: 'root', password: '', database: 'ai_trading_db' });

  console.log("=== 1. MARKET PRESSURE LIVE AUDIT (24-28 Sep) ===");
  const [pecTrades] = await pool.query(`
    SELECT id, mt5_ticket, symbol, action, entry_price, exit_price, sl_price, pips, profit_loss, exit_reason, hold_duration_minutes
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) >= '2026-09-24'
      AND exit_reason = 'CLOSED_PRESSURE_EARLY_CUT'
    ORDER BY id ASC
  `);

  console.log(`Total CLOSED_PRESSURE_EARLY_CUT Trades: ${pecTrades.length}`);
  let totalLossUsd = pecTrades.reduce((a, b) => a + Number(b.profit_loss || 0), 0);
  let totalLossPips = pecTrades.reduce((a, b) => a + Number(b.pips || 0), 0);
  console.log(`Realized Loss at Early Cut: ${totalLossPips.toFixed(1)} pips | $${totalLossUsd.toFixed(2)} USD`);

  // Calculate what would have happened if they hit full SL
  let potentialSlPips = 0;
  let potentialSlUsd = 0;
  pecTrades.forEach(t => {
    const isJpy = t.symbol.includes('JPY');
    const pipSize = isJpy ? 0.01 : 0.0001;
    const entry = Number(t.entry_price);
    const sl = Number(t.sl_price);
    const slDist = sl ? Math.abs(entry - sl) / pipSize : 9.0;
    potentialSlPips -= slDist;
    const pipVal = isJpy ? 0.065 : 0.10;
    potentialSlUsd -= slDist * pipVal;
  });

  const pipsSaved = Math.abs(potentialSlPips) - Math.abs(totalLossPips);
  const usdSaved = Math.abs(potentialSlUsd) - Math.abs(totalLossUsd);
  console.log(`If let run to full SL: ${potentialSlPips.toFixed(1)} pips | $${potentialSlUsd.toFixed(2)} USD`);
  console.log(`>>> NET SAVED BY MARKET PRESSURE: +${pipsSaved.toFixed(1)} pips | +$${usdSaved.toFixed(2)} USD! <<<`);

  console.log("\n=== 2. ANALYZE TRADES THAT HIT FULL SL (WHY DIDN'T PRESSURE CUT THEM?) ===");
  const [slTrades] = await pool.query(`
    SELECT id, symbol, action, pips, profit_loss, hold_duration_minutes, prediction_meta
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) = CURDATE()
      AND exit_reason = 'CLOSED_SL'
    ORDER BY id DESC
    LIMIT 6
  `);

  slTrades.forEach(t => {
    let mpState = 'unknown';
    try {
      const meta = JSON.parse(t.prediction_meta || '{}');
      mpState = meta.market_pressure?.state || 'none';
    } catch {}
    console.log(`SL Trade #${t.id} (${t.symbol} ${t.action}): Hold ${t.hold_duration_minutes}m, Pips ${t.pips}, Initial MP State: ${mpState}`);
  });

  await pool.end();
})();
