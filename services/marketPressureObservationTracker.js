/**
 * Market Pressure Live Observation Tracker & Ground Truth Labeling Pipeline
 * 
 * Implements a continuous two-stage ML observation architecture:
 * 1. T0 Snapshot: Captures all 12 microstructure features + model prediction state in real-time.
 * 2. T+3 Forward Resolution: Automatically evaluates actual market outcome after 3 bars (15 mins)
 *    and scores whether the prediction was correct (Drift Detection & Active Learning).
 */

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Initializes the market_pressure_observations table if not exists.
 */
export async function initMarketPressureTable(pool) {
  if (!pool) return;
  const sql = `
    CREATE TABLE IF NOT EXISTS market_pressure_observations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      bar_time DATETIME NOT NULL,
      observed_at DATETIME NOT NULL,
      
      -- Microstructure & Order Flow Features (T0)
      close_price DECIMAL(12, 5) NOT NULL,
      atr DECIMAL(12, 5) NOT NULL,
      bop DECIMAL(8, 4) DEFAULT 0,
      body_ratio DECIMAL(8, 4) DEFAULT 0,
      upper_wick DECIMAL(8, 4) DEFAULT 0,
      lower_wick DECIMAL(8, 4) DEFAULT 0,
      wick_asym DECIMAL(8, 4) DEFAULT 0,
      rel_range DECIMAL(8, 4) DEFAULT 0,
      ker_3 DECIMAL(8, 4) DEFAULT 0,
      ker_5 DECIMAL(8, 4) DEFAULT 0,
      ker_10 DECIMAL(8, 4) DEFAULT 0,
      dir_disp_3 DECIMAL(8, 4) DEFAULT 0,
      dir_disp_5 DECIMAL(8, 4) DEFAULT 0,
      vol_skew DECIMAL(10, 4) DEFAULT 0,
      
      -- Prediction Outputs (T0)
      predicted_state VARCHAR(24) NOT NULL,
      prob_buy DECIMAL(6, 4) DEFAULT 0,
      prob_sell DECIMAL(6, 4) DEFAULT 0,
      prob_indecision DECIMAL(6, 4) DEFAULT 0,
      expected_net_pips DECIMAL(8, 2) DEFAULT 0,
      
      -- Forward Outcomes (T+3) (Populated after 3 bars / 15 mins)
      forward_close_3 DECIMAL(12, 5) NULL,
      forward_high_3 DECIMAL(12, 5) NULL,
      forward_low_3 DECIMAL(12, 5) NULL,
      actual_mfe_atr DECIMAL(8, 4) NULL,
      actual_mae_atr DECIMAL(8, 4) NULL,
      actual_return_atr DECIMAL(8, 4) NULL,
      actual_state VARCHAR(24) NULL,
      is_correct TINYINT(1) NULL,
      outcome_status VARCHAR(16) DEFAULT 'PENDING',
      labeled_at DATETIME NULL,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_symbol_bar (symbol, bar_time),
      INDEX idx_outcome (outcome_status, bar_time),
      INDEX idx_correct (is_correct, observed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await pool.query(sql);
  } catch (err) {
    console.warn('⚠️ [MarketPressureTracker] Init table warning:', err.message);
  }
}

/**
 * Records a real-time observation snapshot of Market Pressure at bar close (T0).
 */
export async function recordMarketPressureObservation({
  pool,
  symbol,
  barTime,
  pressureResult
}) {
  if (!pool || !pressureResult || !pressureResult.metrics) return false;

  const m = pressureResult.metrics;
  const probs = pressureResult.probabilities || {};
  const pips = pressureResult.pip_projections || {};

  const values = [
    symbol,
    new Date(barTime || Date.now()),
    new Date(),
    finiteNumber(m.close),
    finiteNumber(m.atr, 0.001),
    finiteNumber(m.bop),
    finiteNumber(m.body_ratio),
    finiteNumber(m.upper_wick),
    finiteNumber(m.lower_wick),
    finiteNumber(m.wick_asym || m.wick_asymmetry),
    finiteNumber(m.rel_range),
    finiteNumber(m.ker_3),
    finiteNumber(m.ker_5),
    finiteNumber(m.ker_10),
    finiteNumber(m.dir_disp_3),
    finiteNumber(m.dir_disp_5),
    finiteNumber(m.vol_skew),
    String(pressureResult.state || 'INDECISION_CHOP'),
    finiteNumber(probs.buy_pressure),
    finiteNumber(probs.sell_pressure),
    finiteNumber(probs.indecision),
    finiteNumber(pips.expected_net_pips)
  ];

  try {
    await pool.query(`
      INSERT INTO market_pressure_observations (
        symbol, bar_time, observed_at,
        close_price, atr, bop, body_ratio, upper_wick, lower_wick,
        wick_asym, rel_range, ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew,
        predicted_state, prob_buy, prob_sell, prob_indecision, expected_net_pips,
        outcome_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
      ON DUPLICATE KEY UPDATE
        observed_at = VALUES(observed_at),
        close_price = VALUES(close_price),
        atr = VALUES(atr),
        bop = VALUES(bop),
        body_ratio = VALUES(body_ratio),
        upper_wick = VALUES(upper_wick),
        lower_wick = VALUES(lower_wick),
        wick_asym = VALUES(wick_asym),
        rel_range = VALUES(rel_range),
        ker_3 = VALUES(ker_3),
        ker_5 = VALUES(ker_5),
        ker_10 = VALUES(ker_10),
        dir_disp_3 = VALUES(dir_disp_3),
        dir_disp_5 = VALUES(dir_disp_5),
        vol_skew = VALUES(vol_skew),
        predicted_state = VALUES(predicted_state),
        prob_buy = VALUES(prob_buy),
        prob_sell = VALUES(prob_sell),
        prob_indecision = VALUES(prob_indecision),
        expected_net_pips = VALUES(expected_net_pips)
    `, values);
    return true;
  } catch (err) {
    console.warn(`⚠️ [MarketPressureTracker] Failed to record observation for ${symbol}:`, err.message);
    return false;
  }
}

/**
 * Evaluates future 3 bars (T+3) for pending observations and labels ground truth.
 */
export async function labelMarketPressureObservations(pool, limit = 100) {
  if (!pool) return { labeled: 0, pending: 0 };

  const [pending] = await pool.query(`
    SELECT id, symbol, bar_time, close_price, atr, predicted_state
    FROM market_pressure_observations
    WHERE outcome_status = 'PENDING'
    ORDER BY bar_time ASC
    LIMIT ?
  `, [Math.max(1, Math.min(500, Number(limit) || 100))]);

  if (!pending || pending.length === 0) {
    return { labeled: 0, pending: 0 };
  }

  let labeledCount = 0;

  for (const obs of pending) {
    const close0 = Number(obs.close_price);
    const atr0 = Math.max(1e-5, Number(obs.atr));

    // Fetch next 3 consecutive bars after bar_time
    const [futureBars] = await pool.query(`
      SELECT time, open, high, low, close
      FROM market_bars
      WHERE symbol = ? AND time > ?
      ORDER BY time ASC
      LIMIT 3
    `, [obs.symbol, obs.bar_time]);

    if (!futureBars || futureBars.length < 3) {
      continue; // Not enough forward bars yet
    }

    const close3 = Number(futureBars[2].close);
    const high3 = Math.max(...futureBars.map(b => Number(b.high)));
    const low3 = Math.min(...futureBars.map(b => Number(b.low)));

    const fwdReturnAtr = Number(((close3 - close0) / atr0).toFixed(4));
    const maeAtr = Number(((close0 - low3) / atr0).toFixed(4));
    const mfeAtr = Number(((high3 - close0) / atr0).toFixed(4));

    // Ground Truth Labeling (Identical logic to training pipeline)
    let actualState = 'INDECISION_CHOP';
    if (fwdReturnAtr >= 0.40 && fwdReturnAtr >= maeAtr * 0.8) {
      actualState = 'BUY_PRESSURE';
    } else if (fwdReturnAtr <= -0.40 && Math.abs(fwdReturnAtr) >= mfeAtr * 0.8) {
      actualState = 'SELL_PRESSURE';
    }

    const isCorrect = (obs.predicted_state === actualState) ? 1 : 0;

    await pool.query(`
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
      WHERE id = ? AND outcome_status = 'PENDING'
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

    labeledCount++;
  }

  return { labeled: labeledCount, pending: pending.length - labeledCount };
}

