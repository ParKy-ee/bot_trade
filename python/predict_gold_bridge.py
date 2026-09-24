import sys
import os
import json
import warnings

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "models", "gold_m5_model.joblib")


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
        buy_model = bundle.get("buy_model")
        sell_model = bundle.get("sell_model")
        scaler = bundle.get("scaler")
        feature_cols = bundle.get("feature_cols", [
            'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
            'ema_spread_21_50', 'bb_width', 'asian_sweep',
            'session_num', 'dxy_slope_5', 'h1_trend_slope', 'fvg_bull_bear'
        ])
        version = bundle.get("version", "gold-v1.0.0")
    except Exception as e:
        print(json.dumps({"error": f"Failed to load Gold model: {str(e)}"}))
        sys.exit(1)

    try:
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            print(json.dumps({"error": "Empty input"}))
            sys.exit(1)

        data = json.loads(raw_input)
        records = [data] if isinstance(data, dict) else data

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
        X = df[feature_cols].values
        if scaler is not None:
            X = scaler.transform(X)

        prob_buys = buy_model.predict_proba(X)[:, 1] if buy_model is not None else np.full(len(X), 0.5)
        prob_sells = sell_model.predict_proba(X)[:, 1] if sell_model is not None else np.full(len(X), 0.5)

        results = []
        for i in range(len(records)):
            pb = float(prob_buys[i])
            ps = float(prob_sells[i])
            tot = pb + ps
            rel_buy = float(pb / tot) if tot > 0 else 0.5
            rel_sell = float(ps / tot) if tot > 0 else 0.5

            req_dir = records[i].get("direction")
            if req_dir:
                direction = str(req_dir).upper()
                confidence = rel_buy if direction == "BUY" else rel_sell
            else:
                if pb >= ps:
                    direction = "BUY"
                    confidence = rel_buy
                else:
                    direction = "SELL"
                    confidence = rel_sell

            results.append({
                "confidence": round(float(confidence), 4),
                "rel_buy": round(float(rel_buy), 4),
                "rel_sell": round(float(rel_sell), 4),
                "raw_buy": round(float(pb), 4),
                "raw_sell": round(float(ps), 4),
                "prob_buy": round(float(rel_buy), 4),
                "prob_sell": round(float(rel_sell), 4),
                "direction": direction,
                "model_version": version,
                "model": f"gold_ml_{version}"
            })

        if isinstance(data, dict):
            print(json.dumps(results[0]))
        else:
            print(json.dumps(results))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": f"Prediction error: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
