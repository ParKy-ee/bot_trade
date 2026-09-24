import { executeForexScanCycle } from '../services/forexEngine.js';
import { executeGoldScanCycle } from '../services/goldEngine.js';
import { executeCryptoScanCycle } from '../services/cryptoEngine.js';

async function runAllScansConcurrent() {
  console.log('========================================================================');
  console.log('🌐 [PARALLEL MULTI-MARKET SCAN TEST: FOREX + GOLD + CRYPTO]');
  console.log(`🕒 Started at: ${new Date().toISOString()}`);
  console.log('========================================================================\n');

  const startTime = Date.now();

  const [forexRes, goldRes, cryptoRes] = await Promise.allSettled([
    executeForexScanCycle(),
    executeGoldScanCycle(),
    executeCryptoScanCycle()
  ]);

  const elapsedMs = Date.now() - startTime;

  console.log('\n========================================================================');
  console.log(`🏁 สแกนทุกตลาดเสร็จสิ้นพร้อมกันในเวลา: ${(elapsedMs / 1000).toFixed(2)} วินาที (${elapsedMs} ms)`);
  console.log('========================================================================');
  console.log('📈 Forex Scan Status:', forexRes.status === 'fulfilled' ? '✅ SUCCESS' : `❌ ERROR: ${forexRes.reason?.message}`);
  console.log('🥇 Gold Scan Status :', goldRes.status === 'fulfilled' ? '✅ SUCCESS' : `❌ ERROR: ${goldRes.reason?.message}`);
  console.log('🪙 Crypto Scan Status:', cryptoRes.status === 'fulfilled' ? '✅ SUCCESS' : `❌ ERROR: ${cryptoRes.reason?.message}`);
  console.log('========================================================================\n');

  process.exit(0);
}

runAllScansConcurrent().catch(err => {
  console.error('❌ Error during multi-market scan test:', err);
  process.exit(1);
});
