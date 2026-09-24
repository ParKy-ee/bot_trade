import { getPool } from '../config/database.js';
import { validateForexExitGeometry } from './forexExitEngine.js';

/**
 * Trade Result & Feature Logging Service
 * Records initial indicator features upon trade entry and resolves trade outcomes upon exit.
 * Designed for ML model retraining and quantitative performance tracking.
 */

function getBangkokDateTimeStr(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(d).replace('T', ' ');
}

export async function recordTradeEntry({
  ticket = null,
  symbol,
  marketType = 'forex',
  pairId = null,
  action,
  lotSize = 0.01,
  entryPrice,
  confidence = 0.5,
  sl = 0,
  tp = 0,
  indicators = {},
  reasons = [],
  modelSource = 'unknown',
  modelVersion = 'unknown',
  strategyVersion = 'unknown',
  configHash = null,
  decisionMode = 'LIVE',
  predictionMeta = null,
  sourceTag = 'legacy'
}) {
  try {
    if (['forex', 'forex_shadow'].includes(String(marketType).toLowerCase())) {
      const exitValidation = validateForexExitGeometry({
        action,
        entryPrice,
        slPrice: sl,
        tpPrice: tp
      });
      if (!exitValidation.valid) {
        console.error(`❌ [Trade Tracker] Refusing invalid Forex exit geometry for ${action} ${symbol}: ${exitValidation.reason}`);
        return null;
      }
    }

    const pool = await getPool();
    const normalizedTicket = ticket !== null && ticket !== undefined && Number(ticket) > 0
      ? Number(ticket)
      : null;

    // Idempotency guard: one MT5 position/ticket must have only one entry record.
    // Keep NULL tickets allowed for signal-only and historical stock records.
    if (normalizedTicket !== null) {
      const [existing] = await pool.query(
        `SELECT id FROM trade_results
         WHERE mt5_ticket = ? AND market_type = ?
         ORDER BY id DESC LIMIT 1`,
        [normalizedTicket, marketType]
      );
      if (existing.length > 0) {
        console.warn(`⚠️ [Trade Tracker] ข้ามการ Insert ซ้ำ Ticket #${normalizedTicket} (Record ID: ${existing[0].id})`);
        return existing[0].id;
      }
    }

    const nowStr = getBangkokDateTimeStr();
    const serializedPredictionMeta = predictionMeta === null || predictionMeta === undefined
      ? null
      : (typeof predictionMeta === 'string' ? predictionMeta : JSON.stringify(predictionMeta));

    const [res] = await pool.query(
      `INSERT INTO trade_results (
        mt5_ticket, symbol, market_type, pair_id, model_source, model_version, strategy_version,
        config_hash, decision_mode, prediction_meta, action, lot_size, source_tag,
        entry_time, entry_price, ai_confidence, sl_price, tp_price,
        ema9, ema21, ema50, rsi, adx, macd_hist, atr, filter_reasons,
        exit_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      [
        normalizedTicket,
        symbol,
        marketType,
        pairId ? String(pairId) : null,
        String(modelSource || 'unknown'),
        String(modelVersion || 'unknown'),
        String(strategyVersion || 'unknown'),
        configHash ? String(configHash) : null,
        String(decisionMode || 'LIVE'),
        serializedPredictionMeta,
        action.toUpperCase(),
        Number(lotSize),
        String(sourceTag || 'legacy'),
        nowStr,
        Number(entryPrice),
        Number(confidence),
        Number(sl),
        Number(tp),
        indicators.ema9 ? Number(indicators.ema9) : null,
        indicators.ema21 ? Number(indicators.ema21) : null,
        indicators.ema50 ? Number(indicators.ema50) : null,
        indicators.rsi14 || indicators.rsi ? Number(indicators.rsi14 || indicators.rsi) : null,
        indicators.adx14 || indicators.adx ? Number(indicators.adx14 || indicators.adx) : null,
        indicators.macdHist !== undefined ? Number(indicators.macdHist) : null,
        indicators.atr14 || indicators.atr ? Number(indicators.atr14 || indicators.atr) : null,
        JSON.stringify(reasons || []),
      ]
    );

    console.log(`📝 [Trade Tracker] บันทึก Feature ตอนเข้าเทรด ${action} ${symbol} (Record ID: ${res.insertId}, Ticket: #${ticket || 'N/A'})`);
    return res.insertId;
  } catch (err) {
    console.error('❌ Error recording trade entry:', err.message);
    return null;
  }
}

export async function recordTradeExit({
  ticket = null,
  symbol,
  exitPrice,
  exitReason = 'CLOSED_MANUAL',
  realProfit = null,
  grossProfit = null,
  commission = null,
  swap = null,
  fee = null,
  allowPlaceholderCorrection = false,
  tradeResultId = null
}) {
  try {
    const pool = await getPool();
    const now = new Date();
    const nowStr = getBangkokDateTimeStr(now);

    // Find the open record by ticket or symbol
    let sql = allowPlaceholderCorrection
      ? `SELECT * FROM trade_results
          WHERE (exit_reason = 'OPEN'
             OR exit_reason = 'CLOSED_EXPIRED'
             OR (exit_reason = 'CLOSED_MANUAL'
                AND COALESCE(exit_price, entry_price) = entry_price
                AND COALESCE(profit_loss, 0) = 0))`
      : `SELECT * FROM trade_results WHERE exit_reason = 'OPEN'`;
    const params = [];
    if (tradeResultId !== null && tradeResultId !== undefined) {
      sql += ` AND id = ? ORDER BY id DESC LIMIT 1`;
      params.push(Number(tradeResultId));
    } else if (ticket) {
      // Ticket values can collide across market adapters in legacy history;
      // include symbol so a close cannot update the wrong market's row.
      sql += ` AND mt5_ticket = ? AND symbol = ? ORDER BY id DESC LIMIT 1`;
      params.push(ticket, symbol);
    } else {
      sql += ` AND symbol = ? AND mt5_ticket IS NULL ORDER BY id DESC LIMIT 1`;
      params.push(symbol);
    }

    const [rows] = await pool.query(sql, params);
    if (!rows || rows.length === 0) {
      console.warn(`⚠️ [Trade Tracker] ไม่พบเรคคอร์ดสถานะ OPEN สำหรับ Ticket #${ticket || symbol}`);
      return false;
    }

    const trade = rows[0];
    const entryPrice = Number(trade.entry_price);
    const currExitPrice = Number(exitPrice);
    const action = trade.action.toUpperCase();
    const isStock = trade.market_type === 'stock';
    const isGold = trade.market_type === 'gold' || trade.symbol.includes('GOLD') || trade.symbol.includes('XAU');
    const isCrypto = trade.market_type === 'crypto' || trade.symbol.includes('BTC') || trade.symbol.includes('ETH');
    const isJpy = trade.symbol.includes('JPY');
    const pipSize = isJpy ? 0.01 : 0.0001;

    let pips = 0;
    let pnl = 0;
    let returnPct = 0;
    let costPips = null;

    if (isStock) {
      // Stock calculation (Price points & % Return)
      const pointDiff = action === 'BUY' ? (currExitPrice - entryPrice) : (entryPrice - currExitPrice);
      pips = Number(pointDiff.toFixed(2)); // points for stock
      returnPct = Number(((pointDiff / entryPrice) * 100).toFixed(2));
      pnl = realProfit !== null ? Number(realProfit) : Number(pointDiff.toFixed(2));
    } else if (isGold) {
      // Gold calculation (Points/Pips & Dollar PnL)
      const pointDiff = action === 'BUY' ? (currExitPrice - entryPrice) : (entryPrice - currExitPrice);
      pips = Number((pointDiff * 10).toFixed(1)); // 1 pip = 0.10 USD (10 points)
      returnPct = Number(((pointDiff / entryPrice) * 100).toFixed(2));
      const lot = Number(trade.lot_size) || 0.01;
      pnl = realProfit !== null ? Number(realProfit) : Number((pointDiff * 100 * lot).toFixed(2));
    } else if (isCrypto) {
      // Crypto calculation (BTC Price Diff & Dollar PnL)
      const pointDiff = action === 'BUY' ? (currExitPrice - entryPrice) : (entryPrice - currExitPrice);
      pips = Number(pointDiff.toFixed(2)); // dollar change on BTC
      returnPct = Number(((pointDiff / entryPrice) * 100).toFixed(2));
      const lot = Number(trade.lot_size) || 0.01;
      pnl = realProfit !== null ? Number(realProfit) : Number((pointDiff * lot).toFixed(2));
    } else {
      // Forex calculation (Pips & Dollar PnL)
      if (action === 'BUY') {
        pips = (currExitPrice - entryPrice) / pipSize;
      } else {
        pips = (entryPrice - currExitPrice) / pipSize;
      }
      pips = Number(pips.toFixed(2));

      if (realProfit !== null) {
        pnl = Number(realProfit);
      } else {
        const spreadPipsEstimate = isJpy ? 1.8 : 1.2;
        const netPips = Number((pips - spreadPipsEstimate).toFixed(2));
        const pipValuePerLot001 = isJpy ? (0.01 / currExitPrice * 1000) : 0.10;
        pnl = Number((netPips * pipValuePerLot001).toFixed(2));
      }
      returnPct = Number(((pips * pipSize / entryPrice) * 100).toFixed(4));
    }

    const hasGrossProfit = grossProfit !== null
      && grossProfit !== undefined
      && Number.isFinite(Number(grossProfit));
    if (hasGrossProfit && !isStock && !isGold && !isCrypto && Math.abs(pips) > 0) {
      const grossPipValue = Math.abs(Number(grossProfit) / pips);
      if (grossPipValue > 0) {
        costPips = Number(((Number(grossProfit) - pnl) / grossPipValue).toFixed(2));
      }
    }

    // Prefer broker-reported P&L for live trades. For Shadow trades, require positive net PnL
    // and profit pips exceeding broker spread friction so dataset does not learn microscopic false wins.
    const hasRealProfit = realProfit !== null
      && realProfit !== undefined
      && Number.isFinite(Number(realProfit));
    const shadowWinThreshold = isJpy ? 2.5 : 1.8;
    const isWin = (hasRealProfit
      ? Number(realProfit) > 0
      : (isStock ? returnPct > 0 : (isGold ? (pips >= 2.5 && pnl > 0) : (isCrypto ? pnl > 0 : (pips >= shadowWinThreshold && pnl > 0))))) ? 1 : 0;

    // Duration in minutes (Normalized against timezone skew)
    let durationMin = 1;
    if (trade.entry_time) {
      const entryMs = new Date(trade.entry_time).getTime();
      const exitMs = now.getTime();
      let diffMs = exitMs - entryMs;
      // If legacy entry_time had UTC discrepancy (+7h / ~25,200,000ms), normalize
      if (diffMs > 24000000 && diffMs < 26500000) {
        diffMs -= 7 * 60 * 60 * 1000;
      }
      durationMin = Math.max(1, Math.round(Math.abs(diffMs) / (1000 * 60)));
    }

    await pool.query(
      `UPDATE trade_results
       SET exit_time = ?,
           exit_price = ?,
           exit_reason = ?,
           pips = ?,
           profit_loss = ?,
           gross_profit = ?,
           commission_cost = ?,
           swap_cost = ?,
           fee_cost = ?,
           cost_pips = ?,
           return_pct = ?,
           is_win = ?,
           net_is_win = ?,
           hold_duration_minutes = ?
       WHERE id = ?`,
      [
        nowStr,
        currExitPrice,
        exitReason,
        pips,
        pnl,
        hasGrossProfit ? Number(grossProfit) : null,
        commission !== null && commission !== undefined ? Number(commission) : null,
        swap !== null && swap !== undefined ? Number(swap) : null,
        fee !== null && fee !== undefined ? Number(fee) : null,
        costPips,
        returnPct,
        isWin,
        isWin,
        durationMin,
        trade.id
      ]
    );

    const gainUnit = isStock ? `${returnPct > 0 ? '+' : ''}${returnPct}%` : `Pips: ${pips > 0 ? '+' : ''}${pips}`;
    console.log(`🏁 [Trade Tracker] บันทึกผลการปิดเทรด ${trade.symbol} (${trade.market_type}): ${isWin ? '🟢 WIN' : '🔴 LOSS'} | ${gainUnit} | PnL: $${pnl} | ถือครอง: ${durationMin} นาที`);
    return true;
  } catch (err) {
    console.error('❌ Error recording trade exit:', err.message);
    return false;
  }
}

export async function getTradeResults(limit = 100, market = null, options = {}) {
  const pool = await getPool();
  let sql = 'SELECT * FROM trade_results';
  const params = [];
  if (market && market !== 'all') {
    sql += ' WHERE market_type = ?';
    params.push(market);
  }
  if (options.readyForRetrain) {
    sql += market && market !== 'all' ? ' AND ' : ' WHERE ';
    if (market === 'crypto') {
      // Crypto stores its 10 model features in prediction_meta.features;
      // legacy indicator columns are not a complete Crypto feature vector.
      sql += `
        exit_reason NOT IN ('OPEN', 'SYNC_PENDING')
        AND is_win IS NOT NULL
        AND action IN ('BUY', 'SELL')
        AND entry_time IS NOT NULL
        AND entry_price IS NOT NULL
        AND JSON_VALID(prediction_meta) = 1
        AND JSON_EXTRACT(prediction_meta, '$.features') IS NOT NULL`;
    } else {
      sql += `
        exit_reason NOT IN ('OPEN', 'SYNC_PENDING')
        AND is_win IS NOT NULL
        AND action IN ('BUY', 'SELL')
        AND entry_time IS NOT NULL
        AND entry_price IS NOT NULL
        AND rsi IS NOT NULL
        AND adx IS NOT NULL
        AND atr IS NOT NULL
        AND ema21 IS NOT NULL
        AND ema50 IS NOT NULL
        AND macd_hist IS NOT NULL`;
    }
  }
  sql += ' ORDER BY entry_time DESC LIMIT ?';
  params.push(Number(limit));
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function getTradeStats(market = null) {
  const pool = await getPool();
  let whereClause = '';
  const params = [];
  if (market && market !== 'all') {
    whereClause = ' WHERE market_type = ?';
    params.push(market);
  }

  const [rows] = await pool.query(`
    SELECT 
      COUNT(*) AS total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' THEN 1 ELSE 0 END) AS closed_trades,
      SUM(CASE WHEN exit_time IS NOT NULL AND COALESCE(profit_loss, 0) > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN exit_time IS NOT NULL AND COALESCE(profit_loss, 0) <= 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(AVG(CASE WHEN exit_time IS NOT NULL THEN pips ELSE NULL END), 2) AS avg_pips,
      ROUND(SUM(CASE WHEN exit_time IS NOT NULL THEN COALESCE(pips, 0) ELSE 0 END), 2) AS total_pips,
      ROUND(AVG(CASE WHEN exit_time IS NOT NULL THEN return_pct ELSE NULL END), 2) AS avg_return_pct,
      ROUND(SUM(CASE WHEN exit_time IS NOT NULL THEN COALESCE(return_pct, 0) ELSE 0 END), 2) AS total_return_pct,
      ROUND(SUM(CASE WHEN exit_time IS NOT NULL THEN COALESCE(profit_loss, 0) ELSE 0 END), 2) AS total_pnl,
      ROUND(AVG(CASE WHEN exit_time IS NOT NULL THEN hold_duration_minutes ELSE NULL END), 1) AS avg_hold_minutes
    FROM trade_results
    ${whereClause}
  `, params);

  const s = rows[0] || {};
  const closed = Number(s.closed_trades || 0);
  const wins = Number(s.wins || 0);
  const winRate = closed > 0 ? Number(((wins / closed) * 100).toFixed(2)) : 0;

  return {
    market: market || 'all',
    totalTrades: Number(s.total_trades || 0),
    closedTrades: closed,
    wins,
    losses: Number(s.losses || 0),
    winRate,
    avgPips: Number(s.avg_pips || 0),
    totalPips: Number(s.total_pips || 0),
    avgReturnPct: Number(s.avg_return_pct || 0),
    totalReturnPct: Number(s.total_return_pct || 0),
    totalPnl: Number(s.total_pnl || 0),
    avgHoldMinutes: Number(s.avg_hold_minutes || 0)
  };
}

/**
 * Automatically synchronizes active_positions and trade_results with MT5 terminal reality.
 * Detects orders that closed broker-side (hit SL or TP) and updates their status immediately.
 */
export async function syncMt5PositionsWithDatabase() {
  if (process.env.MT5_ENABLED !== 'true') return;

  try {
    const { getOpenPositions, getClosedDeals, getPendingOrders } = await import('./mt5Broker.js');
    const openRes = await getOpenPositions();
    if (!Array.isArray(openRes)) return; // MT5 not connected or error

    const positionKey = (symbol, ticket) => `${String(symbol)}:${Number(ticket)}`;
    const openTickets = new Set(openRes.map(p => Number(p.ticket)));
    const openKeys = new Set(openRes.map(p => positionKey(p.symbol, p.ticket)));
    const pendingRes = await getPendingOrders();
    const pendingTickets = new Set(
      Array.isArray(pendingRes)
        ? pendingRes.map(o => Number(o.ticket))
        : []
    );

    const closedDealsRes = await getClosedDeals();
    const closedDealsMap = new Map();
    if (Array.isArray(closedDealsRes)) {
      for (const d of closedDealsRes) {
        if (d.position) {
          closedDealsMap.set(Number(d.position), d);
          closedDealsMap.set(positionKey(d.symbol, d.position), d);
        }
      }
    }

    const pool = await getPool();
    const openPositionsMap = new Map();
    for (const p of openRes) {
      openPositionsMap.set(Number(p.ticket), p);
      openPositionsMap.set(positionKey(p.symbol, p.ticket), p);
    }

    // Use trade_results as the per-ticket source of truth. active_positions has
    // symbol as its primary key, so it cannot represent collector mode's
    // multiple simultaneous crypto positions for the same symbol.
    const [dbPositions] = await pool.query(
      `SELECT tr.id AS trade_result_id,
              tr.symbol, tr.market_type, tr.mt5_ticket, tr.entry_price,
              tr.entry_time,
              tr.exit_reason AS result_exit_reason,
              tr.exit_price AS result_exit_price,
              tr.profit_loss AS result_profit_loss,
               COALESCE(ap.status_note, 'OPEN') AS status_note,
               ap.entry_date AS active_entry_date
       FROM trade_results tr
       LEFT JOIN active_positions ap
         ON ap.mt5_ticket = tr.mt5_ticket
        AND ap.symbol = tr.symbol
        AND ap.market_type = tr.market_type
       WHERE tr.mt5_ticket IS NOT NULL
          AND (tr.exit_reason = 'OPEN'
               OR tr.exit_reason = 'CLOSED_EXPIRED'
              OR (tr.exit_reason = 'CLOSED_MANUAL'
                  AND COALESCE(tr.exit_price, tr.entry_price) = tr.entry_price
                  AND COALESCE(tr.profit_loss, 0) = 0))`
    );

    for (const pos of dbPositions) {
      const ticket = Number(pos.mt5_ticket);
      const statusNote = String(pos.status_note || 'OPEN');
      const tradeKey = positionKey(pos.symbol, ticket);
      const isOpenInMt5 = openTickets.has(ticket) || openKeys.has(tradeKey);
      const isPendingInMt5 = pendingTickets.has(ticket);
      const isExpiredCandidate = pos.result_exit_reason === 'CLOSED_EXPIRED';

      // If still waiting as an active pending limit/stop order on MT5, keep it untouched
      if (isPendingInMt5) {
        continue;
      }

      const hasPlaceholderExit = pos.result_exit_reason === 'CLOSED_MANUAL'
        && Number(pos.result_exit_price) === Number(pos.entry_price)
        && Number(pos.result_profit_loss || 0) === 0;

      if (!isOpenInMt5 && (!statusNote.startsWith('CLOSED') || hasPlaceholderExit || isExpiredCandidate)) {
        // The position has closed on MT5!
        const deal = closedDealsMap.get(ticket) || closedDealsMap.get(tradeKey);
        let exitReason = 'CLOSED_MANUAL';
        let exitPrice = Number(pos.entry_price);
        let realProfit = null;

        if (deal) {
          exitPrice = Number(deal.price);
          realProfit = Number(deal.netProfit ?? deal.profit);
          const c = String(deal.comment || '').toLowerCase();
          if (c.includes('[sl')) {
            exitReason = 'CLOSED_SL';
          } else if (c.includes('[tp')) {
            exitReason = 'CLOSED_TP';
          } else {
            exitReason = 'CLOSED_MT5';
          }
        }

        if (!deal && isExpiredCandidate) {
          // A previous sync may have guessed CLOSED_EXPIRED before MT5
          // history was ready. Keep it untouched until a real deal appears.
          continue;
        }

        if (!deal) {
          const isPendingStatus = statusNote.includes('PENDING') && !statusNote.startsWith('SYNC_PENDING');
          const entryTime = new Date(pos.active_entry_date || pos.entry_time || 0).getTime();
          const ageSeconds = Number.isFinite(entryTime)
            ? Math.max(0, (Date.now() - entryTime) / 1000)
            : Infinity;
          const pendingSyncGraceSeconds = Math.max(
            30,
            Number(process.env.MT5_PENDING_SYNC_GRACE_SECONDS || 90)
          );
          const orphanGraceSeconds = Math.max(
            300,
            Number(process.env.MT5_ORPHAN_SYNC_TIMEOUT_SECONDS || 1800)
          );
          if ((isPendingStatus || statusNote.startsWith('SYNC_PENDING'))
            && ageSeconds >= pendingSyncGraceSeconds) {
            exitReason = 'CLOSED_EXPIRED';
            exitPrice = Number(pos.entry_price);
            realProfit = 0;
            console.log(`⌛ [Auto-Sync] MT5 คำสั่ง Pending Ticket #${ticket} (${pos.symbol}) หมดอายุหรือถูกยกเลิกแล้ว (Expired/Canceled) -> อัปเดตสถานะเป็น CLOSED_EXPIRED`);
          } else if (ageSeconds >= orphanGraceSeconds) {
            exitReason = 'CLOSED_HISTORICAL';
            exitPrice = Number(pos.entry_price);
            realProfit = 0;
            console.log(`🧹 [Auto-Sync] ออเดอร์ตกค้าง Ticket #${ticket} (${pos.symbol}) เก่ากว่า ${Math.round(orphanGraceSeconds / 60)} นาที และไม่อยู่ใน MT5 -> อัปเดตสถานะเป็น CLOSED_HISTORICAL`);
          } else {
            // Do not finalize an exit with a guessed price/P&L. Keep the row active
            // while the MT5 history query catches up, so a later sync can resolve it.
            await pool.query(
              `UPDATE active_positions
               SET status_note = 'SYNC_PENDING'
               WHERE mt5_ticket = ? AND symbol = ? AND market_type = ?`,
              [ticket, pos.symbol, pos.market_type]
            );
            continue;
          }
        }

        console.log(`🔄 [Auto-Sync] MT5 ตรวจพบออเดอร์ Ticket #${ticket} (${pos.symbol}) ปิดตัวลงแล้ว -> อัปเดตสถานะเป็น ${exitReason}`);

        // Update active_positions table
        await pool.query(
          `UPDATE active_positions
           SET status_note = ?
           WHERE mt5_ticket = ? AND symbol = ? AND market_type = ?`,
          [exitReason, ticket, pos.symbol, pos.market_type]
        );

        // Update trade_results table
        await recordTradeExit({
          ticket,
          symbol: pos.symbol,
          exitPrice,
          exitReason,
          realProfit,
          grossProfit: deal ? deal.profit : null,
          commission: deal ? deal.commission : null,
          swap: deal ? deal.swap : null,
          fee: deal ? deal.fee : null,
          allowPlaceholderCorrection: true
        });
      } else if (isOpenInMt5 && statusNote.startsWith('CLOSED')) {
        // Position is STILL OPEN in MT5! Restore active status
        const mt5Pos = openPositionsMap.get(ticket) || openPositionsMap.get(tradeKey);
        const actionType = mt5Pos?.type || 'BUY';
        const mType = String(pos.market_type || 'forex').toUpperCase();
        const activeStatus = pos.market_type === 'stock' ? 'SIGNAL_OPEN' : `${mType}_${actionType}_OPEN`;
        console.log(`🔄 [Auto-Sync] ออเดอร์ Ticket #${ticket} (${pos.symbol}) ยังเปิดอยู่บน MT5 -> ปรับสถานะกลับเป็น ${activeStatus}`);
        await pool.query(
          `UPDATE active_positions 
           SET status_note = ?, sl_price = ?, tp_price = ? 
           WHERE mt5_ticket = ? AND symbol = ? AND market_type = ?`,
          [activeStatus, mt5Pos?.sl || 0, mt5Pos?.tp || 0, ticket, pos.symbol, pos.market_type]
        );

        // Restore trade_results row to OPEN if it was prematurely closed
        await pool.query(
          `UPDATE trade_results
           SET exit_reason = 'OPEN', exit_price = NULL, profit_loss = NULL, return_pct = NULL, exit_time = NULL, is_win = NULL
           WHERE mt5_ticket = ? AND symbol = ? AND market_type = ?`,
          [ticket, pos.symbol, pos.market_type]
        );
      }
    }
  } catch (err) {
    console.warn('⚠️ syncMt5PositionsWithDatabase warning:', err.message);
  }
}
