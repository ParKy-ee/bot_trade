const FEATURE_VERSION = 'forex13-v1';
const FEATURE_COLUMNS = [
  'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
  'ema_spread_20_50', 'macd_hist', 'csm_spread', 'h1_trend_slope',
  'is_jpy', 'time_sin_hour', 'time_cos_hour', 'spread_to_atr'
];

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sessionName(value) {
  const date = new Date(value || Date.now());
  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 7) return 'LATE_NIGHT';
  if (hour >= 7 && hour < 14) return 'ASIAN';
  if (hour >= 14 && hour < 19) return 'LONDON';
  return 'NY_OVERLAP';
}

export function buildForexFeatures({ bars = [], indicators = {}, symbol = '', csmSpread = 0, at = null }) {
  const n = bars.length;
  const current = bars[n - 1] || {};
  const prev = bars[n - 2] || current;
  const fiveAgo = bars[n - 6] || bars[0] || current;
  const price = finiteNumber(current.close, 0);
  const atr = finiteNumber(indicators.atr14 || indicators.atr, price * 0.005);
  const date = new Date(at || current.time || Date.now());
  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const isJpy = String(symbol).toUpperCase().includes('JPY') ? 1 : 0;
  const ema21 = finiteNumber(indicators.ema21 || indicators.ema20, price);
  const ema50 = finiteNumber(indicators.ema50, price);

  return {
    ret_1: price > 0 ? (price - finiteNumber(prev.close, price)) / finiteNumber(prev.close, price) : 0,
    ret_5: price > 0 ? (price - finiteNumber(fiveAgo.close, price)) / finiteNumber(fiveAgo.close, price) : 0,
    rsi_14: finiteNumber(indicators.rsi14 || indicators.rsi9, 50),
    atr_pct: price > 0 ? atr / price : 0,
    adx_14: finiteNumber(indicators.adx14 || indicators.adx, 20),
    ema_spread_20_50: price > 0 ? (ema21 - ema50) / price : 0,
    macd_hist: finiteNumber(indicators.macdHist || indicators.macd_hist, 0),
    csm_spread: finiteNumber(csmSpread, 0),
    h1_trend_slope: n >= 12 && finiteNumber(bars[n - 12]?.close, 0) !== 0
      ? 100 * (price - finiteNumber(bars[n - 12].close, price)) / finiteNumber(bars[n - 12].close, price)
      : 0,
    is_jpy: isJpy,
    time_sin_hour: Math.sin((2 * Math.PI * utcHour) / 24),
    time_cos_hour: Math.cos((2 * Math.PI * utcHour) / 24),
    spread_to_atr: (isJpy ? 0.02 : 0.00015) / (atr + 1e-12)
  };
}

export async function recordForexMlObservation({
  pool,
  symbol,
  barTime,
  dataSource = 'unknown',
  features,
  sampleKind = 'NO_TRADE',
  candidateAction = null,
  activeTrack = 'NONE',
  qualified = false,
  modelSignal = false,
  confluenceScore = 0,
  championConfidence = null,
  challengerConfidence = null,
  entryPrice = null,
  slPrice = null,
  tpPrice = null,
  reasons = []
}) {
  if (!pool || !symbol || !barTime || !features) return false;
  if (FEATURE_COLUMNS.some(column => !Number.isFinite(Number(features[column])))) return false;

  const values = [
    symbol,
    barTime,
    new Date(),
    String(dataSource || 'unknown'),
    FEATURE_VERSION,
    String(sampleKind || 'NO_TRADE'),
    ['BUY', 'SELL'].includes(String(candidateAction).toUpperCase()) ? String(candidateAction).toUpperCase() : null,
    String(activeTrack || 'NONE'),
    qualified ? 1 : 0,
    modelSignal ? 1 : 0,
    finiteNumber(confluenceScore),
    championConfidence === null ? null : finiteNumber(championConfidence),
    challengerConfidence === null ? null : finiteNumber(challengerConfidence),
    entryPrice === null ? null : finiteNumber(entryPrice),
    slPrice === null ? null : finiteNumber(slPrice),
    tpPrice === null ? null : finiteNumber(tpPrice),
    ...FEATURE_COLUMNS.map(column => finiteNumber(features[column])),
    sessionName(barTime),
    JSON.stringify(reasons || [])
  ];

  try {
    await pool.query(
      `INSERT IGNORE INTO forex_ml_observations (
        symbol, bar_time, observed_at, data_source, feature_version, sample_kind,
        candidate_action, active_track, qualified, model_signal, confluence_score,
        champion_confidence, challenger_confidence, entry_price, sl_price, tp_price,
        ret_1, ret_5, rsi_14, atr_pct, adx_14, ema_spread_20_50, macd_hist,
        csm_spread, h1_trend_slope, is_jpy, time_sin_hour, time_cos_hour,
        spread_to_atr, session_name, filter_reasons
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values
    );
    return true;
  } catch (err) {
    console.warn(`⚠️ [Forex ML Observation] บันทึก ${symbol} ไม่สำเร็จ:`, err.message);
    return false;
  }
}

export async function labelForexMlObservations(pool, limit = 250) {
  if (!pool) return { labeled: 0, pending: 0 };
  const [pending] = await pool.query(
    `SELECT * FROM forex_ml_observations
     WHERE outcome_status = 'PENDING'
     ORDER BY bar_time ASC LIMIT ?`,
    [Math.max(1, Math.min(1000, Number(limit) || 250))]
  );

  let labeled = 0;
  for (const sample of pending) {
    const [bars] = await pool.query(
      `SELECT time, high, low, close
       FROM market_bars
       WHERE symbol = ? AND time >= ? AND market_type = 'forex'
       ORDER BY time ASC LIMIT 6`,
      [sample.symbol, sample.bar_time]
    );
    if (bars.length < 6) continue;

    const entry = finiteNumber(sample.entry_price, finiteNumber(bars[0].close));
    const atrPrice = Math.max(1e-12, entry * finiteNumber(sample.atr_pct));
    const close5 = finiteNumber(bars[5].close, entry);
    const buy = sample.ret_1 >= 0 && (close5 - entry) >= 1.5 * atrPrice ? 1 : 0;
    const sell = sample.ret_1 <= 0 && (close5 - entry) <= -1.0 * atrPrice ? 1 : 0;

    await pool.query(
      `UPDATE forex_ml_observations
       SET outcome_status = 'LABELED', target_buy = ?, target_sell = ?,
           label_method = 'TRIPLE_BARRIER_V1', labeled_at = NOW()
       WHERE id = ? AND outcome_status = 'PENDING'`,
      [buy, sell, sample.id]
    );
    labeled += 1;
  }

  return { labeled, pending: pending.length - labeled };
}

export { FEATURE_COLUMNS, FEATURE_VERSION };
