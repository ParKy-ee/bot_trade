import { getPool } from '../config/database.js';
import { getOpenPositions } from '../services/mt5Broker.js';

async function main() {
  const pool = await getPool();

  // 1. Check open positions in MT5
  const mt5Pos = await getOpenPositions();
  console.log('=== CURRENT MT5 OPEN POSITIONS ===');
  console.log(JSON.stringify(mt5Pos, null, 2));

  // 1.5 Check latest 10 MT5 LIVE Trades
  const [liveRows] = await pool.query(`
    SELECT id, mt5_ticket, symbol, market_type, action, entry_time, exit_time, profit_loss, exit_reason, source_tag 
    FROM trade_results 
    WHERE mt5_ticket IS NOT NULL 
    ORDER BY entry_time DESC 
    LIMIT 10
  `);
  console.log('\n=== LATEST 10 MT5 LIVE TRADES ===');
  for (const r of liveRows) {
    const entryLoc = new Date(r.entry_time).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const exitLoc = r.exit_time ? new Date(r.exit_time).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-';
    console.log(`[${entryLoc} -> ${exitLoc}] ${r.symbol} (${r.market_type}) ${r.action} #${r.mt5_ticket} | PnL: $${r.profit_loss} | ${r.exit_reason}`);
  }
  // 2. Today trade_results stats
  const [stats] = await pool.query(`
    SELECT action, MAX(ai_confidence) as max_conf, AVG(ai_confidence) as avg_conf, count(*) as cnt 
    FROM trade_results 
    WHERE created_at >= '2026-09-28 00:00:00' 
    GROUP BY action
  `);
  console.log('\n=== TODAY TRADE STATS ===');
  console.log(stats);

  // 3. Inspect earlier live forex prediction_meta
  const [earlierLive] = await pool.query(`
    SELECT mt5_ticket, symbol, action, entry_time, ai_confidence, prediction_meta 
    FROM trade_results 
    WHERE mt5_ticket IS NOT NULL AND entry_time >= '2026-09-28 05:00:00' AND market_type = 'forex' 
    LIMIT 5
  `);
  console.log('\n=== EARLIER LIVE FOREX TRADES (12:00-14:00) ===');
  for (const r of earlierLive) {
    const meta = JSON.parse(r.prediction_meta || '{}');
    console.log(r.mt5_ticket, r.symbol, r.action, r.entry_time, 'Conf:', r.ai_confidence, 'Meta:', JSON.stringify(meta));
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
