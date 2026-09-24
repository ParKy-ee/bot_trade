import 'dotenv/config';
import { getRates } from '../services/mt5Broker.js';
import { FOREX_UNIVERSE } from '../services/marketData.js';
import { scanForexPatterns } from '../services/forexPatternEngine.js';

/** Read-only smoke test. It never calls placeOrder. */
for (const symbol of FOREX_UNIVERSE) {
  if (symbol === 'DX-Y.NYB') continue;
  const clean = symbol.replace('=X', '');
  try {
    const result = await getRates(clean, process.env.MT5_TIMEFRAME || 'M5', 100);
    const scan = scanForexPatterns(result?.bars || [], { symbol: clean, timeframe: 'M5' });
    console.log(`\n[${clean}] bars=${scan.bars} valid=${scan.valid} ATR=${Number(scan.atrPips || 0).toFixed(1)} pips`);
    if (!scan.valid) {
      console.log(`  reason=${scan.reason}`);
      continue;
    }
    console.log(`  pivots=${scan.pivots.length} levels=${scan.levels.length} patterns=${scan.patterns.length}`);
    for (const pattern of scan.patterns.slice(0, 8)) {
      console.log(`  ${pattern.confirmed ? '✅' : '⏳'} ${pattern.category}/${pattern.type} ${pattern.direction} score=${pattern.rankScore} age=${pattern.ageBars}`);
    }
  } catch (error) {
    console.error(`[${clean}] ERROR: ${error.message}`);
  }
}

