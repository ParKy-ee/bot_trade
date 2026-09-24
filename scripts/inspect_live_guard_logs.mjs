import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();

  console.log("=".repeat(85));
  console.log("📊 REAL-TIME GUARD PERFORMANCE & FILTERING AUDIT (Today 2026-09-23)");
  console.log("=".repeat(85));

  // 1. Audit forex_ml_observations for today
  const [obsCounts] = await pool.query(`
    SELECT sample_kind, COUNT(*) as cnt
    FROM forex_ml_observations
    WHERE DATE(created_at) = CURRENT_DATE()
    GROUP BY sample_kind
  `);
  
  const obsDict = {};
  for (const r of obsCounts) {
    obsDict[r.sample_kind] = Number(r.cnt);
  }
  
  const signalsCnt = obsDict['SIGNAL'] || 0;
  const rejectedCnt = obsDict['REJECTED'] || 0;
  const noTradeCnt = obsDict['NO_TRADE'] || 0;
  const rangeExcluded = obsDict['RANGE_EXCLUDED'] || 0;
  const totalObs = signalsCnt + rejectedCnt + noTradeCnt + rangeExcluded;
  const candidates = signalsCnt + rejectedCnt;
  const rejectionPct = candidates > 0 ? (rejectedCnt / candidates) * 100.0 : 0.0;

  console.log(`\n1. Forex ML Observation Pipeline (Today's Candidates & Gating):`);
  console.log(`   - Total M5 Bar Observations Evaluated: ${totalObs.toLocaleString()} bars`);
  console.log(`   - Technical Pattern Candidates:        ${candidates.toLocaleString()} potential setups`);
  console.log(`   - Orders Passed & Triggered:           ${signalsCnt.toLocaleString()} (${(100 - rejectionPct).toFixed(1)}%)`);
  console.log(`   - Orders Vetoed / Cut by Guards:       ${rejectedCnt.toLocaleString()} (${rejectionPct.toFixed(1)}%) 🛡️`);
  console.log(`   - No Setup Formed (Baseline filter):   ${noTradeCnt.toLocaleString()}`);

  // 2. Rejection Reasons Breakdown
  const [topReasons] = await pool.query(`
    SELECT filter_reasons, COUNT(*) as cnt
    FROM forex_ml_observations
    WHERE DATE(created_at) = CURRENT_DATE() AND sample_kind = 'REJECTED'
    GROUP BY filter_reasons
    ORDER BY cnt DESC
    LIMIT 10
  `);
  
  console.log(`\n2. Top Rejection Reasons by Guards (Why Orders Were Cut):`);
  for (const r of topReasons) {
    const reasonText = (r.filter_reasons || '').substring(0, 110);
    console.log(`   [${String(r.cnt).padStart(4, ' ')} times] ${reasonText}`);
  }

  // 3. Trade results distribution today
  const [tradeResultsToday] = await pool.query(`
    SELECT market_type, 
           COUNT(*) as total,
           SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN is_win = 0 AND exit_reason NOT IN ('OPEN', 'SYNC_PENDING') THEN 1 ELSE 0 END) as losses,
           SUM(CASE WHEN exit_reason = 'OPEN' THEN 1 ELSE 0 END) as open_pos,
           ROUND(SUM(profit_loss), 2) as net_pnl
    FROM trade_results
    WHERE DATE(created_at) = CURRENT_DATE()
    GROUP BY market_type
  `);

  console.log(`\n3. Actual Execution & Performance Today (by Market):`);
  for (const t of tradeResultsToday) {
    const closed = Number(t.wins) + Number(t.losses);
    const wr = closed > 0 ? ((Number(t.wins) / closed) * 100).toFixed(1) + '%' : 'N/A';
    console.log(`   - ${t.market_type.toUpperCase().padEnd(14, ' ')}: Total ${t.total} trades | Wins: ${t.wins} | Losses: ${t.losses} | Win Rate: ${wr} | Open: ${t.open_pos} | Net PnL: $${t.net_pnl || '0.00'}`);
  }

  // 4. Recent Signals & Action taken
  const [recentSignals] = await pool.query(`
    SELECT time, symbol, action, ai_confidence, market_type, created_at
    FROM signals
    ORDER BY id DESC
    LIMIT 8
  `);

  console.log(`\n4. Latest Signals Accepted & Executed by Bot:`);
  for (const s of recentSignals) {
    const conf = (Number(s.ai_confidence) * 100).toFixed(1);
    console.log(`   - [${s.market_type.toUpperCase()}] ${s.symbol.padEnd(8, ' ')} ${s.action.padEnd(4, ' ')} @ ${s.time} | Conf: ${conf}%`);
  }

  // 5. Open Positions in MT5 / DB
  const [activePos] = await pool.query(`
    SELECT symbol, market_type, entry_price, highest_price, sl_price, tp_price, status_note, mt5_ticket
    FROM active_positions
    WHERE status_note NOT LIKE 'CLOSED%'
  `);

  console.log(`\n5. Currently Active Open Positions in Port 3000 / MT5 (${activePos.length} positions):`);
  for (const p of activePos) {
    console.log(`   - [${p.market_type.toUpperCase()}] Ticket #${p.mt5_ticket || 'VIRTUAL'} ${p.symbol.padEnd(8, ' ')} | Entry: ${p.entry_price} | SL: ${p.sl_price} | TP: ${p.tp_price} | Note: ${p.status_note}`);
  }

  console.log("=".repeat(85));
  process.exit(0);
}

main().catch(err => {
  console.error("Error running audit:", err);
  process.exit(1);
});
