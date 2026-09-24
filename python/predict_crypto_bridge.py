import sys
import os
import json
import warnings

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "models", "crypto_m5_model.joblib")

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        if os.path.exists(MODEL_PATH):
            print(json.dumps({"status": "ok", "model_path": MODEL_PATH}))
            sys.exit(0)
        else:
            print(json.dumps({"status": "error", "message": f"Model not found at {MODEL_PATH}"}))
            sys.exit(1)

    try:
        import joblib
        import pandas as pd
        import numpy as np
    except ImportError as e:
        print(json.dumps({"error": f"Import error: {str(e)}"}))
        sys.exit(1)

    if not os.path.exists(MODEL_PATH):
        print(json.dumps({"error": f"Model file not found at {MODEL_PATH}"}))
        sys.exit(1)

    try:
        bundle = joblib.load(MODEL_PATH)
        lgb_buy = bundle.get("lgb_buy")
        xgb_buy = bundle.get("xgb_buy")
        rf_buy = bundle.get("rf_buy")

        lgb_sell = bundle.get("lgb_sell")
        xgb_sell = bundle.get("xgb_sell")
        rf_sell = bundle.get("rf_sell")

        feature_cols = bundle.get("features", [
            'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
            'ema_spread_20_50', 'ema_spread_50_200', 'macd_hist',
            'volume_ratio', 'bb_width'
        ])
        version = bundle.get("version", "v1.0.0")
    except Exception as e:
        print(json.dumps({"error": f"Failed to load Crypto model: {str(e)}"}))
        sys.exit(1)

    def calc_ensemble_prob(lgb, xgb, rf, df):
        vals = []
        wts = []
        for m, w in [(lgb, 0.40), (xgb, 0.35), (rf, 0.25)]:
            if m is not None:
                try:
                    p = m.predict_proba(df)[:, 1]
                    vals.append(p)
                    wts.append(w)
                except Exception:
                    pass
        if not vals:
            return 0.5
        total_w = sum(wts)
        wts = [w / total_w for w in wts]
        res = sum(v * w for v, w in zip(vals, wts))
        return float(res[0])

    try:
        # Read JSON from stdin
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            print(json.dumps({"error": "Empty input"}))
            sys.exit(1)

        data = json.loads(raw_input)
        records = [data] if isinstance(data, dict) else data

        # Map and build DataFrame
        rows = []
        for item in records:
            row = {}
            for col in feature_cols:
                val = item.get(col, 0.0)
                try:
                    row[col] = float(val) if val is not None and not np.isnan(float(val)) else 0.0
                except (ValueError, TypeError):
                    row[col] = 0.0
            rows.append(row)

        df = pd.DataFrame(rows)

        # Predict BUY and SELL probabilities
        prob_buy = float(calc_ensemble_prob(lgb_buy, xgb_buy, rf_buy, df))
        prob_sell = float(calc_ensemble_prob(lgb_sell, xgb_sell, rf_sell, df))

        direction = records[0].get("direction", "BUY").upper()
        tot = prob_buy + prob_sell
        rel_buy = float(prob_buy / tot) if tot > 0 else 0.5
        rel_sell = float(prob_sell / tot) if tot > 0 else 0.5
        confidence = rel_buy if direction == "BUY" else rel_sell

        result = {
            "status": "ok",
            "version": version,
            "direction": direction,
            "confidence": round(float(confidence), 4),
            "rel_buy": round(float(rel_buy), 4),
            "rel_sell": round(float(rel_sell), 4),
            "raw_buy": round(float(prob_buy), 4),
            "raw_sell": round(float(prob_sell), 4),
            "model": f"crypto_tri_ensemble_{version}"
        }

        print(json.dumps(result))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": f"Prediction error: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
