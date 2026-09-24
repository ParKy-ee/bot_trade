import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
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

  // 1. All models summary
  const [models] = await pool.query(`
    SELECT 
      COALESCE(market_type, 'unknown') as market_type,
      COALESCE(model_source, 'legacy') as model_source,
      COALESCE(model_version, 'none') as model_version,
      COALESCE(decision_mode, 'LIVE') as decision_mode,
      COUNT(*) as total_trades,
      SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END) as closed_trades,
      SUM(CASE WHEN exit_reason = 'OPEN' OR exit_price IS NULL THEN 1 ELSE 0 END) as open_trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN exit_reason != 'OPEN' AND exit_price IS NOT NULL THEN 1 ELSE 0 END), 0), 2) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl,
      ROUND(AVG(profit_loss), 2) as avg_pnl,
      ROUND(AVG(CASE WHEN is_win = 1 THEN profit_loss ELSE NULL END), 2) as avg_win,
      ROUND(AVG(CASE WHEN is_win = 0 THEN profit_loss ELSE NULL END), 2) as avg_loss,
      ROUND(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END) / NULLIF(ABS(SUM(CASE WHEN profit_loss < 0 THEN profit_loss ELSE 0 END)), 0), 2) as profit_factor,
      ROUND(SUM(pips), 2) as total_pips,
      ROUND(AVG(pips), 2) as avg_pips,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins,
      ROUND(AVG(ai_confidence) * 100, 1) as avg_conf_pct
    FROM trade_results
    GROUP BY market_type, model_source, model_version, decision_mode
    ORDER BY market_type, total_trades DESC
  `);

  // 2. Exit reasons breakdown per model
  const [exitDetails] = await pool.query(`
    SELECT 
      market_type,
      COALESCE(model_source, 'legacy') as model_source,
      exit_reason,
      COUNT(*) as trades_count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as win_count,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as loss_count,
      ROUND(SUM(profit_loss), 2) as sum_pnl,
      ROUND(AVG(profit_loss), 2) as avg_pnl,
      ROUND(SUM(pips), 2) as sum_pips,
      ROUND(AVG(hold_duration_minutes), 1) as avg_hold_mins
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    GROUP BY market_type, model_source, exit_reason
    ORDER BY market_type, model_source, trades_count DESC
  `);

  // 3. Loss analysis: correlation with RSI, ADX, Macro, and Session
  const [lossByIndicators] = await pool.query(`
    SELECT 
      model_source,
      CASE 
        WHEN rsi < 30 THEN 'RSI < 30 (Oversold)'
        WHEN rsi BETWEEN 30 AND 45 THEN 'RSI 30-45 (Bearish)'
        WHEN rsi BETWEEN 45 AND 55 THEN 'RSI 45-55 (Neutral)'
        WHEN rsi BETWEEN 55 AND 70 THEN 'RSI 55-70 (Bullish)'
        ELSE 'RSI > 70 (Overbought)'
      END as rsi_bracket,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND rsi IS NOT NULL
    GROUP BY model_source, rsi_bracket
    ORDER BY model_source, rsi_bracket
  `);

  const [lossByADX] = await pool.query(`
    SELECT 
      model_source,
      CASE 
        WHEN adx < 20 THEN 'ADX < 20 (Weak/Sideway)'
        WHEN adx BETWEEN 20 AND 30 THEN 'ADX 20-30 (Moderate Trend)'
        WHEN adx BETWEEN 30 AND 40 THEN 'ADX 30-40 (Strong Trend)'
        ELSE 'ADX > 40 (Very Strong Trend)'
      END as adx_bracket,
      COUNT(*) as trades,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as win_rate_pct,
      ROUND(SUM(profit_loss), 2) as total_pnl
    FROM trade_results
    WHERE exit_reason != 'OPEN' AND adx IS NOT NULL
    GROUP BY model_source, adx_bracket
    ORDER BY model_source, adx_bracket
  `);

  // 4. Sample detailed orders with candle context
  // Let's get 20 representative orders (recent wins, recent losses, different bots)
  const [ordersSample] = await pool.query(`
    SELECT 
      id,
      mt5_ticket,
      symbol,
      market_type,
      model_source,
      model_version,
      action,
      lot_size,
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
      hold_duration_minutes,
      ai_confidence,
      rsi,
      adx,
      macd_hist,
      atr,
      filter_reasons
    FROM trade_results
    WHERE exit_reason != 'OPEN'
    ORDER BY id DESC
    LIMIT 25
  `);

  // For each order in sample, fetch surrounding market_bars (3 candles before, up to 3 candles after/at exit)
  const orderDetailsWithCandles = [];
  for (const ord of ordersSample) {
    const entryDate = new Date(ord.entry_time);
    const exitDate = ord.exit_time ? new Date(ord.exit_time) : entryDate;

    // fetch bars around entry
    const [bars] = await pool.query(`
      SELECT time, open, high, low, close, volume, rsi, atr
      FROM market_bars
      WHERE symbol = ? 
        AND time >= DATE_SUB(?, INTERVAL 30 MINUTE)
        AND time <= DATE_ADD(?, INTERVAL 30 MINUTE)
      ORDER BY time ASC
    `, [ord.symbol, ord.entry_time, ord.exit_time || ord.entry_time]);

    orderDetailsWithCandles.push({
      order: ord,
      candle_count: bars.length,
      candles: bars
    });
  }

  const resultData = {
    models,
    exitDetails,
    lossByIndicators,
    lossByADX,
    orderDetailsWithCandles
  };

  fs.writeFileSync('./scripts/analysis_output.json', JSON.stringify(resultData, null, 2), 'utf-8');
  console.log('Saved analysis_output.json successfully!');
  await pool.end();
}

run().catch(console.error);
