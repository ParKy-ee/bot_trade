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

  // Query distinct interesting orders:
  // 1. Crypto loss (BTC/ETH/SOL)
  // 2. Forex Champion loss (EURUSD/GBPUSD/USDJPY)
  // 3. Forex Challenger loss
  // 4. Forex Range loss
  // 5. Crypto win
  // 6. Forex win
  const [selectedOrders] = await pool.query(`
    (SELECT * FROM trade_results WHERE market_type = 'crypto' AND is_win = 0 AND exit_reason = 'CLOSED_SL' ORDER BY id DESC LIMIT 3)
    UNION ALL
    (SELECT * FROM trade_results WHERE market_type = 'crypto' AND is_win = 1 ORDER BY id DESC LIMIT 2)
    UNION ALL
    (SELECT * FROM trade_results WHERE market_type = 'forex_shadow' AND model_source = 'forex_champion' AND is_win = 0 AND exit_reason = 'CLOSED_SL' ORDER BY id DESC LIMIT 3)
    UNION ALL
    (SELECT * FROM trade_results WHERE market_type = 'forex_shadow' AND model_source = 'forex_champion' AND is_win = 1 AND exit_reason = 'CLOSED_TP' ORDER BY id DESC LIMIT 2)
    UNION ALL
    (SELECT * FROM trade_results WHERE market_type = 'forex_shadow' AND model_source = 'forex_challenger' AND is_win = 0 AND exit_reason = 'CLOSED_SL' ORDER BY id DESC LIMIT 3)
    UNION ALL
    (SELECT * FROM trade_results WHERE market_type = 'forex_shadow' AND model_source = 'forex_challenger' AND is_win = 1 AND exit_reason = 'CLOSED_TP' ORDER BY id DESC LIMIT 2)
    UNION ALL
    (SELECT * FROM trade_results WHERE model_source = 'forex_range' AND is_win = 0 ORDER BY id DESC LIMIT 2)
    UNION ALL
    (SELECT * FROM trade_results WHERE model_source = 'forex_range' AND is_win = 1 ORDER BY id DESC LIMIT 2)
  `);

  console.log(`Found ${selectedOrders.length} selected trade cases.`);

  const detailedCases = [];
  for (const ord of selectedOrders) {
    // Get 6 candles before entry, all candles during trade, and 2 candles after exit
    const [bars] = await pool.query(`
      SELECT time, open, high, low, close, volume, rsi, atr
      FROM market_bars
      WHERE symbol = ? 
        AND time >= DATE_SUB(?, INTERVAL 45 MINUTE)
        AND time <= DATE_ADD(COALESCE(?, ?), INTERVAL 30 MINUTE)
      ORDER BY time ASC
    `, [ord.symbol, ord.entry_time, ord.exit_time, ord.entry_time]);

    // Parse filter_reasons
    let parsedFilters = [];
    try {
      parsedFilters = JSON.parse(ord.filter_reasons || '[]');
    } catch (e) {
      parsedFilters = [ord.filter_reasons];
    }

    detailedCases.push({
      trade_id: ord.id,
      ticket: ord.mt5_ticket,
      symbol: ord.symbol,
      market: ord.market_type,
      bot: ord.model_source,
      version: ord.model_version,
      action: ord.action,
      lot: ord.lot_size,
      entry_time: ord.entry_time,
      entry_price: ord.entry_price,
      sl_price: ord.sl_price,
      tp_price: ord.tp_price,
      exit_time: ord.exit_time,
      exit_price: ord.exit_price,
      exit_reason: ord.exit_reason,
      profit_loss: ord.profit_loss,
      pips: ord.pips,
      is_win: ord.is_win,
      duration_min: ord.hold_duration_minutes,
      confidence: ord.ai_confidence,
      rsi: ord.rsi,
      adx: ord.adx,
      macd_hist: ord.macd_hist,
      atr: ord.atr,
      filter_reasons: parsedFilters,
      candle_context: bars.map(b => ({
        time: b.time,
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.volume),
        rsi: Number(b.rsi),
        atr: Number(b.atr),
        body_type: b.close > b.open ? 'BULLISH' : (b.close < b.open ? 'BEARISH' : 'DOJI'),
        body_size: Math.abs(b.close - b.open),
        upper_wick: b.high - Math.max(b.open, b.close),
        lower_wick: Math.min(b.open, b.close) - b.low
      }))
    });
  }

  fs.writeFileSync('./scripts/detailed_trade_cases.json', JSON.stringify(detailedCases, null, 2), 'utf-8');
  console.log('Saved detailed_trade_cases.json successfully!');
  await pool.end();
}

run().catch(console.error);
