/**
 * services/instantProfitWatcher.js
 * 
 * 1-Minute Instant Profit Harvest & Guard Module
 * Autonomous position watcher that monitors open live and shadow positions every minute.
 * As soon as any order exhibits positive net profit (>= INSTANT_PROFIT_MIN_USD),
 * it closes the order immediately via market order to eliminate near-TP reversal risks
 * and guarantee positive returns.
 */

import { getPool } from '../config/database.js';
import { getOpenPositions, closePosition, getRates } from './mt5Broker.js';
import { recordTradeExit, syncMt5PositionsWithDatabase } from './tradeResultTracker.js';

let watcherTimer = null;
let isHarvesting = false;

// In-memory runtime telemetry & stats
const watcherStats = {
  enabled: true,
  intervalSec: 60,
  minProfitUsd: 0.01,
  shadowEnabled: true,
  isRunning: false,
  lastCheckTime: null,
  totalHarvestedCount: 0,
  totalHarvestedPnl: 0.0,
  recentHarvests: []
};

/**
 * Check if the watcher is enabled from environment / runtime
 */
export function isInstantProfitWatcherEnabled() {
  if (process.env.INSTANT_PROFIT_WATCHER_ENABLED === 'false') return false;
  return watcherStats.enabled;
}

/**
 * Get current watcher configuration and statistics
 */
export function getInstantProfitWatcherStatus() {
  const intervalSec = Number(process.env.INSTANT_PROFIT_INTERVAL_SEC || watcherStats.intervalSec || 60);
  const minProfitUsd = Number(process.env.INSTANT_PROFIT_MIN_USD || watcherStats.minProfitUsd || 0.01);
  const shadowEnabled = process.env.INSTANT_PROFIT_SHADOW_ENABLED !== 'false' && watcherStats.shadowEnabled;
  const enabled = isInstantProfitWatcherEnabled();

  return {
    ...watcherStats,
    enabled,
    intervalSec,
    minProfitUsd,
    shadowEnabled
  };
}

/**
 * Configure watcher runtime parameters dynamically
 */
export function setInstantProfitWatcherConfig({ enabled, intervalSec, minProfitUsd, shadowEnabled }) {
  if (typeof enabled === 'boolean') {
    watcherStats.enabled = enabled;
  }
  if (Number.isFinite(intervalSec) && intervalSec >= 5) {
    watcherStats.intervalSec = Math.round(intervalSec);
  }
  if (Number.isFinite(minProfitUsd) && minProfitUsd >= 0) {
    watcherStats.minProfitUsd = Number(minProfitUsd.toFixed(2));
  }
  if (typeof shadowEnabled === 'boolean') {
    watcherStats.shadowEnabled = shadowEnabled;
  }

  // Restart timer if running to apply new interval
  if (watcherStats.isRunning) {
    stopInstantProfitWatcher();
    startInstantProfitWatcher();
  }

  return getInstantProfitWatcherStatus();
}

/**
 * Core harvest check: Scans open MT5 orders and open shadow trades,
 * closing any orders with positive net profit >= minProfitUsd.
 */
