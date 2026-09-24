import os
import sys
import json
import warnings

# Suppress sklearn / lightgbm warnings
warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "models", "dynamic_trailing_model.joblib")

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
        model_dict = joblib.load(MODEL_PATH)
        lgb_model = model_dict["lgb"]
        rf_model = model_dict["rf"]
        feature_cols = model_dict["features"]
    except Exception as e:
        print(json.dumps({"error": f"Failed to load model: {str(e)}"}))
        sys.exit(1)

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
        # data can be a dict of features or a list of dicts
        is_list = isinstance(data, list)
        items = data if is_list else [data]

        results = []
        for item in items:
            row_dict = {col: item.get(col, 0.0) for col in feature_cols}
            df = pd.DataFrame([row_dict]).fillna(0)
            p1 = float(lgb_model.predict_proba(df)[:, 1][0])
            p2 = float(rf_model.predict_proba(df)[:, 1][0])
            conf = float(0.5 * p1 + 0.5 * p2)
            results.append({
                "confidence": conf,
                "lgb_prob": p1,
                "rf_prob": p2
            })

        output = results if is_list else results[0]
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"error": f"Inference error: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
