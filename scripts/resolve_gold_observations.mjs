import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getRates } from '../services/mt5Broker.js';

dotenv.config();

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: 'root',
    database: 'ai_trading_db',
    timezone: '+07:00'
  });

  console.log("📥 Syncing Gold bars from MT5 to market_bars table...");
  const res = await getRates('GOLD', 'M5', 100);
  if (res && res.bars) {
    const values = res.bars.map(b => [
      b.time,
      'GOLD',
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume || b.tick_volume || 0,
      'gold'
    ]);
    await conn.query(`
      INSERT INTO market_bars (time, symbol, open, high, low, close, volume, market_type)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close), volume=VALUES(volume), market_type=VALUES(market_type)
    `, [values]);
    console.log(`✅ Inserted/Updated ${values.length} Gold bars into market_bars`);
  }

  // Now resolve Gold observations using the synced bars
  const [pending] = await conn.query(`
    SELECT id, symbol, bar_time, close_price, atr, predicted_state
    FROM market_pressure_observations
    WHERE symbol = 'GOLD'
    ORDER BY bar_time ASC
  `);

  console.log(`\nEvaluating ${pending.length} Gold observations against actual forward outcomes (T+3 bars / 15m)...`);

  for (const obs of pending) {
    const close0 = Number(obs.close_price);
    const atr0 = Math.max(1e-5, Number(obs.atr));

    const [futureBars] = await conn.query(`
      SELECT time, open, high, low, close
      FROM market_bars
      WHERE symbol = 'GOLD' AND time > ?
      ORDER BY time ASC
      LIMIT 3
    `, [obs.bar_time]);

    if (!futureBars || futureBars.length < 3) {
      continue;
    }

    const close3 = Number(futureBars[2].close);
    const high3 = Math.max(...futureBars.map(b => Number(b.high)));
    const low3 = Math.min(...futureBars.map(b => Number(b.low)));

    const fwdReturnAtr = Number(((close3 - close0) / atr0).toFixed(4));
    const maeAtr = Number(((close0 - low3) / atr0).toFixed(4));
    const mfeAtr = Number(((high3 - close0) / atr0).toFixed(4));

    let actualState = 'INDECISION_CHOP';
    if (fwdReturnAtr >= 0.40 && fwdReturnAtr >= maeAtr * 0.8) {
      actualState = 'BUY_PRESSURE';
    } else if (fwdReturnAtr <= -0.40 && Math.abs(fwdReturnAtr) >= mfeAtr * 0.8) {
      actualState = 'SELL_PRESSURE';
    }

    const isCorrect = (obs.predicted_state === actualState) ? 1 : 0;

    await conn.query(`
      UPDATE market_pressure_observations
      SET
        forward_close_3 = ?,
        forward_high_3 = ?,
        forward_low_3 = ?,
        actual_mfe_atr = ?,
        actual_mae_atr = ?,
        actual_return_atr = ?,
        actual_state = ?,
        is_correct = ?,
        outcome_status = 'LABELED',
        labeled_at = NOW()
      WHERE id = ?
    `, [
      close3,
      high3,
      low3,
      mfeAtr,
      maeAtr,
      fwdReturnAtr,
      actualState,
      isCorrect,
      obs.id
    ]);
  }

  // Query updated table
  const [updated] = await conn.query(`
    SELECT 
      id,
      DATE_FORMAT(bar_time, '%H:%i:%s') as bar_time,
      DATE_FORMAT(observed_at, '%H:%i:%s') as observed_at,
      ROUND(close_price, 2) as t0_price,
      ROUND(forward_close_3, 2) as t3_price,
      ROUND(forward_close_3 - close_price, 2) as delta_usd,
      predicted_state,
      ROUND(prob_buy * 100, 1) as buy_pct,
      ROUND(prob_sell * 100, 1) as sell_pct,
      ROUND(prob_indecision * 100, 1) as chop_pct,
      actual_state,
      ROUND(actual_return_atr, 2) as ret_atr,
      outcome_status,
      is_correct
    FROM market_pressure_observations
    WHERE symbol = 'GOLD'
      AND observed_at >= '2026-09-25 08:30:00'
    ORDER BY id ASC
  `);

  console.log("\n📊 RESULT AFTER GROUND TRUTH RESOLUTION (08:30 - PRESENT):");
  console.table(updated);

  const [summary] = await conn.query(`
    SELECT 
      COUNT(*) as total_obs,
      SUM(outcome_status = 'LABELED') as labeled_count,
      SUM(outcome_status = 'LABELED' AND is_correct = 1) as correct_count,
      ROUND(SUM(outcome_status = 'LABELED' AND is_correct = 1) * 100.0 / NULLIF(SUM(outcome_status = 'LABELED'), 0), 1) as accuracy_pct,
      SUM(outcome_status = 'PENDING') as pending_count
    FROM market_pressure_observations
    WHERE symbol = 'GOLD' AND observed_at >= '2026-09-25 08:30:00'
  `);
  console.log("\n🎯 SUMMARY ACCURACY:");
  console.table(summary);

  await conn.end();
  process.exit(0);
}

run().catch(console.error);