/**
 * Computes rolling accuracy and model drift metrics for Market Pressure.
 */
export async function getMarketPressureDriftMetrics(pool, windowHours = 24) {
  if (!pool) return null;

  const [rows] = await pool.query(`
    SELECT
      COUNT(*) as total_samples,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct_predictions,
      ROUND(
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0),
        1
      ) as accuracy_pct,
      SUM(CASE WHEN predicted_state = 'BUY_PRESSURE' THEN 1 ELSE 0 END) as count_buy,
      SUM(CASE WHEN predicted_state = 'SELL_PRESSURE' THEN 1 ELSE 0 END) as count_sell,
      SUM(CASE WHEN predicted_state = 'INDECISION_CHOP' THEN 1 ELSE 0 END) as count_chop,
      ROUND(
        SUM(CASE WHEN predicted_state = 'BUY_PRESSURE' AND is_correct = 1 THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN predicted_state = 'BUY_PRESSURE' THEN 1 ELSE 0 END), 0),
        1
      ) as buy_precision_pct,
      ROUND(
        SUM(CASE WHEN predicted_state = 'SELL_PRESSURE' AND is_correct = 1 THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN predicted_state = 'SELL_PRESSURE' THEN 1 ELSE 0 END), 0),
        1
      ) as sell_precision_pct
    FROM market_pressure_observations
    WHERE outcome_status = 'LABELED'
      AND observed_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
  `, [Number(windowHours) || 24]);

  const stats = rows[0] || {};
  const isDriftWarning = stats.total_samples >= 30 && Number(stats.accuracy_pct) < 65.0;

  return {
    windowHours,
    totalSamples: Number(stats.total_samples || 0),
    correctPredictions: Number(stats.correct_predictions || 0),
    accuracyPct: Number(stats.accuracy_pct || 0),
    buyPrecisionPct: Number(stats.buy_precision_pct || 0),
    sellPrecisionPct: Number(stats.sell_precision_pct || 0),
    distribution: {
      buy: Number(stats.count_buy || 0),
      sell: Number(stats.count_sell || 0),
      chop: Number(stats.count_chop || 0)
    },
    isDriftWarning,
    statusText: (Number(stats.total_samples || 0) === 0)
      ? '⚪ No labeled samples yet (Accumulating data)'
      : (isDriftWarning
          ? `⚠️ Model Drift Detected (Accuracy ${stats.accuracy_pct}% < 65%)`
          : `🟢 Model Performance Stable (${stats.accuracy_pct}% accuracy)`)
  };
}
