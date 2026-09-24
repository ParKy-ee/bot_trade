import { initDatabase } from '../config/database.js';
import { executeCryptoScanCycle } from '../services/cryptoEngine.js';

async function test() {
  console.log('--- Testing Crypto Parallel Scan & Binance Stream ---');
  try {
    await initDatabase();
    const result = await executeCryptoScanCycle();
    console.log('\n--- Crypto Scan Summary ---');
    console.log(`Success: ${result?.success}`);
    console.log(`Total results: ${result?.results?.length || 0}`);
    result?.results?.forEach(r => {
      console.log(`\nSymbol: ${r.symbol} | Status: ${r.status} | Action: ${r.action || 'NONE'} | Confidence: ${((r.confidence || 0) * 100).toFixed(1)}%`);
    });
    console.log('\n✅ ทดสอบสแกนตลาด Crypto ด้วย Binance Parallel สำเร็จเรียบร้อย!');
    process.exit(0);
  } catch (err) {
    console.error('❌ ทดสอบล้มเหลว:', err);
    process.exit(1);
  }
}

test();
