import { getPool } from '../config/database.js';
import { EMA, RSI, ATR, BollingerBands, ADX, MACD } from 'technicalindicators';

const FEATURE_VERSION = 'crypto10-v1-reconstructed';
const SYMBOLS = new Set(['BTCUSD', 'ETHUSD', 'SOLUSD']);
const MT5_CLOCK_OFFSET_MINUTES = 180;

function timeMs(value) {
  return new Date(String(value).replace(' ', 'T') + 'Z').getTime();
}

function calculateFeatures(bars) {
  if (!bars || bars.length < 35) return null;
  const closes = bars.map(b => Number(b.close));
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const volumes = bars.map(b => Number(b.volume || 1));
  const n = closes.length;
  const ema20 = EMA.calculate({ period: 20, values: closes }).at(-1) || closes.at(-1);
  const ema50 = EMA.calculate({ period: 50, values: closes }).at(-1) || closes.at(-1);
  const ema200Period = Math.min(200, Math.floor(n * 0.9));
  const ema200 = EMA.calculate({ period: ema200Period, values: closes }).at(-1) || closes.at(-1);
  const rsi = RSI.calculate({ period: 14, values: closes }).at(-1) || 50;
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).at(-1) || closes.at(-1) * 0.005;
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes }).at(-1)?.adx || 20;

  const closedVolumes = volumes.slice(-21, -1);
  const avgVolume20 = closedVolumes.reduce((sum, value) => sum + value, 0) / (closedVolumes.length || 1);
  const lastClosedVol = volumes[n - 2] || volumes[n - 1] || 1;
  const volumeRatio = lastClosedVol / (avgVolume20 + 1e-9);
  const bandWidths = bb.map(b => (b.upper - b.lower) / (b.middle + 1e-9));
  const bbWidth = bandWidths.at(-1) || 0.01;
  const lastClose = closes.at(-1);
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).at(-1);

  return {
    ret_1: (lastClose - closes[n - 2]) / (closes[n - 2] || 1),
    ret_5: (lastClose - closes[Math.max(0, n - 6)]) / (closes[Math.max(0, n - 6)] || 1),
    rsi_14: rsi,
    atr_pct: atr / (lastClose || 1),
    adx_14: adx,
    ema_spread_20_50: (ema20 - ema50) / (lastClose || 1),
    ema_spread_50_200: (ema50 - ema200) / (lastClose || 1),
    macd_hist: (macd?.histogram || 0) / (lastClose || 1),
    volume_ratio: volumeRatio,
    bb_width: bbWidth
  };
}

function findFeatureBars(signal, bars) {
  const expectedMs = timeMs(signal.signal_time) + MT5_CLOCK_OFFSET_MINUTES * 60000;
  let best = null;
  for (let index = 0; index < bars.length; index += 1) {
    const deltaMinutes = Math.abs(timeMs(bars[index].bar_time) - expectedMs) / 60000;
    if (deltaMinutes > 10) continue;
    const priceError = Math.abs(Number(bars[index].close) - Number(signal.price)) / (Number(signal.price) || 1);
    const score = priceError * 1000 + deltaMinutes * 0.001;
    if (!best || score < best.score) best = { index, score, deltaMinutes, priceError };
  }
  if (!best) return null;
  const window = bars.slice(Math.max(0, best.index - 99), best.index + 1);
  return { bars: window, ...best };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = await getPool();
  const [signals] = await pool.query(
    `SELECT id, DATE_FORMAT(time, '%Y-%m-%d %H:%i:%s') AS signal_time,
            symbol, price, mt5_ticket
     FROM signals
     WHERE market_type='crypto' AND mt5_ticket IS NOT NULL
     ORDER BY id ASC`
  );
  const [bars] = await pool.query(
    `SELECT DATE_FORMAT(time, '%Y-%m-%d %H:%i:%s') AS bar_time,
            symbol, open, high, low, close, volume
     FROM market_bars
     WHERE market_type='crypto'
     ORDER BY symbol, time ASC`
  );
  const [trades] = await pool.query(
    `SELECT id, mt5_ticket, symbol, prediction_meta
     FROM trade_results
     WHERE market_type='crypto' AND mt5_ticket IS NOT NULL`
  );

  const barsBySymbol = new Map();
  for (const bar of bars) {
    if (!SYMBOLS.has(bar.symbol)) continue;
    if (!barsBySymbol.has(bar.symbol)) barsBySymbol.set(bar.symbol, []);
    barsBySymbol.get(bar.symbol).push(bar);
  }
  const tradeByTicket = new Map(trades.map(trade => [String(trade.mt5_ticket), trade]));
  const seen = new Set();
  let matched = 0;
  let updated = 0;
  let rejected = 0;
  const errors = [];

  for (const signal of signals) {
    const ticket = String(signal.mt5_ticket);
    if (seen.has(ticket)) continue;
    seen.add(ticket);
    const trade = tradeByTicket.get(ticket);
    const symbolBars = barsBySymbol.get(signal.symbol) || [];
    const located = findFeatureBars(signal, symbolBars);
    if (!trade || !located || located.bars.length < 35) {
      rejected += 1;
      continue;
    }
    // Avoid fabricating a feature vector when the stored market bar is not
    // close enough to the recorded execution price.
    if (located.priceError > 0.01) {
      rejected += 1;
      continue;
    }
    const features = calculateFeatures(located.bars);
    if (!features || Object.values(features).some(value => !Number.isFinite(Number(value)))) {
      rejected += 1;
      continue;
    }
    matched += 1;
    const oldMeta = (() => {
      try { return JSON.parse(trade.prediction_meta || '{}'); } catch { return {}; }
    })();
    const meta = {
      ...oldMeta,
      feature_version: FEATURE_VERSION,
      features,
      reconstruction: {
        source: 'market_bars',
        signal_id: signal.id,
        matched_bar_time: symbolBars[located.index].bar_time,
        mt5_clock_offset_minutes: MT5_CLOCK_OFFSET_MINUTES,
        price_error_pct: Number((located.priceError * 100).toFixed(4))
      }
    };
    if (apply) {
      await pool.query(
        `UPDATE trade_results
         SET prediction_meta=?
         WHERE id=? AND market_type='crypto'`,
        [JSON.stringify(meta), trade.id]
      );
      updated += 1;
    }
  }

  console.log(JSON.stringify({
    success: true,
    mode: apply ? 'apply' : 'dry-run',
    unique_signals: seen.size,
    matched,
    updated,
    rejected,
    feature_version: FEATURE_VERSION
  }));
  await pool.end();
}

main().catch(error => {
  console.error(JSON.stringify({ success: false, error: error.message }));
  process.exitCode = 1;
});
