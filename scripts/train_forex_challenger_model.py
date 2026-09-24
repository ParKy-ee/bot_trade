import json
import os
import re
import sys
import urllib.request
import warnings

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    fbeta_score,
    log_loss,
    matthews_corrcoef,
    precision_score,
    recall_score,
    roc_auc_score,
)

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
VERSIONS_DIR = os.path.join(MODEL_DIR, 'versions')
MODEL_PATH = os.path.join(MODEL_DIR, 'forex_challenger_model.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'challenger_registry.json')
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'dataset_forex_m5.csv')
# Mix only the latest Forex trend-model outcomes.  Champion and Challenger
# share the same 13-feature schema and target semantics; Range/Crypto/Stock
# do not and must remain excluded.
MIXED_SOURCES = {
    ('forex_challenger', 'challenger-v1.2.0', 'CHALLENGER_SHADOW'),
    ('forex_challenger', 'challenger-v1.5.0', 'CHALLENGER_SHADOW'),
    ('forex_challenger', 'challenger-v1.6.0', 'CHALLENGER_SHADOW'),
    ('forex_challenger', 'challenger-v1.7.0', 'CHALLENGER_SHADOW'),
    ('forex_challenger', 'challenger-v1.7.0', 'POCKET_PROD_SHADOW'),
    ('forex_challenger', 'challenger-v1.7.0', 'POCKET_EXPLORE_SHADOW'),
    ('forex_challenger', 'challenger-v1.7.0', 'LIVE'),
    ('forex_champion', 'v1.4.0', 'CHAMPION_SHADOW'),
    ('forex_champion', 'v1.5.0', 'CHAMPION_SHADOW'),
    ('forex_champion', 'v1.6.0', 'CHAMPION_SHADOW'),
}
API_URL = 'http://localhost:3000/api/trade-results?market=all&ready_for_retrain=true&limit=5000'
OBSERVATION_API_URL = 'http://localhost:3000/api/forex-ml-observations?ready_for_retrain=true&limit=5000'

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'macd_hist', 'csm_spread', 'h1_trend_slope',
    'is_jpy', 'time_sin_hour', 'time_cos_hour', 'spread_to_atr'
]


def add_derived_features(df):
    df = df.copy()
    if 'csm_spread' not in df.columns:
        df['csm_spread'] = 0.0
    if 'h1_trend_slope' not in df.columns:
        df['h1_trend_slope'] = 0.0
    if 'is_jpy' not in df.columns:
        df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
    if 'time_sin_hour' not in df.columns or 'time_cos_hour' not in df.columns:
        dt = pd.to_datetime(df.get('time'), errors='coerce')
        hrs = dt.dt.hour + (dt.dt.minute / 60.0)
        df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
        df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)
    if 'spread_to_atr' not in df.columns:
        df['spread_to_atr'] = 0.02
    return df


def apply_labels(df):
    df = df.copy()
    atr_up = df['atr_pct'] * 1.5
    atr_dn = df['atr_pct'] * 1.0
    df['target_buy'] = np.where((df['target_ret_5'] >= atr_up) & (df['ret_1'] >= 0), 1, 0)
    df['target_sell'] = np.where((df['target_ret_5'] <= -atr_dn) & (df['ret_1'] <= 0), 1, 0)
    return df


