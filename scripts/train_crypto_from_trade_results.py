import json
import os
import re
import sys
import urllib.request

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, roc_auc_score
from xgboost import XGBClassifier

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_DATA = os.path.join(ROOT_DIR, 'data', 'dataset_crypto_m5.csv')
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
MODEL_PATH = os.path.join(MODEL_DIR, 'crypto_m5_model.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'crypto_model_registry.json')
FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'ema_spread_50_200', 'macd_hist',
    'volume_ratio', 'bb_width',
    'btc_ret_5', 'btc_corr_divergence', 'is_weekend',
    'vwap_distance_pct', 'distance_to_swing_high_low', 'funding_window_proximity'
]


def metric(y_true, y_prob):
    return {
        'roc_auc': round(float(roc_auc_score(y_true, y_prob)), 4),
        'pr_auc': round(float(average_precision_score(y_true, y_prob)), 4)
    } if len(np.unique(y_true)) > 1 else {'roc_auc': 0.5, 'pr_auc': 0.0}


def next_version(current):
    match = re.match(r'^v(\d+)\.(\d+)\.(\d+)$', str(current or 'v1.0.0'))
    if not match:
        return 'v2.1.0'
    major, minor, _patch = map(int, match.groups())
    return f'v{major}.{minor + 1}.0'


def load_trade_results():
    url = os.environ.get(
        'CRYPTO_TRADE_RESULTS_API_URL',
        'http://localhost:3000/api/trade-results?market=crypto&ready_for_retrain=true&limit=5000'
    )
    req = urllib.request.Request(url, headers={'User-Agent': 'trade-bot-crypto-retrainer'})
    with urllib.request.urlopen(req, timeout=15) as response:
        rows = json.loads(response.read().decode('utf-8'))

    live_rows = []
    ambiguous_rows_excluded = 0
    recovered_rows = 0
    for row in rows if isinstance(rows, list) else []:
        try:
            meta = json.loads(row.get('prediction_meta') or '{}')
            features = meta.get('features') or {}
            if row.get('action') not in ('BUY', 'SELL') or row.get('is_win') is None:
                continue
            exit_reason = str(row.get('exit_reason') or '')
            profit_loss = float(row['profit_loss']) if row.get('profit_loss') is not None else None
            # Exclude the small set of execution/label conflicts where the
            # broker exit reason contradicts the realized P/L label.
            if (
                (exit_reason == 'CLOSED_SL' and profit_loss is not None and profit_loss > 0)
                or (exit_reason == 'CLOSED_TP' and profit_loss is not None and profit_loss < 0)
            ):
                ambiguous_rows_excluded += 1
                continue
            item = {key: float(features.get(key, 0.0) if features.get(key) is not None else 0.0) for key in FEATURE_COLS}
            is_valid_win = int(row.get('is_win') == 1 and (profit_loss is None or profit_loss > 0.20))
            item['target_buy'] = int(row['action'] == 'BUY' and is_valid_win)
            item['target_sell'] = int(row['action'] == 'SELL' and is_valid_win)
            item['entry_time'] = row.get('entry_time')
            live_rows.append(item)
            recovered_rows += int(bool(meta.get('recovered')))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    result = pd.DataFrame(live_rows)
    result.attrs['raw_rows'] = len(rows) if isinstance(rows, list) else 0
    result.attrs['ambiguous_rows_excluded'] = ambiguous_rows_excluded
    result.attrs['recovered_rows'] = recovered_rows
    return result


