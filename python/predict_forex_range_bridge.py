import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "models", "forex_range_model.joblib")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        if os.path.exists(MODEL_PATH):
            print(json.dumps({"status": "ok", "model_path": MODEL_PATH}))
            return 0
        print(json.dumps({"status": "error", "message": f"Model not found at {MODEL_PATH}"}))
        return 1
    try:
        import joblib
        import numpy as np
        import pandas as pd
    except ImportError as exc:
        print(json.dumps({"error": f"Import error: {exc}"}))
        return 1
    if not os.path.exists(MODEL_PATH):
        print(json.dumps({"error": f"Model file not found at {MODEL_PATH}"}))
        return 1
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"error": "No input features provided"}))
        return 1
    try:
        bundle = joblib.load(MODEL_PATH)
        data = json.loads(raw)
        items = data if isinstance(data, list) else [data]
        features = bundle["features"]
        output = []
        for item in items:
            frame = pd.DataFrame([{c: float(item.get(c, 0.0) or 0.0) for c in features}]).replace(
                [np.inf, -np.inf], np.nan
            ).fillna(0.0)
            p_buy = float(bundle["buy_model"].predict_proba(frame)[:, 1][0])
            p_sell = float(bundle["sell_model"].predict_proba(frame)[:, 1][0])
            direction = str(item.get("direction", "BUY")).upper()
            output.append({
                "confidence": round(p_buy if direction == "BUY" else p_sell, 4),
                "raw_buy": round(p_buy, 4),
                "raw_sell": round(p_sell, 4),
                "direction": direction,
                "model": "forex_range_random_forest",
                "model_version": bundle.get("version", "range-unknown"),
            })
        print(json.dumps(output if isinstance(data, list) else output[0]))
        return 0
    except Exception as exc:
        print(json.dumps({"error": f"Inference error: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
