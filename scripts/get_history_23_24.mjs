import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=========================================================================");
  console.log("📅 1. SUMMARY BY DATE & MARKET TYPE (2026-09-23 & 2026-09-24)");
  console.log("=========================================================================");
  const [byDateMarket] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      market_type,
      decision_mode,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl_usd,
      ROUND(SUM(pips), 1) as total_pips
    FROM trade_results
    WHERE entry_time >= '2026-09-23 00:00:00' 
      AND entry_time <= '2026-09-24 23:59:59'
      AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time), market_type, decision_mode
    ORDER BY trade_date ASC, market_type ASC
  `);
  console.table(byDateMarket);

  console.log("\n=========================================================================");
  console.log("🎯 2. DAILY AGGREGATE SUMMARY (ALL LIVE TRADES vs SHADOW TRADES)");
  console.log("=========================================================================");
  const [dailyAgg] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      CASE 
        WHEN decision_mode = 'LIVE' THEN 'LIVE_MT5'
        ELSE 'SHADOW_SIMULATION'
      END as execution_type,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-23 00:00:00' 
      AND entry_time <= '2026-09-24 23:59:59'
      AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time), execution_type
    ORDER BY trade_date ASC, execution_type DESC
  `);
  console.table(dailyAgg);

  console.log("\n=========================================================================");
  console.log("🚪 3. EXIT REASONS BREAKDOWN (2026-09-23 & 2026-09-24)");
  console.log("=========================================================================");
  const [exitReasons] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as win_count,
      ROUND(SUM(profit_loss), 2) as pnl_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-23 00:00:00' 
      AND entry_time <= '2026-09-24 23:59:59'
      AND exit_reason != 'OPEN'
    GROUP BY DATE(entry_time), exit_reason
    ORDER BY trade_date ASC, count DESC
  `);
  console.table(exitReasons);

  console.log("\n=========================================================================");
  console.log("🏆 4. TOP WINNING & LOSING TRADES (LIVE ONLY: 2026-09-23 & 2026-09-24)");
  console.log("=========================================================================");
  const [topTrades] = await conn.query(`
    SELECT id, mt5_ticket, symbol, action, market_type,
           ROUND(entry_price, 5) as entry,
           ROUND(exit_price, 5) as exit_p,
           ROUND(pips, 1) as pips,
           ROUND(profit_loss, 2) as pnl,
           is_win, exit_reason,
           DATE_FORMAT(entry_time, '%Y-%m-%d %H:%i') as entry_bkk
    FROM trade_results
    WHERE entry_time >= '2026-09-23 00:00:00' 
      AND entry_time <= '2026-09-24 23:59:59'
      AND decision_mode = 'LIVE'
    ORDER BY profit_loss DESC
    LIMIT 10
  `);
  console.table(topTrades);

  const [cryptoDetails] = await conn.query(`
    SELECT 
      DATE(entry_time) as trade_date,
      symbol,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as pnl_usd
    FROM trade_results
    WHERE entry_time >= '2026-09-23 00:00:00' 
      AND entry_time <= '2026-09-24 23:59:59'
      AND market_type = 'crypto'
    GROUP BY DATE(entry_time), symbol
    ORDER BY trade_date ASC, trades DESC
  `);
  console.log("CRYPTO_DETAILS:");
  console.table(cryptoDetails);

  fs.writeFileSync('scripts/history_23_24.json', JSON.stringify({ byDateMarket, dailyAgg, exitReasons, topTrades, cryptoDetails }, null, 2), 'utf8');
  console.log("SUCCESSFULLY_SAVED_JSON");
  await conn.end();
}

main().catch(console.error);
