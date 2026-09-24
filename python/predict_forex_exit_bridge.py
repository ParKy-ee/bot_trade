import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'models', 'forex_exit_challenger_v1.1.0.joblib')


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
        model = bundle['model']
        feature_cols = bundle['feature_cols']
        version = bundle.get('version', 'Challenger-Exit-v1.1.0')
    except Exception as exc:
        print(json.dumps({'error': f'Failed to load Exit Challenger model: {exc}'}))
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
        action_names = {0: 'HOLD', 1: 'EARLY_CUT', 2: 'STALL_HARVEST'}

        for item in items:
            row = [float(item.get(col, 0.0) or 0.0) for col in feature_cols]
            X = np.array([row])
            probs = model.predict_proba(X)[0]
            
            # Match probability index with classes in model
            classes = list(model.classes_)
            prob_dict = {
                'hold': float(probs[classes.index(0)]) if 0 in classes else 0.0,
                'early_cut': float(probs[classes.index(1)]) if 1 in classes else 0.0,
                'stall_harvest': float(probs[classes.index(2)]) if 2 in classes else 0.0
            }
            pred_class = int(model.predict(X)[0])
            pred_action = action_names.get(pred_class, 'HOLD')

            results.append({
                'action': pred_action,
                'action_id': pred_class,
                'probabilities': prob_dict,
                'confidence': float(np.max(probs)),
                'version': version
            })

        print(json.dumps(results if is_list else results[0]))
        return 0
    except Exception as exc:
        print(json.dumps({'error': f'Prediction execution failed: {exc}'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