export async function checkAndHarvestProfits() {
  if (!isInstantProfitWatcherEnabled()) return { skipped: true, reason: 'WATCHER_DISABLED' };
  if (isHarvesting) return { skipped: true, reason: 'HARVEST_IN_PROGRESS' };

  isHarvesting = true;
  watcherStats.lastCheckTime = new Date().toISOString();

  const minProfitUsd = Number(process.env.INSTANT_PROFIT_MIN_USD || watcherStats.minProfitUsd || 0.01);
  const shadowEnabled = process.env.INSTANT_PROFIT_SHADOW_ENABLED !== 'false' && watcherStats.shadowEnabled;
  const mt5Enabled = process.env.MT5_ENABLED === 'true';

  let liveClosedCount = 0;
  let shadowClosedCount = 0;
  let liveProfitHarvested = 0.0;
  let shadowProfitHarvested = 0.0;

  try {
    // ==========================================
    // 1. HARVEST LIVE MT5 ORDERS
    // ==========================================
    if (mt5Enabled) {
      try {
        const openPositions = await getOpenPositions();
        if (Array.isArray(openPositions) && openPositions.length > 0) {
          for (const pos of openPositions) {
            const ticket = Number(pos.ticket);
            if (!ticket) continue;

            const floatingGross = Number(pos.profit || 0);
            const floatingSwap = Number(pos.swap || 0);
            const netFloatingProfit = Number((floatingGross + floatingSwap).toFixed(2));

            // Positive profit check: net profit must reach minProfitUsd
            if (netFloatingProfit >= minProfitUsd) {
              console.log(`🎯 [Instant Profit Harvest] ตรวจพบออเดอร์มีกำไร! ไม้ #${ticket} (${pos.symbol} ${pos.type}): กำไรลอยตัว +$${netFloatingProfit.toFixed(2)} USD (Open: ${pos.priceOpen}, Now: ${pos.priceCurrent}) -> ส่งคำสั่งปิดทำกำไรทันที!`);

              const closeRes = await closePosition(ticket);
              if (closeRes && closeRes.success) {
                const pool = await getPool();
                await pool.query(
                  `UPDATE active_positions SET status_note = 'CLOSED_INSTANT_PROFIT_HARVEST' WHERE mt5_ticket = ?`,
                  [ticket]
                );

                const realProfit = closeRes.profit !== undefined && closeRes.profit !== null
                  ? Number(closeRes.profit)
                  : netFloatingProfit;

                await recordTradeExit({
                  ticket,
                  symbol: pos.symbol,
                  exitPrice: Number(pos.priceCurrent),
                  exitReason: 'CLOSED_INSTANT_PROFIT_HARVEST',
                  realProfit,
                  allowBrokerReconciliation: true
                });

                liveClosedCount++;
                liveProfitHarvested += realProfit;
                watcherStats.totalHarvestedCount++;
                watcherStats.totalHarvestedPnl = Number((watcherStats.totalHarvestedPnl + realProfit).toFixed(2));

                const harvestRecord = {
                  ticket,
                  symbol: pos.symbol,
                  market: 'live_mt5',
                  action: pos.type,
                  profit: realProfit,
                  exitPrice: pos.priceCurrent,
                  time: new Date().toISOString()
                };
                watcherStats.recentHarvests.unshift(harvestRecord);
                if (watcherStats.recentHarvests.length > 20) watcherStats.recentHarvests.pop();

                console.log(`✅ [Instant Profit Harvest] ปิดออเดอร์ #${ticket} (${pos.symbol}) สำเร็จ! ล็อกกำไร +$${realProfit.toFixed(2)} USD เรียบร้อย`);
              } else {
                console.warn(`⚠️ [Instant Profit Harvest] ปิดออเดอร์ #${ticket} (${pos.symbol}) ไม่สำเร็จ:`, closeRes?.error || 'UNKNOWN');
              }
            }
          }

          // If any live orders closed, sync MT5 deals with database immediately
          if (liveClosedCount > 0) {
            try {
              await syncMt5PositionsWithDatabase();
            } catch (syncErr) {
              console.warn('⚠️ [Instant Profit Harvest] Error during syncMt5PositionsWithDatabase:', syncErr.message);
            }
          }
        }
      } catch (mt5Err) {
        console.warn('⚠️ [Instant Profit Harvest] Error checking MT5 positions:', mt5Err.message);
      }
    }

    // ==========================================
    // 2. HARVEST SHADOW (VIRTUAL) ORDERS
    // ==========================================
    if (shadowEnabled) {
      try {
        const pool = await getPool();
        const [openShadows] = await pool.query(
          `SELECT id, symbol, market_type, action, entry_price, entry_time 
           FROM trade_results 
           WHERE exit_reason = 'OPEN' AND mt5_ticket IS NULL`
        );

        if (Array.isArray(openShadows) && openShadows.length > 0) {
          for (const shadow of openShadows) {
            const sym = shadow.symbol;
            const action = String(shadow.action).toUpperCase();
            const entryPrice = Number(shadow.entry_price);
            if (!entryPrice) continue;

            let currPrice = null;
            try {
              const rates = await getRates(sym, 1, 1);
              if (rates && Array.isArray(rates.bars) && rates.bars.length > 0) {
                currPrice = Number(rates.bars[rates.bars.length - 1].close);
              }
            } catch (rateErr) {
              continue;
            }

            if (!currPrice || !Number.isFinite(currPrice)) continue;

            const isJpy = sym.includes('JPY');
            const isGold = sym.includes('GOLD') || sym.includes('XAU') || shadow.market_type === 'gold';
            const isCrypto = sym.includes('BTC') || sym.includes('ETH') || sym.includes('SOL') || shadow.market_type === 'crypto';
            const isStock = shadow.market_type === 'stock';

            let netPnl = 0.0;
            let pips = 0.0;

            if (isStock) {
              const pointDiff = action === 'BUY' ? (currPrice - entryPrice) : (entryPrice - currPrice);
              netPnl = Number(pointDiff.toFixed(2));
            } else if (isGold) {
              const pointDiff = action === 'BUY' ? (currPrice - entryPrice) : (entryPrice - currPrice);
              pips = Number((pointDiff * 10).toFixed(1));
              const spreadFriction = 0.25; // 25 cents spread
              netPnl = Number(((pointDiff - spreadFriction) * 100 * 0.01).toFixed(2));
            } else if (isCrypto) {
              const pointDiff = action === 'BUY' ? (currPrice - entryPrice) : (entryPrice - currPrice);
              pips = Number(pointDiff.toFixed(2));
              const feeSpreadEstimate = 0.02; // $0.02 friction
              netPnl = Number(((pointDiff * 0.01) - feeSpreadEstimate).toFixed(2));
            } else {
              // Forex
              const pipSize = isJpy ? 0.01 : 0.0001;
              pips = action === 'BUY' ? ((currPrice - entryPrice) / pipSize) : ((entryPrice - currPrice) / pipSize);
              const spreadPips = isJpy ? 1.8 : 1.2;
              const netPips = pips - spreadPips;
              const pipValue = isJpy ? (0.01 / currPrice * 1000) : 0.10;
              netPnl = Number((netPips * pipValue).toFixed(2));
            }

            // Positive profit check for shadow order
            if (netPnl >= minProfitUsd) {
              console.log(`🎯 [Instant Profit Harvest (Shadow)] ปิดรวบกำไรจำลองทันที! ไม้ #${shadow.id} (${shadow.symbol} ${action}): กำไรลอยตัว +$${netPnl.toFixed(2)} USD (Pips: ${pips.toFixed(1)})`);

              await recordTradeExit({
                tradeResultId: shadow.id,
                symbol: shadow.symbol,
                exitPrice: currPrice,
                exitReason: 'CLOSED_INSTANT_PROFIT_HARVEST',
                realProfit: netPnl,
                allowBrokerReconciliation: true
              });

              await pool.query(
                `UPDATE active_positions SET status_note = 'CLOSED_INSTANT_PROFIT_HARVEST' 
                 WHERE symbol = ? AND market_type = ?`,
                [shadow.symbol, shadow.market_type]
              );

              shadowClosedCount++;
              shadowProfitHarvested += netPnl;
              watcherStats.totalHarvestedCount++;
              watcherStats.totalHarvestedPnl = Number((watcherStats.totalHarvestedPnl + netPnl).toFixed(2));

              const harvestRecord = {
                ticket: null,
                symbol: shadow.symbol,
                market: shadow.market_type,
                action,
                profit: netPnl,
                exitPrice: currPrice,
                time: new Date().toISOString()
              };
              watcherStats.recentHarvests.unshift(harvestRecord);
              if (watcherStats.recentHarvests.length > 20) watcherStats.recentHarvests.pop();
            }
          }
        }
      } catch (shadowErr) {
        console.warn('⚠️ [Instant Profit Harvest] Error checking shadow trades:', shadowErr.message);
      }
    }
  } finally {
    isHarvesting = false;
  }

  return {
    timestamp: watcherStats.lastCheckTime,
    liveClosedCount,
    shadowClosedCount,
    liveProfitHarvested: Number(liveProfitHarvested.toFixed(2)),
    shadowProfitHarvested: Number(shadowProfitHarvested.toFixed(2)),
    totalClosed: liveClosedCount + shadowClosedCount
  };
}

