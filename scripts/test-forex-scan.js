import { initDatabase } from '../config/database.js';
import { executeForexScanCycle } from '../services/forexEngine.js';

async function test() {
  console.log('--- Testing Forex Market Scan with 1st-Stage Filter ---');
  try {
    await initDatabase();
    const result = await executeForexScanCycle();
    console.log('\n--- Scan Summary ---');
    console.log(`Total pairs scanned: ${result.results?.length || 0}`);
    result.results?.forEach(r => {
      console.log(`\nPair: ${r.cleanName} | Status: ${r.qualified ? r.bias : 'CHOP / REJECTED'} | Confidence: ${(r.confidence * 100).toFixed(1)}%`);
      r.reasons.forEach(reason => console.log(`   ${reason}`));
    });
    console.log('\n✅ ทดสอบสแกนตลาด Forex และ 1st-Stage Filter สำเร็จเรียบร้อย!');
    process.exit(0);
  } catch (err) {
    console.error('❌ ทดสอบล้มเหลว:', err);
    process.exit(1);
  }
}

test();
