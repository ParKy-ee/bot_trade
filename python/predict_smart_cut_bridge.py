import os
import sys
import json
import warnings
import numpy as np

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'models', 'smart_early_cut_v1.0.0.joblib')

def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--check':
        if os.path.exists(MODEL_PATH):
            print(json.dumps({'status': 'ok', 'model_path': MODEL_PATH}))
            return 0
        print(json.dumps({'status': 'error', 'message': f'Model not found at {MODEL_PATH}'}))
        return 1

    try:
        import joblib
        import pandas as pd
    except ImportError as exc:
        print(json.dumps({'error': f'Import error: {exc}'}))
        return 1

    if not os.path.exists(MODEL_PATH):
        print(json.dumps({'error': f'Model file not found at {MODEL_PATH}'}))
        return 1

    try:
        bundle = joblib.load(MODEL_PATH)
        lgb_model = bundle['lgb_model']
        rf_model = bundle['rf_model']
        feature_cols = bundle['feature_cols']
        env_threshold = os.environ.get('FOREX_SMART_CUT_THRESHOLD')
        if env_threshold:
            operating_threshold = float(env_threshold)
        else:
            operating_threshold = 0.60
    except Exception as exc:
        print(json.dumps({'error': f'Failed to load Smart Cut model: {exc}'}))
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
            
            p_lgb = float(lgb_model.predict_proba(frame)[:, 1][0])
            p_rf = float(rf_model.predict_proba(frame)[:, 1][0])
            collapse_prob = 0.5 * p_lgb + 0.5 * p_rf
            rebound_prob = 1.0 - collapse_prob
            
            # Action Decision:
            # Only trigger EARLY_CUT if collapse_prob >= operating_threshold
            # Otherwise default to HOLD (protecting winning rebounds)
            should_cut = collapse_prob >= operating_threshold
            
            action = 'EARLY_CUT' if should_cut else 'HOLD'
            
            reason = (
                f"ML Smart Cut: Collapse Prob={collapse_prob*100:.1f}% >= {operating_threshold*100:.0f}% -> Confirm Fatal Reversal"
                if should_cut
                else f"ML Smart Cut: Rebound Prob={rebound_prob*100:.1f}% -> Normal Pullback / Retest (HOLD)"
            )

            results.append({
                'action': action,
                'should_cut': should_cut,
                'collapse_prob': round(collapse_prob, 4),
                'rebound_prob': round(rebound_prob, 4),
                'threshold_used': operating_threshold,
                'reason': reason,
                'model_version': bundle.get('version', 'smart-early-cut-v1.0.0')
            })

        print(json.dumps(results if is_list else results[0]))
        return 0
    except Exception as exc:
        print(json.dumps({'error': f'Inference error: {exc}'}))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
