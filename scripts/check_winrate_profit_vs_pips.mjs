import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trading_bot',
    port: Number(process.env.DB_PORT || 3306)
  });

  const [rows] = await pool.query(`
    SELECT
      market_type,
      CASE
        WHEN decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE') THEN 'LIVE'
        ELSE 'SHADOW'
      END as run_mode,
      COUNT(*) as total_closed,
      
      -- 1. Count by is_win
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as is_win_count,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as wr_by_is_win,
      
      -- 2. Count by profit_loss > 0 (Net USD Profit)
      SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as usd_win_count,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as wr_by_usd,
      
      -- 3. Count by pips > 0 (Raw Pip Gain)
      SUM(CASE WHEN pips > 0 THEN 1 ELSE 0 END) as pips_win_count,
      ROUND(SUM(CASE WHEN pips > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as wr_by_pips,

      -- 4. Count by gross_profit > 0
      SUM(CASE WHEN gross_profit > 0 THEN 1 ELSE 0 END) as gross_usd_win_count,
      ROUND(SUM(CASE WHEN gross_profit > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN gross_profit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) as wr_by_gross_usd,
      
      -- Divergences:
      SUM(CASE WHEN pips > 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as pips_win_but_usd_loss,
      SUM(CASE WHEN profit_loss > 0 AND pips <= 0 THEN 1 ELSE 0 END) as usd_win_but_pips_loss,
      
      ROUND(SUM(profit_loss), 2) as total_usd,
      ROUND(SUM(pips), 2) as total_pips,
      ROUND(AVG(profit_loss), 3) as avg_usd,
      ROUND(AVG(pips), 2) as avg_pips
    FROM trade_results
    WHERE exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
      AND exit_price IS NOT NULL AND profit_loss IS NOT NULL
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY market_type, run_mode
    ORDER BY market_type, run_mode
  `);

  console.log('=== COMPARISON: WIN RATE BY PROFIT ($) VS PIPS VS IS_WIN (LAST 7 DAYS) ===');
  console.table(rows);

  // Now let's inspect the discrepancy rows specifically for LIVE Forex
  const [divergentRows] = await pool.query(`
    SELECT
      id, mt5_ticket, symbol, action, entry_price, exit_price, pips, profit_loss, gross_profit,
      commission_cost, swap_cost, is_win, exit_reason, hold_duration_minutes, created_at
    FROM trade_results
    WHERE market_type = 'forex'
      AND decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      AND (
        (pips > 0 AND profit_loss <= 0) OR
        (profit_loss > 0 AND pips <= 0) OR
        (is_win = 1 AND profit_loss <= 0) OR
        (is_win = 0 AND profit_loss > 0)
      )
    ORDER BY id DESC
    LIMIT 30
  `);

  console.log('\n=== SAMPLE DIVERGENT FOREX LIVE TRADES (PIPS vs PROFIT vs IS_WIN) ===');
  console.table(divergentRows);

  // Also check all-time / 30 days stats
  const [thirtyDays] = await pool.query(`
    SELECT
      market_type,
      CASE
        WHEN decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE') THEN 'LIVE'
        ELSE 'SHADOW'
      END as run_mode,
      COUNT(*) as total_closed,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as wr_by_is_win,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as wr_by_usd,
      ROUND(SUM(CASE WHEN pips > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as wr_by_pips,
      SUM(CASE WHEN pips > 0 AND profit_loss <= 0 THEN 1 ELSE 0 END) as pips_win_but_usd_loss,
      ROUND(SUM(profit_loss), 2) as total_usd,
      ROUND(SUM(pips), 2) as total_pips
    FROM trade_results
    WHERE exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
      AND exit_price IS NOT NULL AND profit_loss IS NOT NULL
      AND entry_time >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    GROUP BY market_type, run_mode
    ORDER BY market_type, run_mode
  `);

  console.log('\n=== 30-DAY PERFORMANCE: PROFIT ($) VS PIPS ===');
  console.table(thirtyDays);

  await pool.end();
}

run().catch(console.error);
