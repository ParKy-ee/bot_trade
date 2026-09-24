import { predictConfidence } from '../services/modelPredictor.js';

async function test() {
  console.log('--- Testing AI Model Predictor Bridge ---');
  const dummyFeatures = {
    return_1d: 0.015,
    return_5d: 0.032,
    return_20d: 0.085,
    rsi_14: 58.4,
    roc_12: 4.5,
    macd_line: 1.2,
    macd_signal: 0.8,
    macd_hist: 0.4,
    dist_ema_20: 0.02,
    dist_ema_50: 0.05,
    dist_ema_200: 0.12,
    ema_trend_ratio: 1.03,
    atr_14: 3.5,
    atr_ratio: 1.05,
    bb_pband: 0.72,
    bb_width: 0.06,
    adx_14: 24.5,
    rvol: 1.35,
    dist_to_20d_high: 0.03,
    rs_20d: 0.045
  };

  const result = await predictConfidence(dummyFeatures);
  console.log('Prediction result:', result);
  if (result.confidence !== undefined) {
    console.log(`✅ Model Predictor works! Confidence: ${(result.confidence * 100).toFixed(2)}%`);
  }
}

test();
