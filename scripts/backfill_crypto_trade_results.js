import { getPool } from '../config/database.js';
import { getOpenPositions, getClosedDeals } from '../services/mt5Broker.js';
import { CRYPTO_UNIVERSE } from '../services/marketData.js';

const MODEL_SOURCE = 'crypto_tri_ensemble_v1.0.0';
const MODEL_VERSION = 'v1.0.0';
const STRATEGY_VERSION = 'crypto-m5-engine-v1';

function isCryptoSymbol(symbol) {
  return CRYPTO_UNIVERSE.includes(String(symbol));
}

function exitReasonFromComment(comment = '') {
  const text = String(comment).toLowerCase();
  if (text.includes('[sl')) return 'CLOSED_SL';
  if (text.includes('[tp')) return 'CLOSED_TP';
  return 'CLOSED_MT5';
}

function cryptoPips(action, entryPrice, exitPrice) {
  const diff = String(action).toUpperCase() === 'BUY'
    ? Number(exitPrice) - Number(entryPrice)
    : Number(entryPrice) - Number(exitPrice);
  return Number(diff.toFixed(2));
}

async function main() {
  const pool = await getPool();
  let livePositions;
  let closedDeals;

  if (process.argv.includes('--snapshot-stdin')) {
    let rawSnapshot = '';
    for await (const chunk of process.stdin) rawSnapshot += chunk;
    const snapshot = JSON.parse(rawSnapshot);
    livePositions = snapshot.open;
    closedDeals = snapshot.deals;
  } else {
    livePositions = await getOpenPositions();
    closedDeals = await getClosedDeals();
  }

  if (!Array.isArray(livePositions) || !Array.isArray(closedDeals)) {
    throw new Error('MT5 positions/history is unavailable; no backfill was written.');
  }

  const [signals] = await pool.query(
    `SELECT id, DATE_FORMAT(time, '%Y-%m-%d %H:%i:%s') AS signal_time,
            symbol, price, ai_confidence, sl_price, tp_price, action, mt5_ticket
     FROM signals
     WHERE market_type = 'crypto'
       AND mt5_ticket IS NOT NULL
     ORDER BY id ASC`
  );

  const [existingRows] = await pool.query(
    `SELECT id, mt5_ticket, entry_time, entry_price, action, exit_reason
     FROM trade_results
     WHERE market_type = 'crypto' AND mt5_ticket IS NOT NULL`
  );
  const existingTickets = new Set(existingRows.map(row => String(row.mt5_ticket)));
  const existingByTicket = new Map(existingRows.map(row => [String(row.mt5_ticket), row]));

  const openByTicket = new Map(
    livePositions
      .filter(position => isCryptoSymbol(position.symbol))
      .map(position => [String(position.ticket), position])
  );

  // A position normally has one closing deal. Keep the latest one if the
  // broker returns more than one record for a ticket.
  const closedByTicket = new Map();
  for (const deal of closedDeals.filter(item => isCryptoSymbol(item.symbol))) {
    closedByTicket.set(String(deal.position), deal);
  }

  let inserted = 0;
  let skipped = 0;
  const seenSignalTickets = new Set();

  for (const signal of signals) {
    const ticket = String(signal.mt5_ticket);
    if (seenSignalTickets.has(ticket)) {
      skipped += 1;
      continue;
    }
    seenSignalTickets.add(ticket);

    const existing = existingByTicket.get(ticket);
    const close = closedByTicket.get(ticket);
    if (existing && existing.exit_reason === 'OPEN' && close) {
      const entryPrice = Number(existing.entry_price ?? signal.price);
      const action = String(existing.action || signal.action || 'SELL').toUpperCase();
      const exitPrice = Number(close.price);
      const pips = cryptoPips(action, entryPrice, exitPrice);
      const profitLoss = Number(close.netProfit ?? close.profit ?? 0);
      const returnPct = entryPrice
        ? Number((((action === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice) / entryPrice) * 100).toFixed(4))
        : 0;
      let holdMinutes = null;
      if (existing.entry_time && close.time) {
        const diff = Math.abs(new Date(close.time).getTime() - new Date(existing.entry_time).getTime());
        if (Number.isFinite(diff)) holdMinutes = Math.max(1, Math.round(diff / 60000));
      }
      await pool.query(
        `UPDATE trade_results
         SET exit_time=?, exit_price=?, exit_reason=?, pips=?, profit_loss=?,
             return_pct=?, is_win=?, hold_duration_minutes=?
         WHERE id=? AND exit_reason='OPEN'`,
        [
          close.time,
          exitPrice,
          exitReasonFromComment(close.comment),
          pips,
          profitLoss,
          returnPct,
          profitLoss > 0 ? 1 : 0,
          holdMinutes,
          existing.id
        ]
      );
      skipped += 1;
      continue;
    }

    if (existing) {
      skipped += 1;
      continue;
    }

    const open = openByTicket.get(ticket);
    if (!open && !close) {
      // Do not invent a trade if the ticket is no longer visible in MT5
      // history and is not currently open.
      skipped += 1;
      continue;
    }

    const action = String(signal.action || (open?.type === 'BUY' ? 'BUY' : 'SELL')).toUpperCase();
    const entryPrice = Number(open?.priceOpen ?? signal.price);
    const lotSize = Number(open?.volume ?? close?.volume ?? 0.01);
    const isClosed = Boolean(close);
    const exitPrice = isClosed ? Number(close.price) : null;
    const pips = isClosed ? cryptoPips(action, entryPrice, exitPrice) : null;
    const profitLoss = isClosed ? Number(close.netProfit ?? close.profit ?? 0) : null;
    const returnPct = isClosed && entryPrice
      ? Number((((action === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice) / entryPrice) * 100).toFixed(4))
      : null;
    const predictionMeta = JSON.stringify({
      recovered: true,
      recovery_source: 'signals_and_mt5_history',
      signal_id: signal.id,
      model_source: MODEL_SOURCE,
      model_version: MODEL_VERSION
    });

    await pool.query(
      `INSERT INTO trade_results (
        mt5_ticket, symbol, market_type, model_source, model_version,
        strategy_version, decision_mode, prediction_meta, action, lot_size,
        source_tag, entry_time, entry_price, ai_confidence, sl_price, tp_price,
        exit_time, exit_price, exit_reason, pips, profit_loss, return_pct, is_win
      ) VALUES (?, ?, 'crypto', ?, ?, ?, 'LIVE', ?, ?, ?, 'crypto_backfill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        Number(ticket),
        signal.symbol,
        MODEL_SOURCE,
        MODEL_VERSION,
        STRATEGY_VERSION,
        predictionMeta,
        action,
        lotSize,
        signal.signal_time,
        entryPrice,
        Number(signal.ai_confidence || 0),
        Number(open?.sl ?? signal.sl_price ?? 0),
        Number(open?.tp ?? signal.tp_price ?? 0),
        isClosed ? close.time : null,
        exitPrice,
        isClosed ? exitReasonFromComment(close.comment) : 'OPEN',
        pips,
        profitLoss,
        returnPct,
        isClosed ? (profitLoss > 0 ? 1 : 0) : null
      ]
    );
    existingTickets.add(ticket);
    inserted += 1;
  }

  console.log(JSON.stringify({
    success: true,
    inserted,
    skipped,
    source: MODEL_SOURCE,
    note: 'Existing tables and rows were preserved; only missing crypto tickets were appended.'
  }));
  await pool.end();
}

main().catch(async error => {
  console.error(JSON.stringify({ success: false, error: error.message }));
  process.exitCode = 1;
});
