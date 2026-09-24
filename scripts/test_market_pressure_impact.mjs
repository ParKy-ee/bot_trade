import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("=== SIMULATING MARKET PRESSURE & INDECISION FILTER ON HISTORICAL TRADES ===");

  // Fetch closed trades and their entry bars from market_bars
  const [trades] = await conn.query(`
    SELECT t.id, t.symbol, t.action, t.entry_price, t.pips, t.is_win, t.exit_reason, t.entry_time
    FROM trade_results t
    WHERE t.id >= 8500 AND t.exit_time IS NOT NULL AND t.market_type IN ('forex', 'forex_shadow')
    ORDER BY t.id ASC
  `);
  console.log(`Analyzing ${trades.length} recent trades...`);

  let totalTrades = 0;
  let filteredTrades = 0;
  let filteredWins = 0;
  let filteredLosses = 0;
  let pipsSaved = 0;

  for (const t of trades) {
    // Get 6 bars up to entry_time
    const [bars] = await conn.query(`
      SELECT open, high, low, close, rsi, atr
      FROM market_bars
      WHERE symbol = ? AND time <= ?
      ORDER BY time DESC
      LIMIT 6
    `, [t.symbol, t.entry_time]);

    if (bars.length < 6) continue;
    totalTrades++;

    // Reverse to chronological order
    const chronBars = bars.reverse();
    const closes = chronBars.map(b => Number(b.close));
    const lastBar = chronBars[chronBars.length - 1];

    // 1. Kaufman Efficiency Ratio (KER) over 5 steps
    const netDisp = Math.abs(closes[5] - closes[0]);
    let path = 0;
    for (let i = 1; i < 6; i++) {
      path += Math.abs(closes[i] - closes[i - 1]);
    }
    const ker = path > 0 ? (netDisp / path) : 0;

    // 2. Candle Body vs Range
    const range = (Number(lastBar.high) - Number(lastBar.low)) || 0.0001;
    const body = Math.abs(Number(lastBar.close) - Number(lastBar.open));
    const bodyRatio = body / range;
    const upperWick = (Number(lastBar.high) - Math.max(Number(lastBar.close), Number(lastBar.open))) / range;
    const lowerWick = (Math.min(Number(lastBar.close), Number(lastBar.open)) - Number(lastBar.low)) / range;

    // Strict Indecision Criteria:
    // Extremely low efficiency (< 0.18) AND Doji-like thin body (< 0.25) with wicks on both sides
    const isExtremeIndecision = (ker < 0.18) && (bodyRatio < 0.25) && (upperWick > 0.25 && lowerWick > 0.25);

    if (isExtremeIndecision) {
      filteredTrades++;
      if (t.is_win === 1) {
        filteredWins++;
        pipsSaved -= Number(t.pips); // We missed a win
      } else {
        filteredLosses++;
        pipsSaved += Math.abs(Number(t.pips)); // We avoided a loss!
      }
    }
  }

  console.log(`\n--- RESULTS ---`);
  console.log(`Total Trades Tested: ${totalTrades}`);
  console.log(`Trades Filtered as Extreme Indecision: ${filteredTrades} (${((filteredTrades / totalTrades) * 100).toFixed(1)}%)`);
  console.log(`  • Avoided Losses: ${filteredLosses}`);
  console.log(`  • Missed Wins: ${filteredWins}`);
  console.log(`  • Net Pips Impact: ${pipsSaved > 0 ? '+' : ''}${pipsSaved.toFixed(1)} pips`);
  
  if (filteredTrades > 0) {
    const accuracy = (filteredLosses / filteredTrades) * 100;
    console.log(`  • Filter Accuracy (Losing Trades Caught): ${accuracy.toFixed(1)}%`);
  }

  await conn.end();
}

run().catch(console.error);
