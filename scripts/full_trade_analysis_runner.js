import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ai_trading_db',
    waitForConnections: true,
    connectionLimit: 10,
    timezone: '+07:00',
    decimalNumbers: true
  });

  console.log('--- 1. BOT / MODEL OVERVIEW ---');
  const [bots] = await pool.query(`
    SELECT 
      COALESCE(market_type, 'unknown') as market,
      COALESCE(model_source, 'legacy') as model_source,
      COALESCE(model_version, 'none') as model_version,
      COALESCE(decision_mode, 'LIVE') as decision_mode,
      COALESCE(source_tag, 'none') as source_tag,
      COUNT(*) as total_orders,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN exit_reason = 'OPEN' OR exit_price IS NULL THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as win,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as loss,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0), 2) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl,
      ROUND(AVG(profit_loss), 2) as avg_pnl,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) as profit_factor,
      ROUND(SUM(pips), 2) as total_pips,
      MIN(entry_time) as first_entry,
      MAX(entry_time) as last_entry
    FROM trade_results
    GROUP BY market_type, model_source, model_version, decision_mode, source_tag
    ORDER BY market, total_orders DESC
  `);
  console.table(bots);

  console.log('\n--- 2. EXIT REASONS & LOSS DISTRIBUTION ---');
  const [exitReasons] = await pool.query(`
    SELECT 
      market_type,
      COALESCE(model_source, 'legacy') as model_source,
      exit_reason,
      COUNT(*) as count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as win,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as loss,
      ROUND(SUM(profit_loss), 2) as total_pnl,
      ROUND(AVG(profit_loss), 2) as avg_pnl,
      ROUND(SUM(pips), 2) as total_pips
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    GROUP BY market_type, model_source, exit_reason
    ORDER BY market_type, model_source, count DESC
  `);
  console.table(exitReasons);

  console.log('\n--- 3. RECENT ORDERS WITH TECHNICAL METRICS (ENTRY CANDLE & INDICATORS) ---');
  const [recentOrders] = await pool.query(`
    SELECT 
      id,
      mt5_ticket,
      symbol,
      market_type,
      action,
      model_source,
      model_version,
      entry_time,
      entry_price,
      sl_price,
      tp_price,
      exit_time,
      exit_price,
      exit_reason,
      profit_loss,
      pips,
      is_win,
      ai_confidence,
      rsi,
      adx,
      macd_hist,
      atr,
      filter_reasons
    FROM trade_results
    ORDER BY id DESC
    LIMIT 30
  `);
  console.log(JSON.stringify(recentOrders, null, 2));

  console.log('\n--- 4. MARKET BARS SAMPLE FOR RECENT SYMBOLS ---');
  const [sampleBars] = await pool.query(`
    SELECT symbol, time, open, high, low, close, volume, rsi, atr
    FROM market_bars
    ORDER BY time DESC
    LIMIT 10
  `);
  console.table(sampleBars);

  await pool.end();
}

run().catch(console.error);
