import { initDatabase } from '../config/database.js';
import { executeScanCycle } from '../services/tradingEngine.js';

async function test() {
  console.log('--- Testing Single Market Scan Cycle ---');
  try {
    await initDatabase();
    const result = await executeScanCycle();
    console.log('Result:', JSON.stringify(result, null, 2));
    console.log('✅ Scan Cycle completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Scan Cycle failed:', err);
    process.exit(1);
  }
}

test();
