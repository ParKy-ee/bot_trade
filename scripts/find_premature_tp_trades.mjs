import mysql from 'mysql2/promise';
import fs from 'fs';

async function auditPrematureExits() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db'
  });

  // Query trades that closed early
  const [trades] = await conn.query(`
    SELECT 
      id, mt5_ticket, symbol, action, decision_mode,
      entry_time, exit_time,
      ROUND(entry_price, 5) as entry,
      ROUND(exit_price, 5) as exit_p,
      ROUND(sl_price, 5) as sl,
      ROUND(tp_price, 5) as tp,
      ROUND(pips, 2) as pips,
      ROUND(profit_loss, 2) as pnl,
      exit_reason,
      DATE_FORMAT(entry_time, '%Y-%m-%d %H:%i:%s') as entry_bkk,
      DATE_FORMAT(exit_time, '%Y-%m-%d %H:%i:%s') as exit_bkk,
      TIMESTAMPDIFF(MINUTE, entry_time, exit_time) as hold_minutes
    FROM trade_results
    WHERE entry_time >= '2026-09-24 00:00:00'
      AND exit_reason IN (
        'CLOSED_PRESSURE_EARLY_CUT',
        'CLOSED_TIME_STOP',
        'CLOSED_PRESSURE_PROFIT_LOCK',
        'EXIT_CHALLENGER_EARLY_CUT',
        'CLOSED_MICRO_SCALP'
      )
      AND tp_price IS NOT NULL
      AND sl_price IS NOT NULL
    ORDER BY id DESC
  `);

  console.log(`Analyzing ${trades.length} early-closed trades...`);

  const results = [];

  for (const t of trades) {
    // Map symbol to market_bars symbol (e.g. AUDUSD -> AUDUSD=X or vice versa)
    let barSymbol = t.symbol;
    if (!barSymbol.includes('=X') && !['GOLD', 'BTCUSD', 'ETHUSD', 'SOLUSD'].includes(barSymbol)) {
      barSymbol = `${t.symbol}=X`;
    }

    // Query bars after exit_time for up to 3 hours (36 M5 bars)
    const [subsequentBars] = await conn.query(`
      SELECT time, open, high, low, close
      FROM market_bars
      WHERE (symbol = ? OR symbol = ?)
        AND time >= ?
        AND time <= DATE_ADD(?, INTERVAL 4 HOUR)
      ORDER BY time ASC
    `, [t.symbol, barSymbol, t.exit_time, t.exit_time]);

    if (!subsequentBars || subsequentBars.length === 0) {
      continue;
    }

    const isBuy = t.action === 'BUY';
    const entry = Number(t.entry);
    const sl = Number(t.sl);
    const tp = Number(t.tp);
    const exitPrice = Number(t.exit_p);

    let hitTp = false;
    let hitSl = false;
    let firstEvent = null;
    let eventTime = null;
    let maxFavorable = 0;
    let maxAdverse = 0;

    for (const b of subsequentBars) {
      const high = Number(b.high);
      const low = Number(b.low);

      if (isBuy) {
        const fav = high - exitPrice;
        const adv = exitPrice - low;
        if (fav > maxFavorable) maxFavorable = fav;
        if (adv > maxAdverse) maxAdverse = adv;

        // Check if hit TP or SL
        if (!firstEvent) {
          if (low <= sl && high >= tp) {
            // Collision bar
            firstEvent = 'COLLISION_SL_TP';
            eventTime = b.time;
            hitSl = true;
            hitTp = true;
          } else if (low <= sl) {
            firstEvent = 'HIT_SL';
            eventTime = b.time;
            hitSl = true;
          } else if (high >= tp) {
            firstEvent = 'HIT_TP';
            eventTime = b.time;
            hitTp = true;
          }
        }
      } else {
        // SELL
        const fav = exitPrice - low;
        const adv = high - exitPrice;
        if (fav > maxFavorable) maxFavorable = fav;
        if (adv > maxAdverse) maxAdverse = adv;

        if (!firstEvent) {
          if (high >= sl && low <= tp) {
            firstEvent = 'COLLISION_SL_TP';
            eventTime = b.time;
            hitSl = true;
            hitTp = true;
          } else if (high >= sl) {
            firstEvent = 'HIT_SL';
            eventTime = b.time;
            hitSl = true;
          } else if (low <= tp) {
            firstEvent = 'HIT_TP';
            eventTime = b.time;
            hitTp = true;
          }
        }
      }
    }

    let outcomeCategory = 'CHOPPED_IN_RANGE';
    if (firstEvent === 'HIT_TP') {
      outcomeCategory = 'WOULD_HAVE_HIT_TP'; // Price went on to hit original TP!
    } else if (firstEvent === 'HIT_SL' || firstEvent === 'COLLISION_SL_TP') {
      outcomeCategory = 'SAVED_FROM_HARD_SL'; // Price went on to hit Hard SL!
    }

    const pipMultiplier = t.symbol.includes('JPY') ? 100 : (t.symbol.includes('GOLD') ? 10 : 10000);
    const tpDistancePips = isBuy ? (tp - entry) * pipMultiplier : (entry - tp) * pipMultiplier;

    results.push({
      id: t.id,
      ticket: t.mt5_ticket,
      symbol: t.symbol,
      action: t.action,
      decision_mode: t.decision_mode,
      exit_reason: t.exit_reason,
      entry_bkk: t.entry_bkk,
      exit_bkk: t.exit_bkk,
      entry,
      exit_price: exitPrice,
      sl,
      tp,
      realized_pips: t.pips,
      realized_pnl: t.pnl,
      tp_distance_pips: Number(tpDistancePips.toFixed(1)),
      outcome_category: outcomeCategory,
      first_event: firstEvent,
      bars_checked: subsequentBars.length
    });
  }

  // Summary counts
  const summaryByExitReason = {};
  for (const r of results) {
    if (!summaryByExitReason[r.exit_reason]) {
      summaryByExitReason[r.exit_reason] = {
        total: 0,
        would_have_hit_tp: 0,
        saved_from_hard_sl: 0,
        chopped: 0
      };
    }
    const s = summaryByExitReason[r.exit_reason];
    s.total += 1;
    if (r.outcome_category === 'WOULD_HAVE_HIT_TP') s.would_have_hit_tp += 1;
    else if (r.outcome_category === 'SAVED_FROM_HARD_SL') s.saved_from_hard_sl += 1;
    else s.chopped += 1;
  }

  // Filter trades that WOULD HAVE HIT TP
  const tradesThatHitTp = results.filter(r => r.outcome_category === 'WOULD_HAVE_HIT_TP');
  const tradesSavedFromSl = results.filter(r => r.outcome_category === 'SAVED_FROM_HARD_SL');

  fs.writeFileSync('scripts/premature_tp_audit_res.json', JSON.stringify({
    total_analyzed: results.length,
    summaryByExitReason,
    tradesThatHitTp,
    tradesSavedFromSl: tradesSavedFromSl.slice(0, 15)
  }, null, 2), 'utf8');

  console.log("AUDIT_COMPLETE! Results saved to scripts/premature_tp_audit_res.json");
  await conn.end();
}

auditPrematureExits().catch(console.error);
