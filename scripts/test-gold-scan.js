import { executeGoldScanCycle } from '../services/goldEngine.js';

async function testGoldScan() {
  console.log('🧪 Starting Gold Engine M5 ML Scan Test...\n');
  const res = await executeGoldScanCycle();
  console.log('\n✅ Gold Scan Result:', JSON.stringify(res, null, 2));
  process.exit(0);
}

testGoldScan().catch(err => {
  console.error('❌ Error testing Gold scan:', err);
  process.exit(1);
});
