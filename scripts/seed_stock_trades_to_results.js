import { getPool } from '../config/database.js';

async function seedStockTradesToResults() {
  console.log('🔄 เริ่มต้นซิงค์ประวัติการเทรดหุ้นสหรัฐจาก active_positions เข้าสู่ตาราง trade_results...');
  const pool = await getPool();

  const [positions] = await pool.query(
    "SELECT * FROM active_positions WHERE market_type = 'stock'"
  );

  console.log(`[*] ตรวจพบตำแหน่งหุ้นทั้งหมด ${positions.length} รายการ`);

  let inserted = 0;
  let updated = 0;

  for (const pos of positions) {
    const symbol = pos.symbol;
    const entryPrice = Number(pos.entry_price);
    const slPrice = Number(pos.sl_price);
    const tpPrice = Number(pos.tp_price);
    const status = String(pos.status_note || 'SIGNAL_OPEN');
    const entryTime = pos.entry_date ? new Date(pos.entry_date).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');

    const [exist] = await pool.query(
      "SELECT id FROM trade_results WHERE symbol = ? AND market_type = 'stock'",
      [symbol]
    );

    let exitReason = 'OPEN';
    let exitPrice = null;
    let exitTime = null;
    let pips = null;
    let returnPct = null;
    let pnl = null;
    let isWin = null;

    if (status.includes('CLOSED_TP')) {
      exitReason = 'CLOSED_TP';
      exitPrice = tpPrice;
      exitTime = entryTime;
      const pointDiff = exitPrice - entryPrice;
      pips = Number(pointDiff.toFixed(2));
      returnPct = Number(((pointDiff / entryPrice) * 100).toFixed(2));
      pnl = pips;
      isWin = 1;
    } else if (status.includes('CLOSED_SL')) {
      exitReason = 'CLOSED_SL';
      exitPrice = slPrice;
      exitTime = entryTime;
      const pointDiff = exitPrice - entryPrice;
      pips = Number(pointDiff.toFixed(2));
      returnPct = Number(((pointDiff / entryPrice) * 100).toFixed(2));
      pnl = pips;
      isWin = 0;
    }

    if (exist.length === 0) {
      await pool.query(
        "INSERT INTO trade_results (symbol, market_type, action, lot_size, entry_time, entry_price, sl_price, tp_price, exit_reason, exit_price, exit_time, pips, profit_loss, return_pct, is_win, ai_confidence) VALUES (?, 'stock', 'BUY', 1.0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.45)",
        [symbol, entryTime, entryPrice, slPrice, tpPrice, exitReason, exitPrice, exitTime, pips, pnl, returnPct, isWin]
      );
      inserted++;
      console.log(`  [+] เพิ่มประวัติหุ้น ${symbol} (${exitReason}) -> ID ใหม่`);
    } else {
      await pool.query(
        "UPDATE trade_results SET exit_reason = ?, exit_price = ?, exit_time = ?, pips = ?, profit_loss = ?, return_pct = ?, is_win = ? WHERE id = ?",
        [exitReason, exitPrice, exitTime, pips, pnl, returnPct, isWin, exist[0].id]
      );
      updated++;
      console.log(`  [*] อัปเดตประวัติหุ้น ${symbol} (${exitReason}) -> ID #${exist[0].id}`);
    }
  }

  console.log(`\n✅ ซิงค์ประวัติหุ้นเสร็จสิ้น (เพิ่มใหม่: ${inserted}, อัปเดต: ${updated})`);
  process.exit(0);
}

seedStockTradesToResults().catch(err => {
  console.error('❌ Error seeding stock trades:', err);
  process.exit(1);
});
