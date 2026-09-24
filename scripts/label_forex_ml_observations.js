import { getPool } from '../config/database.js';
import { labelForexMlObservations } from '../services/forexMlObservationTracker.js';

const pool = await getPool();
try {
  const summary = await labelForexMlObservations(pool, 1000);
  console.log(JSON.stringify({ success: true, ...summary }));
} catch (err) {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
