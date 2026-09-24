import assert from 'node:assert/strict';
import { validateForexExitGeometry } from '../services/forexExitEngine.js';

assert.equal(validateForexExitGeometry({
  action: 'BUY', entryPrice: 1.1000, slPrice: 1.0980, tpPrice: 1.1040
}).valid, true);

assert.equal(validateForexExitGeometry({
  action: 'SELL', entryPrice: 1.1000, slPrice: 1.1020, tpPrice: 1.0960
}).valid, true);

assert.equal(validateForexExitGeometry({
  action: 'SELL', entryPrice: 1.1000, slPrice: 1.0980, tpPrice: 1.1040
}).valid, false);

assert.equal(validateForexExitGeometry({
  action: 'BUY', entryPrice: 1.1000, slPrice: 1.1020, tpPrice: 1.0960
}).valid, false);

console.log('Forex exit geometry tests passed.');
