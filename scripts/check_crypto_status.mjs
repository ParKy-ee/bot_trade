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
  console.log("🪙 1. Active Crypto Positions in Database & MT5");
  console.log("=========================================================================");
  const [positions] = await conn.query("SELECT * FROM active_positions WHERE market_type = 'crypto'");
  console.table(positions);

  console.log("\n=========================================================================");
  console.log("📜 2. Recent Crypto Trades in trade_results");
  console.log("=========================================================================");
  const [trades] = await conn.query(`
    SELECT id, mt5_ticket, symbol, action,
           ROUND(entry_price, 2) as entry,
           ROUND(exit_price, 2) as 'exit',
           ROUND(pips, 1) as pips,
           ROUND(profit_loss, 2) as pnl,
           exit_reason,
           DATE_FORMAT(entry_time, '%Y-%m-%d %H:%i') as entry_bkk,
           DATE_FORMAT(exit_time, '%Y-%m-%d %H:%i') as exit_bkk
    FROM trade_results
    WHERE market_type = 'crypto'
    ORDER BY id DESC
    LIMIT 6
  `);
  console.table(trades);

  console.log("\n=========================================================================");
  console.log("🧭 3. Recent Crypto Market Pressure Observations");
  console.log("=========================================================================");
  const [obs] = await conn.query(`
    SELECT id, symbol,
           DATE_FORMAT(bar_time, '%H:%i') as bar_bkk,
           DATE_FORMAT(observed_at, '%H:%i:%s') as observed_at,
           ROUND(close_price, 2) as price,
           ROUND(bop, 3) as bop,
           ROUND(ker_5, 3) as ker_5,
           ROUND(dir_disp_3, 3) as dir_disp_3,
           ROUND(vol_skew, 3) as vol_skew,
           predicted_state,
           ROUND(prob_buy * 100, 1) as 'buy_%',
           ROUND(prob_sell * 100, 1) as 'sell_%',
           ROUND(prob_indecision * 100, 1) as 'chop_%',
           ROUND(expected_net_pips, 1) as exp_pts,
           outcome_status,
           ROUND(forward_close_3, 2) as fwd_3_price,
           actual_state
    FROM market_pressure_observations
    WHERE symbol IN ('BTCUSD', 'ETHUSD', 'SOLUSD')
    ORDER BY id DESC
    LIMIT 10
  `);
  console.table(obs.reverse());

  await conn.end();

  console.log("\n=========================================================================");
  console.log("📋 4. Recent Crypto Scan Logs from Daemon");
  console.log("=========================================================================");
  try {
    const log = fs.readFileSync('C:/Users/GF/.gemini/antigravity-cli/brain/a41acaf4-f522-42b4-a44e-374e41acf2a6/.system_generated/tasks/task-1460.log', 'utf8');
    const lines = log.split('\n');
    const cryptoLines = lines.filter(l => l.includes('Crypto') || l.includes('BTC') || l.includes('ETH') || l.includes('คริปโท'));
    console.log(cryptoLines.slice(-30).join('\n'));
  } catch (err) {
    console.error("Error reading daemon log:", err.message);
  }
}

main().catch(console.error);
