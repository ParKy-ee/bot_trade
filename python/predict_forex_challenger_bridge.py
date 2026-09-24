import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'models', 'forex_challenger_model.joblib')


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--check':
        if os.path.exists(MODEL_PATH):
            print(json.dumps({'status': 'ok', 'model_path': MODEL_PATH}))
            return 0
        print(json.dumps({'status': 'error', 'message': f'Model not found at {MODEL_PATH}'}))
        return 1

    try:
        import joblib
        import numpy as np
        import pandas as pd
    except ImportError as exc:
        print(json.dumps({'error': f'Import error: {exc}'}))
        return 1

    if not os.path.exists(MODEL_PATH):
        print(json.dumps({'error': f'Model file not found at {MODEL_PATH}'}))
        return 1

    try:
        bundle = joblib.load(MODEL_PATH)
        buy_model = bundle['buy_model']
        sell_model = bundle['sell_model']
        feature_cols = bundle['features']
        version = bundle.get('version', 'challenger-unknown')
    except Exception as exc:
        print(json.dumps({'error': f'Failed to load Forex Challenger model: {exc}'}))
        return 1

    input_str = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != '--check' else sys.stdin.read().strip()
    if not input_str:
        print(json.dumps({'error': 'No input features provided'}))
        return 1

    try:
        data = json.loads(input_str)
        is_list = isinstance(data, list)
        items = data if is_list else [data]
        results = []
        for item in items:
            row = {col: float(item.get(col, 0.0) or 0.0) for col in feature_cols}
            frame = pd.DataFrame([row]).replace([np.inf, -np.inf], np.nan).fillna(0.0)
            p_buy = float(buy_model.predict_proba(frame)[:, 1][0])
            p_sell = float(sell_model.predict_proba(frame)[:, 1][0])
            total = p_buy + p_sell
            rel_buy = p_buy / total if total > 0 else 0.5
            rel_sell = p_sell / total if total > 0 else 0.5
            direction = str(item.get('direction', 'BUY')).upper()
            results.append({
                'confidence': round(rel_buy if direction == 'BUY' else rel_sell, 4),
                'rel_buy': round(rel_buy, 4),
                'rel_sell': round(rel_sell, 4),
                'raw_buy': round(p_buy, 4),
                'raw_sell': round(p_sell, 4),
                'direction': direction,
                'model': 'forex_challenger_gradient_boosting',
                'model_version': version,
            })
        print(json.dumps(results if is_list else results[0]))
        return 0
    except Exception as exc:
        print(json.dumps({'error': f'Inference error: {exc}'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
