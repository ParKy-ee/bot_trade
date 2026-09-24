import { getPool, initDatabase } from '../config/database.js';

// Helper to run python script for deals
async function fetchMt5Deals() {
  const { spawn } = await import('child_process');
  const path = await import('path');
  const ROOT_DIR = path.resolve();
  const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

  const pyCode = `
import MetaTrader5 as mt5
import json
from datetime import datetime, timedelta

if not mt5.initialize():
    print(json.dumps([]))
    exit()

deals = mt5.history_deals_get(datetime.now() - timedelta(days=7), datetime.now() + timedelta(days=1))
res = []
if deals:
    for d in deals:
        if d.symbol:
            res.append({
                "ticket": d.ticket,
                "position": d.position_id,
                "symbol": d.symbol,
                "entry": d.entry,
                "type": "BUY" if d.type == 0 else "SELL",
                "price": float(d.price),
                "volume": float(d.volume),
                "profit": float(d.profit),
                "comment": str(d.comment),
                "time": datetime.fromtimestamp(d.time).strftime("%Y-%m-%d %H:%M:%S")
            })
mt5.shutdown()
print(json.dumps(res))
`;

  return new Promise((resolve) => {
    const child = spawn(PYTHON_PATH, ['-c', pyCode], { cwd: ROOT_DIR });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve([]);
      }
    });
  });
}

async function syncAllToDb() {
  console.log('='.repeat(70));
  console.log('📥 กำลังซิงค์ข้อมูลผลลัพธ์การเทรด (Trade Results) ทั้งหมดลง Database MySQL...');
  console.log('='.repeat(70));

  await initDatabase();
  const pool = await getPool();

  const deals = await fetchMt5Deals();
  console.log(`[*] ดึงข้อมูล Deal History จาก MT5 ได้ทั้งหมด ${deals.length} รายการ`);

  // Group deals by position
  const positionsMap = new Map();
  for (const d of deals) {
    if (!positionsMap.has(d.position)) {
      positionsMap.set(d.position, { entryDeal: null, exitDeal: null });
    }
    const p = positionsMap.get(d.position);
    if (d.entry === 0) p.entryDeal = d;
    else if (d.entry === 1) p.exitDeal = d;
  }

  // Fetch signals from DB to link initial features & confidence
  const [signals] = await pool.query('SELECT * FROM signals WHERE mt5_ticket IS NOT NULL');
  const signalMap = new Map();
  for (const s of signals) {
    signalMap.set(Number(s.mt5_ticket), s);
  }

  // Clear or upsert into trade_results
  let inserted = 0;
  let updated = 0;

  for (const [posId, { entryDeal, exitDeal }] of positionsMap.entries()) {
    if (!entryDeal) continue;

    const sig = signalMap.get(posId);
    const symbol = entryDeal.symbol;
    const isJpy = symbol.includes('JPY');
    const pipSize = isJpy ? 0.01 : 0.0001;

    const action = entryDeal.comment?.includes('BUY') ? 'BUY' : (entryDeal.comment?.includes('SELL') ? 'SELL' : entryDeal.type);
    const entryPrice = entryDeal.price;
    const entryTime = entryDeal.time;
    const lotSize = entryDeal.volume;
    const confidence = sig ? Number(sig.ai_confidence) : 0.70;
    const slPrice = sig ? Number(sig.sl_price) : 0;
    const tpPrice = sig ? Number(sig.tp_price) : 0;

    let exitTime = null;
    let exitPrice = null;
    let exitReason = 'OPEN';
    let pips = null;
    let profitLoss = null;
    let isWin = null;
    let returnPct = null;
    let durationMin = null;

    if (exitDeal) {
      exitTime = exitDeal.time;
      exitPrice = exitDeal.price;
      profitLoss = exitDeal.profit;

      const comm = exitDeal.comment.toLowerCase();
      if (comm.includes('[sl')) exitReason = 'CLOSED_SL';
      else if (comm.includes('[tp')) exitReason = 'CLOSED_TP';
      else if (comm.includes('close position')) exitReason = 'CLOSED_MANUAL';
      else exitReason = 'CLOSED_MT5';

      if (action === 'BUY') {
        pips = Number(((exitPrice - entryPrice) / pipSize).toFixed(2));
      } else {
        pips = Number(((entryPrice - exitPrice) / pipSize).toFixed(2));
      }

      isWin = profitLoss > 0 ? 1 : 0;
      returnPct = Number(((pips * pipSize / entryPrice) * 100).toFixed(4));
      const tDiff = new Date(exitTime) - new Date(entryTime);
      durationMin = Math.max(1, Math.round(tDiff / (1000 * 60)));
    }

    // Check if record exists in trade_results
    const [exist] = await pool.query('SELECT id FROM trade_results WHERE mt5_ticket = ?', [posId]);
    if (exist.length > 0) {
      await pool.query(
        `UPDATE trade_results 
         SET exit_time = ?, exit_price = ?, exit_reason = ?, pips = ?, profit_loss = ?, is_win = ?, return_pct = ?, hold_duration_minutes = ?
         WHERE mt5_ticket = ?`,
        [exitTime, exitPrice, exitReason, pips, profitLoss, isWin, returnPct, durationMin, posId]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO trade_results (
          mt5_ticket, symbol, market_type, action, lot_size,
          entry_time, entry_price, ai_confidence, sl_price, tp_price,
          exit_time, exit_price, exit_reason, pips, profit_loss, is_win, return_pct, hold_duration_minutes
        ) VALUES (?, ?, 'forex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          posId, symbol, action, lotSize,
          entryTime, entryPrice, confidence, slPrice, tpPrice,
          exitTime, exitPrice, exitReason, pips, profitLoss, isWin, returnPct, durationMin
        ]
      );
      inserted++;
    }

    const tag = exitReason === 'OPEN' ? '🟢 OPEN' : (isWin === 1 ? '🏆 WIN' : '🛑 LOSS');
    console.log(`[+] Ticket #${posId} ${symbol} (${action}) -> สถานะ: ${tag} | กำไร: ${profitLoss !== null ? '$' + profitLoss : 'กำลังเทรด'}`);
  }

  console.log(`\n✅ บันทึกลงตาราง trade_results ใน MySQL เสร็จสิ้น! (เพิ่มใหม่: ${inserted}, อัปเดต: ${updated})`);
  process.exit(0);
}

syncAllToDb();
