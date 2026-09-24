"""
Inference Bridge for Market Pressure & Indecision Model
Reads bar data via CLI argument (JSON string) and returns prediction probabilities, regime state, and pip projections.
"""

import os
import sys
import json
import warnings
import joblib
import numpy as np

warnings.filterwarnings('ignore')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, 'python', 'models', 'forex_market_pressure_v1.0.0.joblib')

_cached_model = None

def get_model():
    global _cached_model
    if _cached_model is None:
        if not os.path.exists(MODEL_PATH):
            raise FileNotFoundError(f"Model not found at {MODEL_PATH}")
        _cached_model = joblib.load(MODEL_PATH)
    return _cached_model

def extract_features(bars):
    """
    bars: list of dicts with keys: open, high, low, close, volume, rsi, atr (at least 11 bars)
    """
    if len(bars) < 11:
        raise ValueError(f"Need at least 11 bars for feature calculation, received {len(bars)}")
        
    closes = np.array([float(b['close']) for b in bars])
    opens = np.array([float(b['open']) for b in bars])
    highs = np.array([float(b['high']) for b in bars])
    lows = np.array([float(b['low']) for b in bars])
    vols = np.array([float(b.get('volume', 1)) for b in bars])
    atrs = np.array([float(b.get('atr', 0.0010)) for b in bars])

    # Current bar is the last bar
    idx = -1
    c_close = closes[idx]
    c_open = opens[idx]
    c_high = highs[idx]
    c_low = lows[idx]
    c_atr = max(atrs[idx], 1e-5)
    c_range = max(c_high - c_low, 1e-5)
    c_body = abs(c_close - c_open)

    # 1. Bar Anatomy
    bop = float(np.clip((c_close - c_open) / c_range, -1.0, 1.0))
    body_ratio = float(np.clip(c_body / c_range, 0.0, 1.0))
    upper_wick = float(np.clip((c_high - max(c_close, c_open)) / c_range, 0.0, 1.0))
    lower_wick = float(np.clip((min(c_close, c_open) - c_low) / c_range, 0.0, 1.0))
    wick_asym = float(lower_wick - upper_wick)

    # 2. Normalized Range
    rel_range = float(np.clip(c_range / c_atr, 0.0, 5.0))

    # 3. Kaufman Efficiency Ratios
    # 3-bars
    net_3 = abs(closes[-1] - closes[-4])
    path_3 = sum(abs(closes[-i] - closes[-i-1]) for i in range(1, 4))
    ker_3 = float(np.clip(net_3 / max(path_3, 1e-5), 0.0, 1.0))

    # 5-bars
    net_5 = abs(closes[-1] - closes[-6])
    path_5 = sum(abs(closes[-i] - closes[-i-1]) for i in range(1, 6))
    ker_5 = float(np.clip(net_5 / max(path_5, 1e-5), 0.0, 1.0))

    # 10-bars
    net_10 = abs(closes[-1] - closes[-11])
    path_10 = sum(abs(closes[-i] - closes[-i-1]) for i in range(1, 11))
    ker_10 = float(np.clip(net_10 / max(path_10, 1e-5), 0.0, 1.0))

    # 4. Normalized Directional Displacement
    dir_disp_3 = float(np.clip((closes[-1] - closes[-4]) / c_atr, -5.0, 5.0))
    dir_disp_5 = float(np.clip((closes[-1] - closes[-6]) / c_atr, -5.0, 5.0))

    # 5. Volume Skew
    mid_point = (c_high + c_low) / 2.0
    pos_in_range = float(np.clip((c_close - mid_point) / (c_range / 2.0), -1.0, 1.0))
    vol_skew = float(pos_in_range * np.log1p(max(vols[idx], 1.0)))

    feature_vector = [
        bop, body_ratio, upper_wick, lower_wick, wick_asym,
        rel_range, ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew
    ]

    metrics = {
        "bop": round(bop, 3),
        "ker_5": round(ker_5, 3),
        "wick_asymmetry": round(wick_asym, 3),
        "rel_range": round(rel_range, 2),
        "atr": c_atr,
        "close": c_close
    }

    return np.array([feature_vector]), metrics