def train_crypto_from_results():
    if not os.path.exists(BASE_DATA):
        raise FileNotFoundError(BASE_DATA)

    base = pd.read_csv(BASE_DATA)
    base = base.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).copy()
    live = load_trade_results()
    ambiguous_rows_excluded = int(live.attrs.get('ambiguous_rows_excluded', 0))
    recovered_rows = int(live.attrs.get('recovered_rows', 0))
    if len(live) < 10:
        raise RuntimeError(
            f'Need at least 10 feature-complete closed Crypto trades; found {len(live)}. '
            'Recovered legacy tickets are kept for evaluation but are excluded until raw features exist.'
        )

    cols = FEATURE_COLS + ['target_buy', 'target_sell']
    base_split = max(1, int(len(base) * 0.8))
    base_train = base[cols].iloc[:base_split]
    base_test = base[cols].iloc[base_split:]

    live_split = max(1, int(len(live) * 0.8))
    live_train = live[cols].iloc[:live_split]
    live_test = live[cols].iloc[live_split:]

    live_train_weighted = pd.concat([live_train] * 5, ignore_index=True)
    train = pd.concat([base_train, live_train_weighted], ignore_index=True)
    test = pd.concat([base_test, live_test], ignore_index=True)

    def fit_pair(target):
        y_train = train[target]
        y_test = test[target]
        lgb = LGBMClassifier(n_estimators=130, learning_rate=0.035, max_depth=5,
                             num_leaves=25, random_state=42, verbose=-1)
        xgb = XGBClassifier(n_estimators=120, learning_rate=0.04, max_depth=4,
                            random_state=42, eval_metric='logloss', verbosity=0)
        rf = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42, n_jobs=1)
        X_train = train[FEATURE_COLS]
        X_test = test[FEATURE_COLS]
        lgb.fit(X_train, y_train)
        xgb.fit(X_train, y_train)
        rf.fit(X_train, y_train)
        prob = (0.40 * lgb.predict_proba(X_test)[:, 1]
                + 0.35 * xgb.predict_proba(X_test)[:, 1]
                + 0.25 * rf.predict_proba(X_test)[:, 1])
        return (lgb, xgb, rf, metric(y_test, prob))

    lgb_buy, xgb_buy, rf_buy, metrics_buy = fit_pair('target_buy')
    lgb_sell, xgb_sell, rf_sell, metrics_sell = fit_pair('target_sell')

    with open(REGISTRY_PATH, 'r', encoding='utf-8') as handle:
        registry = json.load(handle)
    version = next_version(registry.get('active_version'))
    bundle = {
        'version': version,
        'market': 'crypto',
        'lgb_buy': lgb_buy, 'xgb_buy': xgb_buy, 'rf_buy': rf_buy,
        'lgb_sell': lgb_sell, 'xgb_sell': xgb_sell, 'rf_sell': rf_sell,
        'features': FEATURE_COLS,
        'metrics_buy': metrics_buy, 'metrics_sell': metrics_sell,
        'trained_at': pd.Timestamp.now().isoformat(),
        'source': 'historical_csv_plus_trade_results',
        'trade_result_samples': len(live),
        'label_policy': 'exclude CLOSED_SL with positive P/L and CLOSED_TP with negative P/L',
        'ambiguous_rows_excluded': ambiguous_rows_excluded,
        'recovered_trade_samples': recovered_rows,
    }
    os.makedirs(os.path.join(MODEL_DIR, 'versions'), exist_ok=True)
    version_file = f'crypto_m5_model_{version}.joblib'
    joblib.dump(bundle, os.path.join(MODEL_DIR, 'versions', version_file))

    # Promotion Firewall Gate: Compare candidate metrics against quality threshold
    min_required_roc = 0.70
    passed_gate = metrics_buy.get('roc_auc', 0) >= min_required_roc and metrics_sell.get('roc_auc', 0) >= min_required_roc

    if passed_gate:
        joblib.dump(bundle, MODEL_PATH)
        print(f"✅ [Promotion Gate Passed] New model {version} promoted to production {MODEL_PATH}")
    else:
        print(f"⚠️ [Promotion Gate Blocked] Candidate {version} saved to versions/ but not promoted to active MODEL_PATH (ROC-AUC Buy {metrics_buy.get('roc_auc')}, Sell {metrics_sell.get('roc_auc')} < {min_required_roc})")

    entry = {
        'version': version,
        'created_at': pd.Timestamp.now().isoformat(),
        'description': 'Crypto M5 Tri-Ensemble retrained with closed trade_results',
        'file': f'versions/{version_file}',
        'dataset': {
            'source': 'dataset_crypto_m5.csv + trade_results',
            'historical_samples': int(len(base)),
            'live_trade_samples': int(len(live)),
            'base_samples': int(len(base)),
            'trade_result_samples': int(len(live)),
            'ambiguous_rows_excluded': ambiguous_rows_excluded,
            'recovered_trade_samples': recovered_rows,
            'label_policy': 'exclude CLOSED_SL with positive P/L and CLOSED_TP with negative P/L',
            'train_samples': int(len(train)),
            'test_samples': int(len(test)),
            'total_samples': int(len(combined)),
            'positive_rate_buy': round(float(combined['target_buy'].mean()), 4),
            'positive_rate_sell': round(float(combined['target_sell'].mean()), 4)
        },
        'architecture': 'Tri-Ensemble (LightGBM 40% + XGBoost 35% + Random Forest 25%)',
        'features': FEATURE_COLS,
        'metrics': {
            'roc_auc_buy': metrics_buy['roc_auc'],
            'pr_auc_buy': metrics_buy['pr_auc'],
            'roc_auc_sell': metrics_sell['roc_auc'],
            'pr_auc_sell': metrics_sell['pr_auc']
        }
    }
    registry['active_version'] = version
    registry.setdefault('versions', []).append(entry)
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as handle:
        json.dump(registry, handle, indent=2, ensure_ascii=False)

    print(json.dumps({'success': True, 'version': version, 'trade_result_samples': len(live),
                      'ambiguous_rows_excluded': ambiguous_rows_excluded,
                      'recovered_trade_samples': recovered_rows,
                      'metrics_buy': metrics_buy, 'metrics_sell': metrics_sell}))


if __name__ == '__main__':
    try:
        train_crypto_from_results()
    except Exception as error:
        print(json.dumps({'success': False, 'error': str(error)}))
        sys.exit(1)
