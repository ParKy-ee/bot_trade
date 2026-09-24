import { getOpenPositions, closePosition } from '../services/mt5Broker.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  console.log('🔄 Connecting to MT5 and fetching all open positions...');
  const mt5Res = await getOpenPositions();
  const positions = mt5Res?.positions || [];
  console.log(`Found ${positions.length} total position(s) on MT5:`);

  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trading_bot',
    port: Number(process.env.DB_PORT || 3306)
  });

  const forexAndMetalsAndCrypto = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
    'EURGBP', 'EURAUD', 'EURCHF', 'GBPAUD', 'GBPCAD', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY',
    'GOLD', 'XAUUSD', 'SILVER', 'XAGUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'
  ];

  let closedCount = 0;
  for (const pos of positions) {
    const symClean = String(pos.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
    const isStandard = forexAndMetalsAndCrypto.some(f => symClean.startsWith(f) || symClean === f);

    // If it is NOT standard Forex / Metal / Crypto, it is a Stock or index (e.g. advmicrodev, msft, etc.)
    if (!isStandard) {
      console.log(`🚨 [CLOSING STOCK] Ticket #${pos.ticket} | Symbol: ${pos.symbol} | Profit: $${pos.profit} | Vol: ${pos.volume}`);
      try {
        const closeRes = await closePosition(pos.ticket);
        console.log(`  -> Result:`, closeRes);
        closedCount++;
        await pool.query(
          "UPDATE active_positions SET status_note = 'CLOSED_MANUAL' WHERE mt5_ticket = ?",
          [pos.ticket]
        );
      } catch (err) {
        console.error(`  -> Failed to close #${pos.ticket}:`, err.message);
      }
    } else {
      console.log(`ℹ️ [KEEPING] Ticket #${pos.ticket} | Symbol: ${pos.symbol} (Forex/Gold/Crypto)`);
    }
  }

  console.log(`\n🎉 Finished closing ${closedCount} stock position(s)!`);
  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
