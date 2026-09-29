const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trade_bot'
  });

  const [dateSummary] = await pool.query(`
    SELECT 
      DATE(created_at) as trade_date,
      COUNT(*) as total_orders,
      SUM(CASE WHEN (profit_loss > 0 OR is_win = 1) AND exit_reason != 'OPEN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN profit_loss <= 0 AND is_win = 0 AND exit_reason != 'OPEN' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN exit_reason = 'OPEN' THEN 1 ELSE 0 END) as open_orders,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN pips ELSE 0 END), 1) as net_pips,
      ROUND(SUM(CASE WHEN exit_reason != 'OPEN' THEN profit_loss ELSE 0 END), 2) as net_usd
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) >= '2026-09-24'
    GROUP BY DATE(created_at)
    ORDER BY trade_date ASC
  `);

  console.log("=== LIVE TRADES DAILY SUMMARY (24 Sep - Today) ===");
  console.table(dateSummary);

  const [allLosses] = await pool.query(`
    SELECT *
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) >= '2026-09-24'
      AND exit_reason != 'OPEN'
      AND profit_loss <= 0
      AND is_win = 0
    ORDER BY id ASC
  `);

  console.log(`\nTotal Live Closed Losses (24 Sep - Today): ${allLosses.length} orders`);

  // Analyze causes of loss
  let categories = {
    sl_full: { label: 'โดนลากชน Stop Loss (CLOSED_SL)', count: 0, pips: 0, usd: 0, orders: [] },
    pressure_cut: { label: 'ตัดขาดทุนไวด้วย Market Pressure (CLOSED_PRESSURE_EARLY_CUT)', count: 0, pips: 0, usd: 0, orders: [] },
    spread_trap: { label: 'กับดักสเปรด (Pips บวกหรือ 0 แต่เงินติดลบ)', count: 0, pips: 0, usd: 0, orders: [] },
    time_stop_neg: { label: 'หมดเวลา Time-Stop ขณะราคาติดลบจริง', count: 0, pips: 0, usd: 0, orders: [] },
    stall_pullback: { label: 'Stall Pullback ปิดเท่าทุน/ติดลบเล็กน้อย', count: 0, pips: 0, usd: 0, orders: [] },
    manual_or_other: { label: 'เหตุผลอื่นๆ / Manual', count: 0, pips: 0, usd: 0, orders: [] }
  };

  allLosses.forEach(r => {
    const pips = Number(r.pips || 0);
    const usd = Number(r.profit_loss || 0);
    const reason = r.exit_reason;

    if (pips > 0 && usd < 0) {
      categories.spread_trap.count++;
      categories.spread_trap.pips += pips;
      categories.spread_trap.usd += usd;
      categories.spread_trap.orders.push(r);
    } else if (reason === 'CLOSED_SL') {
      categories.sl_full.count++;
      categories.sl_full.pips += pips;
      categories.sl_full.usd += usd;
      categories.sl_full.orders.push(r);
    } else if (reason === 'CLOSED_PRESSURE_EARLY_CUT') {
      categories.pressure_cut.count++;
      categories.pressure_cut.pips += pips;
      categories.pressure_cut.usd += usd;
      categories.pressure_cut.orders.push(r);
    } else if (reason === 'CLOSED_TIME_STOP') {
      categories.time_stop_neg.count++;
      categories.time_stop_neg.pips += pips;
      categories.time_stop_neg.usd += usd;
      categories.time_stop_neg.orders.push(r);
    } else if (reason === 'CLOSED_STALL_HARVEST') {
      categories.stall_pullback.count++;
      categories.stall_pullback.pips += pips;
      categories.stall_pullback.usd += usd;
      categories.stall_pullback.orders.push(r);
    } else {
      categories.manual_or_other.count++;
      categories.manual_or_other.pips += pips;
      categories.manual_or_other.usd += usd;
      categories.manual_or_other.orders.push(r);
    }
  });

  const totalLossCount = allLosses.length;
  const totalLossUsd = allLosses.reduce((acc, r) => acc + Number(r.profit_loss || 0), 0);
  const totalLossPips = allLosses.reduce((acc, r) => acc + Number(r.pips || 0), 0);

  const breakdownTable = Object.keys(categories).map(k => {
    const c = categories[k];
    return {
      สาเหตุ: c.label,
      จำนวนไม้: c.count,
      'สัดส่วนไม้ (%)': ((c.count / totalLossCount) * 100).toFixed(1) + '%',
      'Pips รวม': c.pips.toFixed(1),
      'ยอดเงินขาดทุน (USD)': '$' + c.usd.toFixed(2),
      'สัดส่วนเงินที่เสีย (%)': ((c.usd / totalLossUsd) * 100).toFixed(1) + '%'
    };
  });

  console.log("\n=== SUMMARY OF LOST ORDERS CAUSES (24 Sep - Today) ===");
  console.table(breakdownTable);

  console.log("\nTotal Loss Count:", totalLossCount);
  console.log("Total Loss Pips:", totalLossPips.toFixed(1));
  console.log("Total Loss USD: $" + totalLossUsd.toFixed(2));

  // Also breakdown by symbol and by session/market condition
  const [lossBySymbol] = await pool.query(`
    SELECT 
      symbol,
      COUNT(*) as loss_count,
      ROUND((COUNT(*) / ${totalLossCount}) * 100, 1) as pct_of_losses,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(SUM(profit_loss), 2) as total_loss_usd
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) >= '2026-09-24'
      AND exit_reason != 'OPEN'
      AND profit_loss <= 0
      AND is_win = 0
    GROUP BY symbol
    ORDER BY total_loss_usd ASC
  `);

  console.log("\n=== LOSSES BY CURRENCY PAIR (24 Sep - Today) ===");
  console.table(lossBySymbol);

  // Breakdown by Model Version
  const [lossByModel] = await pool.query(`
    SELECT 
      COALESCE(model_version, 'unknown') as model,
      COUNT(*) as loss_count,
      ROUND((COUNT(*) / ${totalLossCount}) * 100, 1) as pct_of_losses,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(SUM(profit_loss), 2) as total_loss_usd
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND DATE(created_at) >= '2026-09-24'
      AND exit_reason != 'OPEN'
      AND profit_loss <= 0
      AND is_win = 0
    GROUP BY model_version
    ORDER BY total_loss_usd ASC
  `);

  console.log("\n=== LOSSES BY MODEL VERSION (24 Sep - Today) ===");
  console.table(lossByModel);

  // Breakdown Forex-Only
  const [forexLosses] = await pool.query(`
    SELECT 
      CASE 
        WHEN pips > 0 AND profit_loss < 0 THEN 'กับดักสเปรด (Pips > 0 แต่เงินลบ)'
        WHEN exit_reason = 'CLOSED_SL' THEN 'โดนลากชน Stop Loss (CLOSED_SL)'
        WHEN exit_reason = 'CLOSED_PRESSURE_EARLY_CUT' THEN 'ตัดขาดทุนไวด้วย Market Pressure'
        WHEN exit_reason = 'CLOSED_TIME_STOP' THEN 'หมดเวลา Time-Stop ขณะติดลบจริง'
        ELSE 'อื่นๆ / Manual'
      END as cause,
      COUNT(*) as count,
      ROUND(SUM(pips), 1) as total_pips,
      ROUND(SUM(profit_loss), 2) as total_loss_usd
    FROM trade_results
    WHERE decision_mode = 'LIVE'
      AND market_type = 'forex'
      AND DATE(created_at) >= '2026-09-24'
      AND exit_reason != 'OPEN'
      AND profit_loss <= 0
      AND is_win = 0
    GROUP BY cause
    ORDER BY total_loss_usd ASC
  `);

  console.log("\n=== FOREX ONLY LIVE LOSSES (24 Sep - Today) ===");
  console.table(forexLosses);

  await pool.end();
})();
