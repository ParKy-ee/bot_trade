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

export async function labelForexMlObservations(pool, limit = 250, { relabelLegacy = false, afterId = 0 } = {}) {
  if (!pool) return { labeled: 0, pending: 0 };
  const [pending] = await pool.query(
    `SELECT * FROM forex_ml_observations
     WHERE ${relabelLegacy ? "label_method = 'TRIPLE_BARRIER_V1' AND id > ?" : "outcome_status = 'PENDING'"}
     ORDER BY ${relabelLegacy ? 'id' : 'bar_time'} ASC LIMIT ?`,
    relabelLegacy
      ? [afterId, Math.max(1, Math.min(1000, Number(limit) || 250))]
      : [Math.max(1, Math.min(1000, Number(limit) || 250))]
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
    const barTime = new Date(sample.bar_time).getTime();
    if (!Number.isFinite(barTime) || new Date(bars[0].time).getTime() !== barTime) continue;
    const gap = bars.some((bar, i) => new Date(bar.time).getTime() !== barTime + i * 300000);
    const bid = Number(bars[0].close);
    const atrPrice = bid * Number(sample.atr_pct);
    if (!Number.isFinite(bid) || !Number.isFinite(atrPrice) || atrPrice <= 0) continue;
    // MT5 candles are bid OHLC. Estimate ask with the same fixed spread used
    // by the captured spread_to_atr feature.
    const spread = String(sample.symbol).toUpperCase().includes('JPY') ? 0.02 : 0.00015;
    const outcomes = { BUY: 'TIMEOUT', SELL: 'TIMEOUT' };
    for (const bar of gap ? [] : bars.slice(1)) {
      const high = Number(bar.high);
      const low = Number(bar.low);
      if (!Number.isFinite(high) || !Number.isFinite(low)) {
        outcomes.BUY = outcomes.SELL = 'AMBIGUOUS';
        break;
      }
      if (outcomes.BUY === 'TIMEOUT') {
        const tp = high >= bid + spread + 1.5 * atrPrice;
        const sl = low <= bid + spread - atrPrice;
        if (tp || sl) outcomes.BUY = tp && sl ? 'AMBIGUOUS' : tp ? 'WIN' : 'LOSS';
      }
      if (outcomes.SELL === 'TIMEOUT') {
        const tp = low + spread <= bid - 1.5 * atrPrice;
        const sl = high + spread >= bid + atrPrice;
        if (tp || sl) outcomes.SELL = tp && sl ? 'AMBIGUOUS' : tp ? 'WIN' : 'LOSS';
      }
      if (outcomes.BUY !== 'TIMEOUT' && outcomes.SELL !== 'TIMEOUT') break;
    }
    const state = gap || outcomes.BUY === 'AMBIGUOUS' || outcomes.SELL === 'AMBIGUOUS' ||
      (outcomes.BUY === 'WIN' && outcomes.SELL === 'WIN')
      ? 'AVOID'
      : outcomes.BUY === 'WIN' ? 'BUY'
        : outcomes.SELL === 'WIN' ? 'SELL' : 'NO_TRADE';
    const buy = state === 'BUY' ? 1 : 0;
    const sell = state === 'SELL' ? 1 : 0;

    await pool.query(
      `UPDATE forex_ml_observations
       SET outcome_status = 'LABELED', target_buy = ?, target_sell = ?, market_state = ?,
           label_method = 'FIRST_TOUCH_V2', labeled_at = NOW()
       WHERE id = ? AND ${relabelLegacy ? "label_method = 'TRIPLE_BARRIER_V1'" : "outcome_status = 'PENDING'"}`,
      [buy, sell, state, sample.id]
    );
    labeled += 1;
  }

  return { labeled, pending: pending.length - labeled, scanned: pending.length, lastId: pending.at(-1)?.id ?? afterId };
}

export { FEATURE_COLUMNS, FEATURE_VERSION };
