import os
import sys
import json
import urllib.request
import warnings
import pandas as pd
import numpy as np
import joblib

# ML Ensemble libraries
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, fbeta_score, roc_auc_score, average_precision_score,
    log_loss, brier_score_loss, matthews_corrcoef, confusion_matrix
)
from lightgbm import LGBMClassifier
from xgboost import XGBClassifier
from catboost import CatBoostClassifier

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
VERSIONS_DIR = os.path.join(MODEL_DIR, 'versions')
MODEL_PATH = os.path.join(MODEL_DIR, 'forex_m5_model.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'model_registry.json')
# Ask the API for only closed Forex trades with the complete feature set.
# The endpoint returns up to 5,000 rows so new valid trades are not silently
# dropped by the normal dashboard limit.
API_URL = 'http://localhost:3000/api/trade-results?market=forex&ready_for_retrain=true&limit=5000'
OBSERVATION_API_URL = 'http://localhost:3000/api/forex-ml-observations?ready_for_retrain=true&limit=5000'
OBSERVATION_WEIGHT = 5

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'macd_hist', 'csm_spread', 'h1_trend_slope',
    'is_jpy', 'time_sin_hour', 'time_cos_hour', 'spread_to_atr'
]


def load_valid_observations():
    """Load labeled, MT5-sourced observations with the Champion feature schema."""
    try:
        req = urllib.request.Request(OBSERVATION_API_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode('utf-8'))

        if not isinstance(payload, list) or not payload:
            return pd.DataFrame()

        raw = pd.DataFrame(payload)
        required = [
            'symbol', 'bar_time', 'outcome_status', 'data_source', 'sample_kind',
            'target_buy', 'target_sell', *FEATURE_COLS
        ]
        missing = [column for column in required if column not in raw.columns]
        if missing:
            raise ValueError(f'Missing observation columns: {missing}')

        valid = raw[
            (raw['outcome_status'] == 'LABELED') &
            (raw['data_source'] == 'mt5') &
            (raw['sample_kind'] != 'RANGE_EXCLUDED') &
            (raw['target_buy'].notna()) &
            (raw['target_sell'].notna()) &
            (raw['symbol'].notna()) &
            (raw['bar_time'].notna())
        ].copy()

        for column in FEATURE_COLS + ['target_buy', 'target_sell']:
            valid[column] = pd.to_numeric(valid[column], errors='coerce')
        valid['_event_time'] = pd.to_datetime(valid['bar_time'], errors='coerce', utc=True)
        valid = valid.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell', '_event_time'])
        return valid.reset_index(drop=True)
    except Exception as exc:
        print(f'⚠️ New Forex ML observations unavailable: {exc}')
        return pd.DataFrame()

def apply_triple_barrier_labeling(df):
    """
    Applies Triple Barrier Method:
    - Upper Barrier (TP): +1.5 * ATR
    - Lower Barrier (SL): -1.0 * ATR
    - Horizontal Time Barrier: 5 bars
    """
    atr_up = df['atr_pct'] * 1.5
    atr_dn = df['atr_pct'] * 1.0

    target_buy = np.where((df['target_ret_5'] >= atr_up) & (df['ret_1'] >= 0), 1, 0)
    target_sell = np.where((df['target_ret_5'] <= -atr_dn) & (df['ret_1'] <= 0), 1, 0)

    df['target_buy'] = target_buy
    df['target_sell'] = target_sell
    return df

