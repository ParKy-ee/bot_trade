import { getPool, initDatabase } from '../config/database.js';
import { labelForexMlObservations } from '../services/forexMlObservationTracker.js';

const pool = await getPool();
try {
  await initDatabase();
  if (process.argv.includes('--relabel-v1')) {
    let lastId = 0;
    let scanned = 0;
    let labeled = 0;
    while (true) {
      const batch = await labelForexMlObservations(pool, 1000, { relabelLegacy: true, afterId: lastId });
      scanned += batch.scanned;
      labeled += batch.labeled;
      lastId = batch.lastId;
      if (batch.scanned < 1000) break;
    }
    console.log(JSON.stringify({ success: true, relabelLegacy: true, scanned, labeled, skipped: scanned - labeled }));
  } else {
    const summary = await labelForexMlObservations(pool, 1000);
    console.log(JSON.stringify({ success: true, ...summary }));
  }
} catch (err) {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
