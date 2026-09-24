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

  const [trades] = await conn.query(`
    SELECT t.id, t.symbol, t.action, t.entry_price, t.pips, t.is_win, t.exit_reason, t.entry_time
    FROM trade_results t
    WHERE t.id >= 8500 AND t.exit_time IS NOT NULL AND t.market_type IN ('forex', 'forex_shadow')
    ORDER BY t.id ASC
  `);

  let highKerWins = 0, highKerLoss = 0, highKerPips = 0;
  let midKerWins = 0, midKerLoss = 0, midKerPips = 0;
  let lowKerWins = 0, lowKerLoss = 0, lowKerPips = 0;

  for (const t of trades) {
    const [bars] = await conn.query(`
      SELECT open, high, low, close
      FROM market_bars
      WHERE symbol = ? AND time <= ?
      ORDER BY time DESC
      LIMIT 6
    `, [t.symbol, t.entry_time]);

    if (bars.length < 6) continue;
    const chron = bars.reverse();
    const closes = chron.map(b => Number(b.close));
    const netDisp = Math.abs(closes[5] - closes[0]);
    let path = 0;
    for (let i = 1; i < 6; i++) {
      path += Math.abs(closes[i] - closes[i - 1]);
    }
    const ker = path > 0 ? (netDisp / path) : 0;
    const pips = Number(t.pips);

    if (ker >= 0.50) {
      if (t.is_win === 1) highKerWins++; else highKerLoss++;
      highKerPips += pips;
    } else if (ker >= 0.25) {
      if (t.is_win === 1) midKerWins++; else midKerLoss++;
      midKerPips += pips;
    } else {
      if (t.is_win === 1) lowKerWins++; else lowKerLoss++;
      lowKerPips += pips;
    }
  }

  console.log("=== PERFORMANCE DISTRIBUTION BY KAUFMAN EFFICIENCY (KER) ===");
  console.log(`High KER (>= 0.50) - Strong Directional Push:`);
  console.log(`  Trades: ${highKerWins + highKerLoss} | Win Rate: ${((highKerWins / (highKerWins + highKerLoss)) * 100).toFixed(1)}% | Net Pips: ${highKerPips.toFixed(1)}`);

  console.log(`\nMid KER (0.25 - 0.49) - Steady / Controlled Trend:`);
  console.log(`  Trades: ${midKerWins + midKerLoss} | Win Rate: ${((midKerWins / (midKerWins + midKerLoss)) * 100).toFixed(1)}% | Net Pips: ${midKerPips.toFixed(1)}`);

  console.log(`\nLow KER (< 0.25) - Choppy / Noisy:`);
  console.log(`  Trades: ${lowKerWins + lowKerLoss} | Win Rate: ${((lowKerWins / (lowKerWins + lowKerLoss)) * 100).toFixed(1)}% | Net Pips: ${lowKerPips.toFixed(1)}`);

  await conn.end();
}

run().catch(console.error);
