import sys
import os
import json
import warnings

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "models", "forex_m5_model.joblib")

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
        rf_buy = bundle.get("rf_buy")
        xgb_buy = bundle.get("xgb_buy")
        cat_buy = bundle.get("cat_buy")

        lgb_sell = bundle.get("lgb_sell")
        rf_sell = bundle.get("rf_sell")
        xgb_sell = bundle.get("xgb_sell")
        cat_sell = bundle.get("cat_sell")
        model_version = bundle.get("version", "v1.2.0")

        feature_cols = bundle.get("features", [
            'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
            'ema_spread_20_50', 'macd_hist'
        ])
    except Exception as e:
        print(json.dumps({"error": f"Failed to load Forex model: {str(e)}"}))
        sys.exit(1)

    def calc_ensemble_prob(lgb, xgb, cat, rf, df):
        vals = []
        wts = []
        for m, w in [(lgb, 0.35), (xgb, 0.25), (cat, 0.25), (rf, 0.15)]:
            if m is not None:
                try:
                    p = float(m.predict_proba(df)[:, 1][0])
                    vals.append(p)
                    wts.append(w)
                except Exception:
                    pass
        if not vals:
            return 0.5
        total_w = sum(wts) or 1.0
        return sum(p * w for p, w in zip(vals, wts)) / total_w

    # Read payload from stdin or argument
    input_str = ""
    if len(sys.argv) > 1 and sys.argv[1] != "--check":
        input_str = sys.argv[1]
    else:
        input_str = sys.stdin.read().strip()

    if not input_str:
        print(json.dumps({"error": "No input features provided"}))
        sys.exit(1)

    try:
        data = json.loads(input_str)
        is_list = isinstance(data, list)
        items = data if is_list else [data]

        results = []
        for item in items:
            row_dict = {col: float(item.get(col, 0.0) or 0.0) for col in feature_cols}
            df = pd.DataFrame([row_dict]).fillna(0)

            # Predict BUY & SELL Scalp via Tri-Ensemble
            p_buy = float(calc_ensemble_prob(lgb_buy, xgb_buy, cat_buy, rf_buy, df))
            p_sell = float(calc_ensemble_prob(lgb_sell, xgb_sell, cat_sell, rf_sell, df))

            direction = item.get("direction", "BUY").upper()
            tot = p_buy + p_sell
            rel_buy = float(p_buy / tot) if tot > 0 else 0.5
            rel_sell = float(p_sell / tot) if tot > 0 else 0.5
            confidence = rel_buy if direction == "BUY" else rel_sell

            results.append({
                "confidence": round(confidence, 4),
                "rel_buy": round(rel_buy, 4),
                "rel_sell": round(rel_sell, 4),
                "raw_buy": round(p_buy, 4),
                "raw_sell": round(p_sell, 4),
                "direction": direction,
                "model": "forex_m5_ensemble",
                "model_version": model_version
            })

        output = results if is_list else results[0]
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"error": f"Inference error: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
