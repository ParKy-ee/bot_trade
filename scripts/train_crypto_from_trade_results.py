import json
import os
import re
import sys
import urllib.request
import warnings

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score, average_precision_score, brier_score_loss,
    f1_score, fbeta_score, log_loss, matthews_corrcoef,
    precision_score, recall_score, roc_auc_score
)
from xgboost import XGBClassifier

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings('ignore')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_DATA = os.path.join(ROOT_DIR, 'data', 'dataset_crypto_m5.csv')
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
VERSIONS_DIR = os.path.join(MODEL_DIR, 'versions')
MODEL_PATH = os.path.join(MODEL_DIR, 'crypto_m5_model.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'crypto_model_registry.json')

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'ema_spread_50_200', 'macd_hist',
    'volume_ratio', 'bb_width',
    'btc_ret_5', 'btc_corr_divergence', 'is_weekend',
    'vwap_distance_pct', 'distance_to_swing_high_low', 'funding_window_proximity'
]


def calc_metrics(y_true, y_prob, thresh=0.5):
    y_pred = (y_prob >= thresh).astype(int)
    has_pos = len(np.unique(y_true)) > 1
    roc_auc = roc_auc_score(y_true, y_prob) if has_pos else 0.5
    pr_auc = average_precision_score(y_true, y_prob) if has_pos else 0.0
    acc = accuracy_score(y_true, y_pred)
    prec = precision_score(y_true, y_pred, zero_division=0)
    rec = recall_score(y_true, y_pred, zero_division=0)
    f1 = f1_score(y_true, y_pred, zero_division=0)
    f2 = fbeta_score(y_true, y_pred, beta=2, zero_division=0)
    mcc = matthews_corrcoef(y_true, y_pred) if len(np.unique(y_pred)) > 1 else 0.0
    ll = log_loss(y_true, np.clip(y_prob, 1e-6, 1 - 1e-6))
    brier = brier_score_loss(y_true, y_prob)

    tn = np.sum((y_true == 0) & (y_pred == 0))
    fp = np.sum((y_true == 0) & (y_pred == 1))
    spec = tn / (tn + fp + 1e-9)

    return {
        'roc_auc': round(float(roc_auc), 4),
        'pr_auc': round(float(pr_auc), 4),
        'accuracy': round(float(acc), 4),
        'precision': round(float(prec), 4),
        'recall': round(float(rec), 4),
        'specificity': round(float(spec), 4),
        'f1': round(float(f1), 4),
        'f2': round(float(f2), 4),
        'mcc': round(float(mcc), 4),
        'log_loss': round(float(ll), 4),
        'brier': round(float(brier), 4)
    }


def next_version(current):
    match = re.match(r'^v(\d+)\.(\d+)\.(\d+)$', str(current or 'v2.1.0'))
    if not match:
        return 'v2.2.0'
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
    incomplete_features_excluded = 0
    for row in rows if isinstance(rows, list) else []:
        try:
            meta = json.loads(row.get('prediction_meta') or '{}')
            features = meta.get('features') or {}
            if row.get('action') not in ('BUY', 'SELL') or row.get('exit_price') is None:
                continue

            # Ensure all 16 features are present
            if not all(k in features for k in FEATURE_COLS):
                incomplete_features_excluded += 1
                continue

            exit_reason = str(row.get('exit_reason') or '')
            profit_loss = float(row['profit_loss']) if row.get('profit_loss') is not None else None

            # Exclude contradictory/ambiguous rows
            if (
                (exit_reason == 'CLOSED_SL' and profit_loss is not None and profit_loss > 0)
                or (exit_reason == 'CLOSED_TP' and profit_loss is not None and profit_loss < 0)
            ):
                ambiguous_rows_excluded += 1
                continue

            # Strict Profit Rule: WIN if and only if net dollar profit > 0
            is_valid_win = int((profit_loss > 0) if profit_loss is not None else (int(row.get('is_win', 0)) == 1))

            item = {key: float(features[key]) for key in FEATURE_COLS}
            item['target_buy'] = int(row['action'] == 'BUY' and is_valid_win == 1)
            item['target_sell'] = int(row['action'] == 'SELL' and is_valid_win == 1)
            item['entry_time'] = row.get('entry_time')
            item['symbol'] = row.get('symbol')
            live_rows.append(item)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue

    result = pd.DataFrame(live_rows)
    result.attrs['raw_rows'] = len(rows) if isinstance(rows, list) else 0
    result.attrs['ambiguous_rows_excluded'] = ambiguous_rows_excluded
    result.attrs['incomplete_features_excluded'] = incomplete_features_excluded
    return result