def evaluate(y_true, prob):
    thresholds = np.linspace(float(np.min(prob)) + 0.001, float(np.max(prob)) - 0.001, 60)
    best_threshold = 0.5
    best_f05 = -1.0
    for threshold in thresholds:
        pred = (prob >= threshold).astype(int)
        if int(pred.sum()) >= 40:
            score = fbeta_score(y_true, pred, beta=0.5, zero_division=0)
            if score > best_f05:
                best_f05 = score
                best_threshold = float(threshold)
    pred = (prob >= best_threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    specificity = float(tn / (tn + fp)) if (tn + fp) else 0.0
    return {
        'threshold': round(best_threshold, 4),
        'accuracy': round(float(accuracy_score(y_true, pred)), 4),
        'precision': round(float(precision_score(y_true, pred, zero_division=0)), 4),
        'recall': round(float(recall_score(y_true, pred, zero_division=0)), 4),
        'specificity': round(specificity, 4),
        'f1': round(float(fbeta_score(y_true, pred, beta=1.0, zero_division=0)), 4),
        'f05': round(float(fbeta_score(y_true, pred, beta=0.5, zero_division=0)), 4),
        'roc_auc': round(float(roc_auc_score(y_true, prob)), 4),
        'pr_auc': round(float(average_precision_score(y_true, prob)), 4),
        'log_loss': round(float(log_loss(y_true, prob)), 4),
        'brier': round(float(brier_score_loss(y_true, prob)), 4),
        'mcc': round(float(matthews_corrcoef(y_true, pred)), 4),
        'confusion_matrix': {'tn': int(tn), 'fp': int(fp), 'fn': int(fn), 'tp': int(tp)},
    }


def load_valid_live_results():
    """Load only closed rows from the latest compatible Forex model sources."""
    try:
        req = urllib.request.Request(API_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
        if not isinstance(payload, list) or not payload:
            return pd.DataFrame()

        raw = pd.DataFrame(payload)
        required = [
            'market_type', 'exit_reason', 'is_win', 'action', 'entry_time',
            'entry_price', 'pips', 'rsi', 'adx', 'atr', 'ema21', 'ema50',
            'macd_hist', 'model_source', 'model_version', 'decision_mode'
        ]
        if any(col not in raw.columns for col in required):
            return pd.DataFrame()

        source_mask = raw.apply(
            lambda row: (
                row['model_source'], row['model_version'], row['decision_mode']
            ) in MIXED_SOURCES,
            axis=1,
        )
        valid = raw[
            source_mask &
            (raw['market_type'].isin(['forex', 'forex_shadow'])) &
            (~raw['exit_reason'].isin(['OPEN', 'SYNC_PENDING'])) &
            (raw['is_win'].notna()) &
            (raw['action'].isin(['BUY', 'SELL'])) &
            (raw['entry_time'].notna()) &
            (raw['entry_price'].notna()) &
            (raw['rsi'].notna()) &
            (raw['adx'].notna()) &
            (raw['atr'].notna()) &
            (raw['ema21'].notna()) &
            (raw['ema50'].notna()) &
            (raw['macd_hist'].notna())
        ].copy()
        if len(valid) < 4:
            return pd.DataFrame()

        valid['ret_1'] = 0.0
        valid['ret_5'] = pd.to_numeric(valid['pips'], errors='coerce').fillna(0.0) * 0.0001
        valid['rsi_14'] = pd.to_numeric(valid['rsi'], errors='coerce')
        valid['atr_pct'] = pd.to_numeric(valid['atr'], errors='coerce') / (pd.to_numeric(valid['entry_price'], errors='coerce') + 1e-12)
        valid['adx_14'] = pd.to_numeric(valid['adx'], errors='coerce')
        valid['ema_spread_20_50'] = (
            pd.to_numeric(valid['ema21'], errors='coerce') - pd.to_numeric(valid['ema50'], errors='coerce')
        ) / (pd.to_numeric(valid['entry_price'], errors='coerce') + 1e-12)
        valid['macd_hist'] = pd.to_numeric(valid['macd_hist'], errors='coerce')
        valid['csm_spread'] = 0.0
        valid['h1_trend_slope'] = 0.0
        valid['is_jpy'] = valid['symbol'].astype(str).str.contains('JPY').astype(float)

        live_dt = pd.to_datetime(valid['entry_time'], errors='coerce')
        hrs = live_dt.dt.hour + (live_dt.dt.minute / 60.0)
        valid['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
        valid['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)
        spread_pips = np.where(valid['is_jpy'] == 1.0, 0.02, 0.00015)
        valid['spread_to_atr'] = spread_pips / (pd.to_numeric(valid['atr'], errors='coerce') + 1e-12)
        # Enforce realistic Net Pips floor (Major >= 2.5 pips, JPY >= 3.5 pips) so model doesn't learn tiny noise wiggles
        min_pips_floor = np.where(valid['is_jpy'] == 1.0, 3.5, 2.5)
        is_real_win = (valid['is_win'] == 1) & (pd.to_numeric(valid['pips'], errors='coerce') >= min_pips_floor)
        valid['target_buy'] = np.where((valid['action'] == 'BUY') & is_real_win, 1, 0)
        valid['target_sell'] = np.where((valid['action'] == 'SELL') & is_real_win, 1, 0)
        return valid.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).reset_index(drop=True)
    except Exception as exc:
        print(f'⚠️ Live Challenger results unavailable: {exc}')
        return pd.DataFrame()


def load_valid_observations():
    """Load labeled, MT5-sourced observations from the isolated new dataset."""
    try:
        req = urllib.request.Request(OBSERVATION_API_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
        if not isinstance(payload, list) or not payload:
            return pd.DataFrame()

        raw = pd.DataFrame(payload)
        required = ['outcome_status', 'data_source', 'sample_kind', 'target_buy', 'target_sell'] + FEATURE_COLS
        if any(col not in raw.columns for col in required):
            return pd.DataFrame()

        valid = raw[
            (raw['outcome_status'] == 'LABELED') &
            (raw['data_source'] == 'mt5') &
            (raw['sample_kind'] != 'RANGE_EXCLUDED')
        ].copy()
        if len(valid) < 4:
            return pd.DataFrame()

        for column in FEATURE_COLS + ['target_buy', 'target_sell']:
            valid[column] = pd.to_numeric(valid[column], errors='coerce')
        return valid.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).reset_index(drop=True)
    except Exception as exc:
        print(f'⚠️ New Forex ML observations unavailable: {exc}')
        return pd.DataFrame()


def next_version(registry):
    versions = []
    if os.path.exists(VERSIONS_DIR):
        for f in os.listdir(VERSIONS_DIR):
            m = re.match(r'forex_challenger_model_challenger-v(\d+)\.(\d+)\.(\d+)\.joblib', f)
            if m:
                versions.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
    if not versions:
        current = str(registry.get('active_version', 'challenger-v1.0.0'))
        raw = current.replace('challenger-v', '')
        parts = raw.split('.')
        try:
            if len(parts) == 3:
                return f'challenger-v{parts[0]}.{int(parts[1]) + 1}.0'
        except ValueError:
            pass
        return 'challenger-v1.1.0'
    versions.sort()
    latest = versions[-1]
    return f'challenger-v{latest[0]}.{latest[1] + 1}.0'


def main(target_version=None, use_observations=True, promote=False):
    print('=' * 75)
    print('🚀 ฝึก Forex Challenger Model บน dataset เดิม (GradientBoosting)')
    print('=' * 75)
    if not os.path.exists(DATA_PATH):
        print(json.dumps({'success': False, 'error': f'Missing dataset: {DATA_PATH}'}))
        return 1

    df = add_derived_features(apply_labels(pd.read_csv(DATA_PATH)))
    clean_base = df.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).reset_index(drop=True)
    live = load_valid_live_results()
    observations = load_valid_observations() if use_observations else pd.DataFrame()
    live_trade_samples = int((live['market_type'] == 'forex').sum()) if not live.empty and 'market_type' in live.columns else 0
    shadow_trade_samples = int((live['market_type'] == 'forex_shadow').sum()) if not live.empty and 'market_type' in live.columns else 0
    observation_samples = int(len(observations))
    cols = FEATURE_COLS + ['target_buy', 'target_sell']
    # 1. Base historical split (80% train / 20% val)
    base_split = int(len(clean_base) * 0.8)
    base_train = clean_base[cols].iloc[:base_split]
    base_val = clean_base[cols].iloc[base_split:]

    train_parts = [base_train]
    val_parts = [base_val]

    # 2. Live/Shadow Trades split BEFORE weighting to prevent train-test data leakage
    if len(live) >= 4:
        live_clean = live[cols].reset_index(drop=True)
        live_split = int(len(live_clean) * 0.8)
        live_train = live_clean.iloc[:live_split]
        live_val = live_clean.iloc[live_split:]

        live_train_weighted = pd.concat([live_train] * 5, ignore_index=True)
        train_parts.append(live_train_weighted)
        val_parts.append(live_val)
        print(f'✅ เพิ่ม Challenger shadow trades: {len(live_train)} train (x5) + {len(live_val)} unweighted val')
    else:
        print(f'ℹ️ Challenger shadow trade ที่ใช้ได้มี {len(live)} รายการ จึงใช้ historical เป็นหลัก')

    # 3. Observations split BEFORE weighting to prevent train-test data leakage
    if len(observations) >= 4:
        obs_clean = observations[cols].reset_index(drop=True)
        obs_split = int(len(obs_clean) * 0.8)
        obs_train = obs_clean.iloc[:obs_split]
        obs_val = obs_clean.iloc[obs_split:]

        obs_train_weighted = pd.concat([obs_train] * 5, ignore_index=True)
        train_parts.append(obs_train_weighted)
        val_parts.append(obs_val)
        print(f'✅ เพิ่ม Labeled observations: {len(obs_train)} train (x5) + {len(obs_val)} unweighted val')

    train_df = pd.concat(train_parts, ignore_index=True)
    val_df = pd.concat(val_parts, ignore_index=True)
    clean = pd.concat([train_df, val_df], ignore_index=True)
    X_train = train_df[FEATURE_COLS]
    X_val = val_df[FEATURE_COLS]

    params = {
        'n_estimators': 180,
        'learning_rate': 0.04,
        'max_depth': 3,
        'min_samples_leaf': 30,
        'subsample': 0.9,
        'random_state': 42,
    }
    buy_model = GradientBoostingClassifier(**params)
    sell_model = GradientBoostingClassifier(**params)
    buy_model.fit(X_train, train_df['target_buy'])
    sell_model.fit(X_train, train_df['target_sell'])

    buy_prob = buy_model.predict_proba(X_val)[:, 1]
    sell_prob = sell_model.predict_proba(X_val)[:, 1]
    metrics = {
        'buy': evaluate(val_df['target_buy'], buy_prob),
        'sell': evaluate(val_df['target_sell'], sell_prob),
    }
    print(f"   >>> BUY Challenger AUC: {metrics['buy']['roc_auc']:.4f} | F0.5: {metrics['buy']['f05']:.4f}")
    print(f"   >>> SELL Challenger AUC: {metrics['sell']['roc_auc']:.4f} | F0.5: {metrics['sell']['f05']:.4f}")

    trained_at = pd.Timestamp.now().isoformat()
    registry_prev = {}
    if os.path.exists(REGISTRY_PATH):
        try:
            with open(REGISTRY_PATH, 'r', encoding='utf-8') as f:
                registry_prev = json.load(f)
        except Exception:
            registry_prev = {}
    version = target_version or next_version(registry_prev)
    archive_path = os.path.join(VERSIONS_DIR, f'forex_challenger_model_{version}.joblib')
    bundle = {
        'version': version,
        'model_source': 'forex_challenger',
        'architecture': 'Dual GradientBoosting (BUY + SELL)',
        'buy_model': buy_model,
        'sell_model': sell_model,
        'features': FEATURE_COLS,
        'parameters': params,
        'metrics': metrics,
        'dataset': {
            'total_samples': int(len(clean)),
            'train_samples': int(len(train_df)),
            'test_samples': int(len(val_df)),
            'positive_rate_buy': round(float(val_df['target_buy'].mean()), 4),
            'positive_rate_sell': round(float(val_df['target_sell'].mean()), 4),
            'live_trade_samples': live_trade_samples,
            'shadow_trade_samples': shadow_trade_samples,
            'observation_samples': observation_samples,
            'source_mode': 'trade_results_plus_observations' if use_observations else 'trade_results_compatibility',
            'mixed_sources': [list(source) for source in sorted(MIXED_SOURCES)],
        },
        'trained_at': trained_at,
    }
    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    joblib.dump(bundle, archive_path)
    print(f'✅ บันทึก Challenger Archive: {archive_path}')

    # Side-by-side comparison with active model
    prev_metrics = registry_prev.get('metrics', {}) if registry_prev else {}
    prev_buy = prev_metrics.get('buy', {})
    prev_sell = prev_metrics.get('sell', {})
    prev_ver = registry_prev.get('active_version', 'unknown')

    print('\n' + '=' * 75)
    print(f"📊 COMPARISON: Candidate [{version}] vs Active [{prev_ver}]")
    print('=' * 75)
    if prev_buy and prev_sell:
        d_buy_f1 = metrics['buy']['f1'] - prev_buy.get('f1', 0)
        d_buy_auc = metrics['buy']['roc_auc'] - prev_buy.get('roc_auc', 0)
        d_sell_f1 = metrics['sell']['f1'] - prev_sell.get('f1', 0)
        d_sell_auc = metrics['sell']['roc_auc'] - prev_sell.get('roc_auc', 0)
        print(f"  BUY  | F1: {metrics['buy']['f1']:.4f} vs {prev_buy.get('f1', 0):.4f} (Δ {d_buy_f1:+.4f}) | AUC: {metrics['buy']['roc_auc']:.4f} vs {prev_buy.get('roc_auc', 0):.4f} (Δ {d_buy_auc:+.4f}) | Prec: {metrics['buy']['precision']:.4f} vs {prev_buy.get('precision', 0):.4f}")
        print(f"  SELL | F1: {metrics['sell']['f1']:.4f} vs {prev_sell.get('f1', 0):.4f} (Δ {d_sell_f1:+.4f}) | AUC: {metrics['sell']['roc_auc']:.4f} vs {prev_sell.get('roc_auc', 0):.4f} (Δ {d_sell_auc:+.4f}) | Prec: {metrics['sell']['precision']:.4f} vs {prev_sell.get('precision', 0):.4f}")
        pass_gate = (d_buy_f1 >= 0.03 or d_sell_f1 >= 0.03) and (metrics['buy']['precision'] >= 0.40 and metrics['sell']['precision'] >= 0.30)
        print(f"  Gate Protocol 4.3 (Δ F1 >= +0.03): {'✅ PASS' if pass_gate else '⚠️ HOLD (Not exceeding +0.03 margin)'}")
    else:
        print("  (No active model metrics available in registry for comparison)")
    print('=' * 75 + '\n')

    if promote:
        joblib.dump(bundle, MODEL_PATH)
        registry = {
            'active_version': version,
            'model_source': 'forex_challenger',
            'created_at': trained_at,
            'artifact': 'forex_challenger_model.joblib',
            'archive_artifact': f'versions/forex_challenger_model_{version}.joblib',
            'architecture': bundle['architecture'],
            'features': FEATURE_COLS,
            'dataset': bundle['dataset'],
            'metrics': metrics,
        }
        with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
            json.dump(registry, f, ensure_ascii=False, indent=2)
        print(f'✅ อัปเดต Active Challenger: {MODEL_PATH}')
        print(f'✅ Registry: {REGISTRY_PATH}')
    else:
        print(f'ℹ️ Candidate model บันทึกที่ {archive_path}')
        print(f'   Active model ({prev_ver}) ยังคงเดิมในระบบ Live/Shadow (ใช้ --promote เพื่อสลับใช้งานจริง)')

    print(json.dumps({
        'success': True,
        'version': version,
        'promoted': promote,
        'metrics': metrics,
        'live_trade_samples': live_trade_samples,
        'shadow_trade_samples': shadow_trade_samples,
        'observation_samples': observation_samples,
        'source_mode': 'trade_results_plus_observations' if use_observations else 'trade_results_compatibility',
        'mixed_sources': [list(source) for source in sorted(MIXED_SOURCES)],
        'total_samples': int(len(clean))
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    requested_version = None
    if '--version' in sys.argv:
        version_index = sys.argv.index('--version') + 1
        if version_index < len(sys.argv):
            requested_version = sys.argv[version_index]
    use_observations = '--no-observations' not in sys.argv
    promote = '--promote' in sys.argv
    raise SystemExit(main(requested_version, use_observations=use_observations, promote=promote))
