import { getPool } from '../config/database.js';

async function checkPostGuard() {
  const pool = await getPool();
  const startTime = '2026-09-23 09:55:00';
  
  console.log(`=== CHECKING STRICTLY POST-GUARD WINDOW (${startTime} - Present) ===\n`);

  // 1. Forex observations post 09:55
  const [forexObs] = await pool.query(`
    SELECT sample_kind, COUNT(*) as cnt 
    FROM forex_ml_observations 
    WHERE created_at >= ?
    GROUP BY sample_kind
  `, [startTime]);
  console.log('1. Forex Observations (post-09:55):', forexObs);

  // 2. Signals generated post 09:55 across all markets
  const [signals] = await pool.query(`
    SELECT id, symbol, action, ai_confidence, market_type, created_at 
    FROM signals 
    WHERE created_at >= ?
    ORDER BY id DESC
  `, [startTime]);
  console.log(`\n2. Signals Generated (post-09:55) [Total: ${signals.length}]:`, signals);

  // 3. Trade results executed post 09:55
  const [trades] = await pool.query(`
    SELECT id, symbol, action, market_type, entry_price, exit_reason, created_at 
    FROM trade_results 
    WHERE created_at >= ?
    ORDER BY id DESC
  `, [startTime]);
  console.log(`\n3. Trades Executed (post-09:55) [Total: ${trades.length}]:`, trades);

  // 4. Check market_bars updated post 09:55 to confirm bot is scanning
  const [bars] = await pool.query(`
    SELECT market_type, COUNT(DISTINCT symbol) as active_symbols, MAX(last_scanned_at) as last_scan, COUNT(*) as row_count
    FROM market_bars
    WHERE last_scanned_at >= ?
    GROUP BY market_type
  `, [startTime]);
  console.log('\n4. Market Bars Scanned (post-09:55):', bars);

  // 5. Categorize Rejections
  const [rejections] = await pool.query(`
    SELECT filter_reasons, COUNT(*) as cnt
    FROM forex_ml_observations
    WHERE created_at >= ? AND sample_kind = 'REJECTED'
    GROUP BY filter_reasons
    ORDER BY cnt DESC
  `, [startTime]);
  
  const totalRejections = rejections.reduce((a,b)=>a+b.cnt, 0);
  console.log(`\n5. Forex Rejection Details (post-09:55) [Total rejections: ${totalRejections}]:`);
  
  const categoryCounts = {
    spread_barrier: 0,
    adx_sideway: 0,
    csm_no_spread: 0,
    rr_too_low: 0,
    wick_rejection: 0,
    raw_conviction: 0,
    other: 0
  };

  for (const r of rejections) {
    const text = r.filter_reasons || '';
    if (text.includes('พื้นที่ถึงเป้าหมายไม่พอ')) categoryCounts.spread_barrier += r.cnt;
    if (text.includes('ADX') && text.includes('Sideway')) categoryCounts.adx_sideway += r.cnt;
    if (text.includes('CSM Spread')) categoryCounts.csm_no_spread += r.cnt;
    if (text.includes('R:R ต่ำเกณฑ์')) categoryCounts.rr_too_low += r.cnt;
    if (text.includes('Rejection Veto') || text.includes('ไส้')) categoryCounts.wick_rejection += r.cnt;
    if (text.includes('ความมั่นใจ') || text.includes('คะแนน')) categoryCounts.raw_conviction += r.cnt;
  }
  console.log('Category Counts:', categoryCounts);

  // 6. Check Active Positions to see if Max Open Positions Guard is blocking new orders
  const [openPos] = await pool.query(`
    SELECT *
    FROM active_positions
    WHERE status_note NOT LIKE 'CLOSED%'
  `);
  console.log(`\n6. Active Open Positions Currently [Total: ${openPos.length}]:`);
  for (const p of openPos) {
    console.log(`   - [${p.market_type}] ${p.symbol} | Ticket: ${p.mt5_ticket} | Entry: ${p.entry_price} | Note: ${p.status_note}`);
  }

  process.exit(0);

  process.exit(0);
}

checkPostGuard().catch(err => {
  console.error(err);
  process.exit(1);
});