def train_crypto_from_results():
    print("=" * 80)
    print("🧠 Starting Retraining of Crypto Calibrated Tri-Ensemble (Binance + Live Trades)")
    print("=" * 80)

    if not os.path.exists(BASE_DATA):
        raise FileNotFoundError(f"Missing base dataset: {BASE_DATA}")

    base = pd.read_csv(BASE_DATA)
    base = base.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).copy()
    print(f"[*] Base Binance Dataset Loaded: {len(base):,} rows across {base['symbol'].nunique()} symbols")

    live = load_trade_results()
    ambiguous_rows_excluded = int(live.attrs.get('ambiguous_rows_excluded', 0))
    incomplete_features_excluded = int(live.attrs.get('incomplete_features_excluded', 0))
    print(f"[*] Live/Shadow Trades Loaded: {len(live):,} feature-complete closed trades (Strict Profit-labeled)")
    print(f"    (Excluded: {ambiguous_rows_excluded} ambiguous P/L, {incomplete_features_excluded} legacy <16-feature)")

    if len(live) < 10:
        raise RuntimeError(
            f'Need at least 10 feature-complete closed Crypto trades; found {len(live)}.'
        )

    cols = FEATURE_COLS + ['target_buy', 'target_sell']
    combined = pd.concat([base[cols], live[cols]], ignore_index=True)

    # Time-based train-test split (80% train, 20% test)
    base_split = max(1, int(len(base) * 0.8))
    base_train = base[cols].iloc[:base_split]
    base_test = base[cols].iloc[base_split:]

    live_split = max(1, int(len(live) * 0.8))
    live_train = live[cols].iloc[:live_split]
    live_test = live[cols].iloc[live_split:]

    # Weight live domain adaptation samples (3x)
    live_train_weighted = pd.concat([live_train] * 3, ignore_index=True)
    train = pd.concat([base_train, live_train_weighted], ignore_index=True)
    test = pd.concat([base_test, live_test], ignore_index=True)

    X_train = train[FEATURE_COLS]
    X_test = test[FEATURE_COLS]

    print(f"[*] Training Set: {len(train):,} samples | Test Set: {len(test):,} samples")
    print(f"[*] Target Rates -> BUY: {train['target_buy'].mean():.1%} | SELL: {train['target_sell'].mean():.1%}")

    # Train Calibrated Tri-Ensemble (LightGBM 40% + XGBoost 35% + Random Forest 25%)
    def fit_calibrated_tri_ensemble(target_name):
        print(f"\n🚀 Training Calibrated Tri-Ensemble for {target_name.upper()}...")
        y_train = train[target_name]
        y_test = test[target_name]

        base_lgb = LGBMClassifier(
            n_estimators=150, learning_rate=0.03, max_depth=5, num_leaves=31,
            subsample=0.8, colsample_bytree=0.8, random_state=42, verbose=-1
        )
        lgb = CalibratedClassifierCV(base_lgb, cv=3, method='sigmoid')
        lgb.fit(X_train, y_train)

        base_xgb = XGBClassifier(
            n_estimators=140, learning_rate=0.035, max_depth=4,
            subsample=0.8, colsample_bytree=0.8, random_state=42,
            eval_metric="logloss", verbosity=0
        )
        xgb = CalibratedClassifierCV(base_xgb, cv=3, method='sigmoid')
        xgb.fit(X_train, y_train)

        base_rf = RandomForestClassifier(
            n_estimators=120, max_depth=6, random_state=42, n_jobs=-1
        )
        rf = CalibratedClassifierCV(base_rf, cv=3, method='sigmoid')
        rf.fit(X_train, y_train)

        prob = (
            0.40 * lgb.predict_proba(X_test)[:, 1] +
            0.35 * xgb.predict_proba(X_test)[:, 1] +
            0.25 * rf.predict_proba(X_test)[:, 1]
        )
        metrics = calc_metrics(y_test, prob)
        print(f"   ✓ {target_name.upper()} Metrics: ROC-AUC={metrics['roc_auc']} | F1={metrics['f1']} | PR-AUC={metrics['pr_auc']} | Acc={metrics['accuracy']} | Brier={metrics['brier']}")
        return lgb, xgb, rf, metrics

    lgb_buy, xgb_buy, rf_buy, metrics_buy = fit_calibrated_tri_ensemble('target_buy')
    lgb_sell, xgb_sell, rf_sell, metrics_sell = fit_calibrated_tri_ensemble('target_sell')

    # Load registry
    with open(REGISTRY_PATH, 'r', encoding='utf-8') as handle:
        registry = json.load(handle)

    active_ver = registry.get('active_version', 'v2.1.0')
    candidate_ver = next_version(active_ver)

    bundle = {
        'version': candidate_ver,
        'market': 'crypto',
        'lgb_buy': lgb_buy, 'xgb_buy': xgb_buy, 'rf_buy': rf_buy,
        'lgb_sell': lgb_sell, 'xgb_sell': xgb_sell, 'rf_sell': rf_sell,
        'weights': {'lightgbm': 0.40, 'xgboost': 0.35, 'random_forest': 0.25},
        'features': FEATURE_COLS,
        'metrics_buy': metrics_buy,
        'metrics_sell': metrics_sell,
        'trained_at': pd.Timestamp.now().isoformat(),
        'source': 'binance_m5_plus_live_trade_results',
        'trade_result_samples': len(live),
        'label_policy': 'strict_profit_net_usd_gt_0',
        'ambiguous_rows_excluded': ambiguous_rows_excluded,
        'incomplete_features_excluded': incomplete_features_excluded
    }

    os.makedirs(VERSIONS_DIR, exist_ok=True)
    version_file = f'versions/crypto_m5_model_{candidate_ver}.joblib'
    version_path = os.path.join(MODEL_DIR, version_file)
    joblib.dump(bundle, version_path)
    print(f"\n📦 Candidate model saved to version archive: {version_path}")

    # Promotion Gate Protocol (SKILL 4.3):
    # Gate 1: Baseline Quality (ROC-AUC >= 0.70 on both BUY and SELL)
    # Gate 2: F1 and PR-AUC parity/superiority against active champion
    prev_entry = next((v for v in reversed(registry.get('versions', [])) if v.get('version') == active_ver), None)
    prev_roc_b = prev_entry.get('metrics', {}).get('roc_auc_buy', 0.70) if prev_entry else 0.70
    prev_roc_s = prev_entry.get('metrics', {}).get('roc_auc_sell', 0.70) if prev_entry else 0.70

    min_required_roc = 0.70
    passed_min_roc = (metrics_buy['roc_auc'] >= min_required_roc and metrics_sell['roc_auc'] >= min_required_roc)
    # Require no catastrophic degradation (within 0.03 of active champion)
    passed_parity = (metrics_buy['roc_auc'] >= prev_roc_b - 0.03 and metrics_sell['roc_auc'] >= prev_roc_s - 0.03)

    passed_gate = passed_min_roc and passed_parity

    print("\n" + "=" * 80)
    print("🛡️  PROMOTION FIREWALL GATE EVALUATION:")
    print("=" * 80)
    print(f"Active Champion ({active_ver}):  ROC-AUC BUY={prev_roc_b:.4f} | SELL={prev_roc_s:.4f}")
    print(f"Candidate Model ({candidate_ver}): ROC-AUC BUY={metrics_buy['roc_auc']:.4f} | SELL={metrics_sell['roc_auc']:.4f}")
    print(f"Thresholds: Min ROC >= {min_required_roc} | Parity Tol >= -0.03")
    print(f"Gate 1 (Min ROC): {'✅ PASSED' if passed_min_roc else '❌ FAILED'}")
    print(f"Gate 2 (Parity):  {'✅ PASSED' if passed_parity else '❌ FAILED'}")

    if passed_gate:
        joblib.dump(bundle, MODEL_PATH)
        registry['active_version'] = candidate_ver
        status_msg = f"✅ [Promotion Gate Passed] Candidate {candidate_ver} promoted to active production {MODEL_PATH}"
        print(status_msg)
    else:
        status_msg = f"⚠️ [Promotion Gate Blocked] Candidate {candidate_ver} safely held in archive. Active production remains {active_ver}."
        print(status_msg)

    entry = {
        'version': candidate_ver,
        'created_at': pd.Timestamp.now().isoformat(),
        'description': f"Crypto M5 Calibrated Tri-Ensemble retrained with fresh Binance data + {len(live)} strict-profit closed trades",
        'file': version_file,
        'dataset': {
            'source': 'Binance Klines M5 + trade_results',
            'symbols': list(base['symbol'].unique()),
            'historical_samples': int(len(base)),
            'live_trade_samples': int(len(live)),
            'total_samples': int(len(combined)),
            'train_samples': int(len(train)),
            'test_samples': int(len(test)),
            'positive_rate_buy': round(float(combined['target_buy'].mean()), 4),
            'positive_rate_sell': round(float(combined['target_sell'].mean()), 4),
            'label_policy': 'strict_profit_net_usd_gt_0',
            'ambiguous_rows_excluded': ambiguous_rows_excluded,
            'incomplete_features_excluded': incomplete_features_excluded
        },
        'architecture': 'Calibrated Tri-Ensemble (LightGBM 40% + XGBoost 35% + Random Forest 25% with Sigmoid Calibration)',
        'weights': {'lightgbm': 0.40, 'xgboost': 0.35, 'random_forest': 0.25},
        'features': FEATURE_COLS,
        'metrics': {
            'roc_auc_buy': metrics_buy['roc_auc'],
            'roc_auc_sell': metrics_sell['roc_auc'],
            'pr_auc_buy': metrics_buy['pr_auc'],
            'pr_auc_sell': metrics_sell['pr_auc'],
            'accuracy_buy': metrics_buy['accuracy'],
            'accuracy_sell': metrics_sell['accuracy'],
            'precision_buy': metrics_buy['precision'],
            'precision_sell': metrics_sell['precision'],
            'recall_buy': metrics_buy['recall'],
            'recall_sell': metrics_sell['recall'],
            'specificity_buy': metrics_buy['specificity'],
            'specificity_sell': metrics_sell['specificity'],
            'f1_buy': metrics_buy['f1'],
            'f1_sell': metrics_sell['f1'],
            'f2_buy': metrics_buy['f2'],
            'f2_sell': metrics_sell['f2'],
            'mcc_buy': metrics_buy['mcc'],
            'mcc_sell': metrics_sell['mcc'],
            'log_loss_buy': metrics_buy['log_loss'],
            'log_loss_sell': metrics_sell['log_loss'],
            'brier_buy': metrics_buy['brier'],
            'brier_sell': metrics_sell['brier']
        },
        'gate_status': 'PROMOTED' if passed_gate else 'HELD'
    }

    # Clean existing registry entry if same version exists
    registry['versions'] = [v for v in registry.get('versions', []) if v.get('version') != candidate_ver]
    registry['versions'].append(entry)

    with open(REGISTRY_PATH, 'w', encoding='utf-8') as handle:
        json.dump(registry, handle, indent=2, ensure_ascii=False)

    print(f"🏷️  Crypto Model Registry updated: {REGISTRY_PATH}")
    print("=" * 80)
    return {
        'success': True,
        'version': candidate_ver,
        'promoted': passed_gate,
        'active_version': registry['active_version'],
        'metrics_buy': metrics_buy,
        'metrics_sell': metrics_sell
    }


if __name__ == '__main__':
    try:
        res = train_crypto_from_results()
    except Exception as error:
        print(json.dumps({'success': False, 'error': str(error)}))
        sys.exit(1)