def predict(bars, symbol="EURUSD=X"):
    model = get_model()
    X, metrics = extract_features(bars)
    
    probs = model.predict_proba(X)[0] # [P(0: Indecision), P(1: Buy), P(2: Sell)]
    pred_class = int(np.argmax(probs))
    
    p_indecision = float(probs[0])
    p_buy = float(probs[1])
    p_sell = float(probs[2])

    if p_buy >= 0.42 and p_buy > p_sell:
        state = "BUY_PRESSURE"
    elif p_sell >= 0.42 and p_sell > p_buy:
        state = "SELL_PRESSURE"
    else:
        state = "INDECISION_CHOP"

    # PIP PROJECTIONS CALCULATION
    is_jpy = "JPY" in str(symbol).upper()
    pip_size = 0.01 if is_jpy else 0.0001
    atr_pips = metrics['atr'] / pip_size
    ker = metrics['ker_5']

    # 1. Expected Net Pips over forward 3-6 bars
    # Formula: Directional Probability Imbalance * Trend Efficiency * ATR in Pips * Scaling Factor
    net_prob_diff = p_buy - p_sell
    expected_pips = float(np.clip(net_prob_diff * max(ker, 0.25) * atr_pips * 2.2, -50.0, 50.0))

    # 2. Dynamic TP Multiplier (Scale from 0.8x up to 1.8x ATR)
    if state == "BUY_PRESSURE":
        rec_tp_mult = float(np.clip(0.85 + (p_buy - 0.33) * 2.2, 0.9, 1.8))
        rec_sl_mult = float(np.clip(0.85 - (0.33 - p_sell) * 0.8, 0.65, 0.9))
    elif state == "SELL_PRESSURE":
        rec_tp_mult = float(np.clip(0.85 + (p_sell - 0.33) * 2.2, 0.9, 1.8))
        rec_sl_mult = float(np.clip(0.85 - (0.33 - p_buy) * 0.8, 0.65, 0.9))
    else: # INDECISION_CHOP
        rec_tp_mult = 0.75 # Quick scalp
        rec_sl_mult = 0.85

    tp_target_pips = round(rec_tp_mult * atr_pips, 1)
    sl_target_pips = round(rec_sl_mult * atr_pips, 1)
    rr_ratio = round(rec_tp_mult / rec_sl_mult, 2)

    return {
        "state": state,
        "raw_predicted_class": pred_class,
        "probabilities": {
            "indecision": round(p_indecision, 4),
            "buy_pressure": round(p_buy, 4),
            "sell_pressure": round(p_sell, 4)
        },
        "pip_projections": {
            "atr_pips": round(atr_pips, 1),
            "expected_net_pips": round(expected_pips, 2),
            "recommended_tp_atr_mult": round(rec_tp_mult, 2),
            "recommended_sl_atr_mult": round(rec_sl_mult, 2),
            "dynamic_tp_pips": tp_target_pips,
            "dynamic_sl_pips": sl_target_pips,
            "projected_rr_ratio": rr_ratio
        },
        "metrics": {
            "bop": metrics['bop'],
            "ker_5": metrics['ker_5'],
            "wick_asymmetry": metrics['wick_asymmetry'],
            "rel_range": metrics['rel_range']
        }
    }

if __name__ == '__main__':
    raw_input = None
    symbol = "EURUSD=X"
    if len(sys.argv) >= 2:
        raw_input = sys.argv[1]
        if len(sys.argv) > 2:
            symbol = sys.argv[2]
    else:
        raw_input = sys.stdin.read().strip()

    if not raw_input:
        print(json.dumps({"error": "No input payload provided"}))
        sys.exit(1)
        
    try:
        input_data = json.loads(raw_input)
        if isinstance(input_data, dict) and 'bars' in input_data:
            symbol = input_data.get('symbol', symbol)
            input_data = input_data['bars']
        result = predict(input_data, symbol)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