/**
 * Start the recurring 1-minute instant profit watcher
 */
export function startInstantProfitWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);

  const intervalSec = Number(process.env.INSTANT_PROFIT_INTERVAL_SEC || watcherStats.intervalSec || 60);
  const minProfitUsd = Number(process.env.INSTANT_PROFIT_MIN_USD || watcherStats.minProfitUsd || 0.01);
  const intervalMs = Math.max(5000, intervalSec * 1000);

  watcherStats.isRunning = true;
  watcherStats.intervalSec = intervalSec;
  watcherStats.minProfitUsd = minProfitUsd;

  console.log(`🛡️ [Instant Profit Watcher] เริ่มทำงาน: เฝ้าตรวจ order ทุก ${intervalSec} วินาที (หากกำไร >= +$${minProfitUsd} USD จะสั่งปิดทำกำไรทันที)`);

  watcherTimer = setInterval(async () => {
    try {
      await checkAndHarvestProfits();
    } catch (err) {
      console.warn('⚠️ [Instant Profit Watcher] Error in interval cycle:', err.message);
    }
  }, intervalMs);
}

/**
 * Stop the recurring instant profit watcher
 */
export function stopInstantProfitWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  watcherStats.isRunning = false;
  console.log('⏸️ [Instant Profit Watcher] หยุดการทำงานชั่วคราว');
}