def retrain_from_live_results(target_version=None, dry_run=False):
    print('=' * 75)
    print('🚀 เริ่มกระบวนการ Retrain โมเดล Tri-Ensemble (LightGBM + XGBoost + CatBoost + RF)')
    print('=' * 75)

    df_live = pd.DataFrame()
    try:
        req = urllib.request.Request(API_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, list) and len(data) > 0:
                raw_df = pd.DataFrame(data)
                required_result_cols = [
                    'market_type', 'exit_reason', 'is_win', 'action',
                    'entry_time', 'entry_price', 'rsi', 'adx', 'atr',
                    'ema21', 'ema50', 'macd_hist'
                ]
                missing_cols = [col for col in required_result_cols if col not in raw_df.columns]
                if missing_cols:
                    raise ValueError(f'Missing retrain columns: {missing_cols}')
                valid = raw_df[
                    (raw_df['market_type'] == 'forex') &
                    (~raw_df['exit_reason'].isin(['OPEN', 'SYNC_PENDING'])) &
                    (raw_df['is_win'].notna()) &
                    (raw_df['action'].isin(['BUY', 'SELL'])) &
                    (raw_df['entry_time'].notna()) &
                    (raw_df['entry_price'].notna()) &
                    (raw_df['rsi'].notna()) &
                    (raw_df['adx'].notna()) &
                    (raw_df['atr'].notna()) &
                    (raw_df['ema21'].notna()) &
                    (raw_df['ema50'].notna()) &
                    (raw_df['macd_hist'].notna())
                ].copy()
                df_live = valid.copy()
                print(f"[*] ดึงข้อมูลผลการเทรดจริงจาก API สำเร็จ: {len(df_live)} ไม้ที่ปิดแล้ว")
    except Exception as e:
        print(f"⚠️ ไม่สามารถเชื่อมต่อ API trade-results (จะใช้ข้อมูลประวัติศาสตร์ล้วน): {e}")

    # Load the isolated labeled observation stream separately. These rows
    # contain the complete feature vector captured at decision time and should
    # not be reconstructed from trade_results.
    df_observations = load_valid_observations()
    print(f"[*] Labeled MT5 observations available for Champion retrain: {len(df_observations)} rows")

    # 1. Load baseline historical dataset
    base_data_path = os.path.join(ROOT_DIR, "data", "dataset_forex_m5.csv")
    if not os.path.exists(base_data_path):
        print(f"❌ ไม่พบไฟล์ประวัติ {base_data_path}")
        return { "success": False, "error": f"Missing dataset {base_data_path}" }

    df_base = pd.read_csv(base_data_path)
    df_base = apply_triple_barrier_labeling(df_base)

    # Fill default values for new features if missing in historical data
    if 'csm_spread' not in df_base.columns:
        df_base['csm_spread'] = 0.0
    if 'h1_trend_slope' not in df_base.columns:
        df_base['h1_trend_slope'] = 0.0
    if 'is_jpy' not in df_base.columns:
        if 'symbol' in df_base.columns:
            df_base['is_jpy'] = df_base['symbol'].astype(str).str.contains('JPY').astype(float)
        else:
            df_base['is_jpy'] = 0.0
    if 'time_sin_hour' not in df_base.columns or 'time_cos_hour' not in df_base.columns:
        if 'time' in df_base.columns:
            try:
                base_dt = pd.to_datetime(df_base['time'], errors='coerce')
                hrs = base_dt.dt.hour + (base_dt.dt.minute / 60.0)
                df_base['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
                df_base['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)
            except Exception:
                df_base['time_sin_hour'] = 0.0
                df_base['time_cos_hour'] = 0.0
        else:
            df_base['time_sin_hour'] = 0.0
            df_base['time_cos_hour'] = 0.0
    if 'spread_to_atr' not in df_base.columns:
        df_base['spread_to_atr'] = 0.02

    df_base['_event_time'] = pd.to_datetime(df_base.get('time'), errors='coerce', utc=True)
    clean_base = df_base.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell'])

    # 2. Integrate Live Trade Results with Triple Barrier outcomes
    training_parts = []
    base_part = clean_base[FEATURE_COLS + ['target_buy', 'target_sell']].copy()
    base_part['_event_time'] = clean_base['_event_time'].values
    training_parts.append(base_part)

    if len(df_live) >= 4:
        win_rate = float(df_live['is_win'].mean())
        print(f"✅ ทำการผสมข้อมูลผลการเทรดจริง ({len(df_live)} ไม้, Win Rate: {win_rate:.1%}) เข้าสู่ชุดฝึกสอน")
        
        df_live['ret_1'] = 0.0
        df_live['ret_5'] = df_live['pips'].astype(float) * 0.0001
        df_live['rsi_14'] = df_live['rsi'].astype(float)
        df_live['atr_pct'] = df_live['atr'].astype(float) / (df_live['entry_price'].astype(float) + 1e-12)
        df_live['adx_14'] = df_live['adx'].astype(float)
        df_live['ema_spread_20_50'] = (df_live['ema21'].astype(float) - df_live['ema50'].astype(float)) / (df_live['entry_price'].astype(float) + 1e-12)
        df_live['macd_hist'] = df_live['macd_hist'].astype(float)
        df_live['csm_spread'] = 0.0
        df_live['h1_trend_slope'] = 0.0

        # Features for Phase 3
        df_live['is_jpy'] = df_live['symbol'].astype(str).str.contains('JPY').astype(float)
        try:
            live_dt = pd.to_datetime(df_live['entry_time'], errors='coerce')
            hrs = live_dt.dt.hour + (live_dt.dt.minute / 60.0)
            df_live['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
            df_live['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)
        except Exception:
            df_live['time_sin_hour'] = 0.0
            df_live['time_cos_hour'] = 0.0

        spread_pips = np.where(df_live['is_jpy'] == 1.0, 0.02, 0.00015)
        df_live['spread_to_atr'] = spread_pips / (df_live['atr'].astype(float) + 1e-12)

        # Triple barrier labeling from realized trades:
        # If BUY won, it hit upper barrier. If BUY lost, selling would have hit lower barrier.
        df_live['target_buy'] = np.where((df_live['action'] == 'BUY') & (df_live['is_win'] == 1), 1, 0)
        df_live['target_sell'] = np.where((df_live['action'] == 'SELL') & (df_live['is_win'] == 1), 1, 0)

        # Weight realized trades x5, while retaining their chronological time.
        df_live['_event_time'] = pd.to_datetime(df_live['entry_time'], errors='coerce', utc=True)
        live_part = df_live[FEATURE_COLS + ['target_buy', 'target_sell', '_event_time']].copy()
        live_samples = pd.concat([live_part] * OBSERVATION_WEIGHT, ignore_index=True)
        training_parts.append(live_samples)
        combined_df = pd.concat(training_parts, ignore_index=True)
        print(f"[*] รวมชุดข้อมูลประวัติ + ประสบการณ์จริง: ทั้งหมด {len(combined_df):,} ตัวอย่าง")
    else:
        print(f"ℹ️ ข้อมูลผลการเทรดจริงยังมีน้อย ({len(df_live)} ไม้) ดำเนินการเทรนบนฐานข้อมูลประวัติศาสตร์เต็มรูปแบบ ({len(clean_base):,} แถว)")
        combined_df = pd.concat(training_parts, ignore_index=True)

    # Add the labeled observation stream.  These samples include SIGNAL,
    # REJECTED and NO_TRADE decisions, which gives Champion negative examples
    # that never became broker orders.  Weight them like realized trades while
    # keeping the historical CSV as the majority anchor.
    if len(df_observations) >= 4:
        observation_part = df_observations[
            FEATURE_COLS + ['target_buy', 'target_sell', '_event_time']
        ].copy()
        observation_samples = pd.concat(
            [observation_part] * OBSERVATION_WEIGHT,
            ignore_index=True
        )
        training_parts.append(observation_samples)
        print(
            f"✅ เพิ่ม labeled observations {len(df_observations)} แถว "
            f"(weight x{OBSERVATION_WEIGHT})"
        )
    else:
        print(f"⚠️ labeled observations มีเพียง {len(df_observations)} แถว จึงยังไม่เพิ่มเข้า train")

    # Keep validation chronological across historical, realized and observed
    # samples.  The previous implementation appended live rows after the
    # historical CSV, which made the temporal split less representative.
    combined_df = pd.concat(training_parts, ignore_index=True)
    combined_df['_event_time'] = pd.to_datetime(
        combined_df['_event_time'], errors='coerce', utc=True
    )
    combined_df = combined_df.sort_values(
        by='_event_time', na_position='first'
    ).reset_index(drop=True)
    print(
        f"[*] รวมข้อมูล historical {len(clean_base):,} + "
        f"live {len(df_live):,} + observations {len(df_observations):,} "
        f"(หลัง weighting รวม {len(combined_df):,} rows)"
    )

    if dry_run:
        split_idx = int(len(combined_df) * 0.8)
        preview = {
            'success': True,
            'dry_run': True,
            'historical_samples': int(len(clean_base)),
            'live_trade_samples': int(len(df_live)),
            'observation_samples': int(len(df_observations)),
            'observation_weight': OBSERVATION_WEIGHT,
            'weighted_total_samples': int(len(combined_df)),
            'train_samples': int(split_idx),
            'validation_samples': int(len(combined_df) - split_idx),
            'observation_source': 'forex_ml_observations',
        }
        print(
            f"[dry-run] train={preview['train_samples']:,} | "
            f"validation={preview['validation_samples']:,} | "
            f"weighted_total={preview['weighted_total_samples']:,}"
        )
        return preview

    # Train / Validation Split (80/20 Chronological Split)
    split_idx = int(len(combined_df) * 0.8)
    train_df = combined_df.iloc[:split_idx]
    val_df = combined_df.iloc[split_idx:]

    X_train = train_df[FEATURE_COLS]
    X_val = val_df[FEATURE_COLS]

    y_buy_train = train_df['target_buy']
    y_buy_val = val_df['target_buy']

    y_sell_train = train_df['target_sell']
    y_sell_val = val_df['target_sell']

    print("\n🧠 กำลังฝึกสอน Tri-Ensemble (BUY Model)...")
    # 1. LightGBM BUY
    lgb_buy = LGBMClassifier(n_estimators=140, learning_rate=0.035, max_depth=5, num_leaves=25, random_state=42, verbose=-1)
    lgb_buy.fit(X_train, y_buy_train)

    # 2. XGBoost BUY
    xgb_buy = XGBClassifier(n_estimators=120, learning_rate=0.04, max_depth=4, eval_metric='logloss', random_state=42)
    xgb_buy.fit(X_train, y_buy_train)

    # 3. CatBoost BUY
    cat_buy = CatBoostClassifier(iterations=120, learning_rate=0.04, depth=5, random_seed=42, verbose=0)
    cat_buy.fit(X_train, y_buy_train)

    # 4. Random Forest BUY
    # Use one worker for reliable Windows service/sandbox execution.
    rf_buy = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42, n_jobs=1)
    rf_buy.fit(X_train, y_buy_train)

    # Evaluate BUY Ensemble on validation set
    p_lgb_b = lgb_buy.predict_proba(X_val)[:, 1]
    p_xgb_b = xgb_buy.predict_proba(X_val)[:, 1]
    p_cat_b = cat_buy.predict_proba(X_val)[:, 1]
    p_rf_b = rf_buy.predict_proba(X_val)[:, 1]
    p_ensemble_buy = 0.35 * p_lgb_b + 0.25 * p_xgb_b + 0.25 * p_cat_b + 0.15 * p_rf_b

    try:
        auc_buy = roc_auc_score(y_buy_val, p_ensemble_buy)
    except:
        auc_buy = 0.70

    print(f"   >>> BUY Tri-Ensemble Validation AUC: {auc_buy:.4f}")

    print("\n🧠 กำลังฝึกสอน Tri-Ensemble (SELL Model)...")
    # 1. LightGBM SELL
    lgb_sell = LGBMClassifier(n_estimators=140, learning_rate=0.035, max_depth=5, num_leaves=25, random_state=42, verbose=-1)
    lgb_sell.fit(X_train, y_sell_train)

    # 2. XGBoost SELL
    xgb_sell = XGBClassifier(n_estimators=120, learning_rate=0.04, max_depth=4, eval_metric='logloss', random_state=42)
    xgb_sell.fit(X_train, y_sell_train)

    # 3. CatBoost SELL
    cat_sell = CatBoostClassifier(iterations=120, learning_rate=0.04, depth=5, random_seed=42, verbose=0)
    cat_sell.fit(X_train, y_sell_train)

    # 4. Random Forest SELL
    rf_sell = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42, n_jobs=1)
    rf_sell.fit(X_train, y_sell_train)

    # Evaluate SELL Ensemble on validation set
    p_lgb_s = lgb_sell.predict_proba(X_val)[:, 1]
    p_xgb_s = xgb_sell.predict_proba(X_val)[:, 1]
    p_cat_s = cat_sell.predict_proba(X_val)[:, 1]
    p_rf_s = rf_sell.predict_proba(X_val)[:, 1]
    p_ensemble_sell = 0.35 * p_lgb_s + 0.25 * p_xgb_s + 0.25 * p_cat_s + 0.15 * p_rf_s

    try:
        auc_sell = roc_auc_score(y_sell_val, p_ensemble_sell)
    except:
        auc_sell = 0.70

    # 1. Evaluate BUY & SELL 10 Standard Metrics
    def evaluate_suite(y_true, y_prob):
        cand_thresholds = np.linspace(y_prob.min() + 0.001, y_prob.max() - 0.001, 60)
        best_th = float(np.median(y_prob))
        best_f05 = -1
        for th in cand_thresholds:
            pred_th = (y_prob >= th).astype(int)
            if pred_th.sum() >= 40:
                score = fbeta_score(y_true, pred_th, beta=0.5, zero_division=0)
                if score > best_f05:
                    best_f05 = score
                    best_th = float(th)

        y_pred = (y_prob >= best_th).astype(int)
        cm = confusion_matrix(y_true, y_pred)
        tn, fp, fn, tp = cm.ravel()
        spec = float(tn / (tn + fp)) if (tn + fp) > 0 else 0.0

        return {
            'threshold': round(best_th, 4),
            'accuracy': round(float(accuracy_score(y_true, y_pred)), 4),
            'precision': round(float(precision_score(y_true, y_pred, zero_division=0)), 4),
            'recall': round(float(recall_score(y_true, y_pred, zero_division=0)), 4),
            'specificity': round(spec, 4),
            'f1': round(float(f1_score(y_true, y_pred, zero_division=0)), 4),
            'f05': round(float(fbeta_score(y_true, y_pred, beta=0.5, zero_division=0)), 4),
            'roc_auc': round(float(roc_auc_score(y_true, y_prob)), 4),
            'pr_auc': round(float(average_precision_score(y_true, y_prob)), 4),
            'log_loss': round(float(log_loss(y_true, y_prob)), 4),
            'brier': round(float(brier_score_loss(y_true, y_prob)), 4),
            'mcc': round(float(matthews_corrcoef(y_true, y_pred)), 4)
        }

    m_buy = evaluate_suite(y_buy_val, p_ensemble_buy)
    m_sell = evaluate_suite(y_sell_val, p_ensemble_sell)
    auc_buy = m_buy['roc_auc']
    auc_sell = m_sell['roc_auc']

    print(f"   >>> BUY Tri-Ensemble Validation AUC: {auc_buy:.4f}")
    print(f"   >>> SELL Tri-Ensemble Validation AUC: {auc_sell:.4f}")

    # 2. Versioning in Registry
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    next_ver = target_version or "v1.2.0"
    reg = {"active_version": next_ver, "versions": []}
    if os.path.exists(REGISTRY_PATH):
        try:
            with open(REGISTRY_PATH, 'r', encoding='utf-8') as f:
                reg = json.load(f)
            prev_ver = reg.get('active_version', 'v1.1.0')
            parts = prev_ver.replace('v', '').split('.')
            if target_version is None and len(parts) == 3:
                next_ver = f"v{parts[0]}.{int(parts[1]) + 1}.0"
        except Exception:
            pass

    version_filename = f"forex_m5_model_{next_ver}.joblib"
    version_file_rel = f"versions/{version_filename}"
    version_file_abs = os.path.join(VERSIONS_DIR, version_filename)

    bundle = {
        'version': next_ver,
        'architecture': 'Tri-Ensemble (LightGBM + XGBoost + CatBoost + Random Forest)',
        'lgb_buy': lgb_buy,
        'xgb_buy': xgb_buy,
        'cat_buy': cat_buy,
        'rf_buy': rf_buy,
        'lgb_sell': lgb_sell,
        'xgb_sell': xgb_sell,
        'cat_sell': cat_sell,
        'rf_sell': rf_sell,
        'features': FEATURE_COLS,
        'weights': {
            'lightgbm': 0.35,
            'xgboost': 0.25,
            'catboost': 0.25,
            'random_forest': 0.15
        },
        'auc_buy': auc_buy,
        'auc_sell': auc_sell,
        'historical_samples_count': len(clean_base),
        'live_samples_count': len(df_live),
        'observation_samples_count': len(df_observations),
        'observation_weight': OBSERVATION_WEIGHT,
        'training_source': 'dataset_forex_m5 + trade_results + forex_ml_observations',
        'total_samples_count': len(combined_df),
        'trained_at': pd.Timestamp.now().isoformat()
    }

    # Save active model + versioned archive
    joblib.dump(bundle, MODEL_PATH)
    joblib.dump(bundle, version_file_abs)

    # Append to Registry
    new_reg_entry = {
        "version": next_ver,
        "created_at": bundle['trained_at'],
        "description": (
            f"Retrained Tri-Ensemble incorporating {len(df_live)} live DB trades "
            f"and {len(df_observations)} labeled Forex ML observations"
        ),
        "file": version_file_rel,
        "dataset": {
            "total_samples": len(combined_df),
            "historical_samples": len(clean_base),
            "live_trade_samples": len(df_live),
            "observation_samples": len(df_observations),
            "observation_weight": OBSERVATION_WEIGHT,
            "training_source": "dataset_forex_m5 + trade_results + forex_ml_observations",
            "train_samples": len(train_df),
            "test_samples": len(val_df),
            "positive_rate_buy": round(float(y_buy_val.mean()), 4),
            "positive_rate_sell": round(float(y_sell_val.mean()), 4)
        },
        "architecture": bundle['architecture'],
        "weights": bundle['weights'],
        "features": FEATURE_COLS,
        "parameters": {
            "lightgbm": {"n_estimators": 140, "learning_rate": 0.035, "max_depth": 5, "num_leaves": 25},
            "xgboost": {"n_estimators": 120, "learning_rate": 0.04, "max_depth": 4, "eval_metric": "logloss"},
            "catboost": {"iterations": 120, "learning_rate": 0.04, "depth": 5},
            "random_forest": {"n_estimators": 100, "max_depth": 6}
        },
        "metrics": {
            "roc_auc_buy": m_buy['roc_auc'],
            "roc_auc_sell": m_sell['roc_auc'],
            "pr_auc_buy": m_buy['pr_auc'],
            "pr_auc_sell": m_sell['pr_auc'],
            "accuracy_buy": m_buy['accuracy'],
            "accuracy_sell": m_sell['accuracy'],
            "precision_buy": m_buy['precision'],
            "precision_sell": m_sell['precision'],
            "recall_buy": m_buy['recall'],
            "recall_sell": m_sell['recall'],
            "specificity_buy": m_buy['specificity'],
            "specificity_sell": m_sell['specificity'],
            "f1_buy": m_buy['f1'],
            "f1_sell": m_sell['f1'],
            "f05_buy": m_buy['f05'],
            "f05_sell": m_sell['f05'],
            "log_loss_buy": m_buy['log_loss'],
            "log_loss_sell": m_sell['log_loss'],
            "brier_buy": m_buy['brier'],
            "brier_sell": m_sell['brier'],
            "mcc_buy": m_buy['mcc'],
            "mcc_sell": m_sell['mcc']
        }
    }

    reg['active_version'] = next_ver
    reg['versions'] = [v for v in reg.get('versions', []) if v['version'] != next_ver]
    reg['versions'].append(new_reg_entry)

    with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
        json.dump(reg, f, indent=2, ensure_ascii=False)

    print(f"\n🎉 บันทึกและลงทะเบียนโมเดลเวอร์ชันใหม่ [{next_ver}] สำเร็จที่: {MODEL_PATH}")
    print(f"📦 สำเนาเก็บถาวร (Archive): {version_file_abs}")
    print(f"📊 สรุปผล: ตัวอย่าง {len(combined_df):,} แถว (จาก Live {len(df_live)} ไม้) | AUC BUY: {auc_buy:.2%} | AUC SELL: {auc_sell:.2%}")

    return {
        "success": True,
        "version": next_ver,
        "model_path": MODEL_PATH,
        "archive_path": version_file_abs,
        "auc_buy": auc_buy,
        "auc_sell": auc_sell,
        "total_samples": len(combined_df),
        "live_samples": len(df_live),
        "observation_samples": len(df_observations),
        "observation_weight": OBSERVATION_WEIGHT,
        "architecture": bundle['architecture'],
        "trained_at": bundle['trained_at']
    }

if __name__ == '__main__':
    requested_version = None
    if '--version' in sys.argv:
        version_index = sys.argv.index('--version') + 1
        if version_index < len(sys.argv):
            requested_version = sys.argv[version_index]
    result = retrain_from_live_results(
        requested_version,
        dry_run='--dry-run' in sys.argv
    )
    if '--json' in sys.argv:
        print(json.dumps(result))
