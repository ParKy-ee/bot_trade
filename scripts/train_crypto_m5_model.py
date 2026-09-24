import sys
import os
import json
import warnings
import pandas as pd
import numpy as np
import joblib

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

from sklearn.ensemble import RandomForestClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, fbeta_score, roc_auc_score, average_precision_score,
    log_loss, brier_score_loss, matthews_corrcoef
)
from lightgbm import LGBMClassifier
from xgboost import XGBClassifier

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_crypto_m5.csv")
MODEL_DIR = os.path.join(ROOT_DIR, "python", "models")
VERSIONS_DIR = os.path.join(MODEL_DIR, "versions")
MODEL_PATH = os.path.join(MODEL_DIR, "crypto_m5_model.joblib")
REGISTRY_PATH = os.path.join(MODEL_DIR, "crypto_model_registry.json")

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'ema_spread_50_200', 'macd_hist',
    'volume_ratio', 'bb_width',
    'btc_ret_5', 'btc_corr_divergence', 'is_weekend',
    'vwap_distance_pct', 'distance_to_swing_high_low', 'funding_window_proximity'
]

def calc_metrics(y_true, y_prob, thresh=0.5):
    y_pred = (y_prob >= thresh).astype(int)
    roc_auc = roc_auc_score(y_true, y_prob) if len(np.unique(y_true)) > 1 else 0.5
    pr_auc = average_precision_score(y_true, y_prob) if len(np.unique(y_true)) > 1 else 0.0
    acc = accuracy_score(y_true, y_pred)
    prec = precision_score(y_true, y_pred, zero_division=0)
    rec = recall_score(y_true, y_pred, zero_division=0)
    f1 = f1_score(y_true, y_pred, zero_division=0)
    f2 = fbeta_score(y_true, y_pred, beta=2, zero_division=0)
    mcc = matthews_corrcoef(y_true, y_pred) if len(np.unique(y_pred)) > 1 else 0.0
    ll = log_loss(y_true, np.clip(y_prob, 1e-6, 1 - 1e-6))
    brier = brier_score_loss(y_true, y_prob)
    
    # Specificity
    tn = np.sum((y_true == 0) & (y_pred == 0))
    fp = np.sum((y_true == 0) & (y_pred == 1))
    spec = tn / (tn + fp + 1e-9)
    
    return {
        "roc_auc": round(float(roc_auc), 4),
        "pr_auc": round(float(pr_auc), 4),
        "accuracy": round(float(acc), 4),
        "precision": round(float(prec), 4),
        "recall": round(float(rec), 4),
        "specificity": round(float(spec), 4),
        "f1": round(float(f1), 4),
        "f2": round(float(f2), 4),
        "mcc": round(float(mcc), 4),
        "log_loss": round(float(ll), 4),
        "brier": round(float(brier), 4)
    }

def train_crypto_model():
    print("=" * 80)
    print("🧠 กำลังเทรนโมเดล Crypto Tri-Ensemble v2.0.0 (16 Microstructure & Quant Features)")
    print("=" * 80)

    if not os.path.exists(DATA_PATH):
        print(f"❌ ไม่พบไฟล์ชุดข้อมูล {DATA_PATH}")
        sys.exit(1)

    df = pd.read_csv(DATA_PATH)
    print(f"[*] โหลดข้อมูล Crypto สำเร็จ: {len(df):,} แถว ({df['symbol'].nunique()} เหรียญ: {', '.join(df['symbol'].unique())})")

    clean_df = df.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).copy()
    
    # Time-based split per symbol to preserve market microstructure sequence
    train_dfs = []
    test_dfs = []
    for sym in clean_df['symbol'].unique():
        sym_df = clean_df[clean_df['symbol'] == sym]
        split = int(len(sym_df) * 0.8)
        train_dfs.append(sym_df.iloc[:split])
        test_dfs.append(sym_df.iloc[split:])
        
    train_df = pd.concat(train_dfs, ignore_index=True)
    test_df = pd.concat(test_dfs, ignore_index=True)

    X_train = train_df[FEATURE_COLS]
    y_buy_train = train_df['target_buy']
    y_sell_train = train_df['target_sell']

    X_test = test_df[FEATURE_COLS]
    y_buy_test = test_df['target_buy']
    y_sell_test = test_df['target_sell']

    print(f"[*] จำนวนข้อมูลสำหรับเทรน (Train Set): {len(X_train):,} แถว")
    print(f"[*] จำนวนข้อมูลสำหรับทดสอบ (Test Set): {len(X_test):,} แถว")
    print(f"[*] จำนวน Features ทั้งหมด: {len(FEATURE_COLS)} ตัวแปร")
    print(f"[*] สัดส่วน Target Buy: {clean_df['target_buy'].mean():.1%} | Target Sell: {clean_df['target_sell'].mean():.1%}")

    # ==========================================
    # 1. Train BUY Tri-Ensemble with Calibration
    # ==========================================
    print("\n🚀 [1/2] กำลังเทรนโมเดล BUY Signal Tri-Ensemble (LightGBM + XGBoost + Random Forest)...")
    base_lgb_buy = LGBMClassifier(
        n_estimators=150, learning_rate=0.03, max_depth=5, num_leaves=31,
        subsample=0.8, colsample_bytree=0.8, random_state=42, verbose=-1
    )
    lgb_buy = CalibratedClassifierCV(base_lgb_buy, cv=3, method='sigmoid')
    lgb_buy.fit(X_train, y_buy_train)

    base_xgb_buy = XGBClassifier(
        n_estimators=140, learning_rate=0.035, max_depth=4,
        subsample=0.8, colsample_bytree=0.8, random_state=42,
        eval_metric="logloss", verbosity=0
    )
    xgb_buy = CalibratedClassifierCV(base_xgb_buy, cv=3, method='sigmoid')
    xgb_buy.fit(X_train, y_buy_train)

    base_rf_buy = RandomForestClassifier(
        n_estimators=120, max_depth=6, random_state=42, n_jobs=-1
    )
    rf_buy = CalibratedClassifierCV(base_rf_buy, cv=3, method='sigmoid')
    rf_buy.fit(X_train, y_buy_train)

    p_buy = (
        0.40 * lgb_buy.predict_proba(X_test)[:, 1] +
        0.35 * xgb_buy.predict_proba(X_test)[:, 1] +
        0.25 * rf_buy.predict_proba(X_test)[:, 1]
    )
    m_buy = calc_metrics(y_buy_test, p_buy)
    print(f"   ✓ BUY Metrics: ROC-AUC={m_buy['roc_auc']} | F1={m_buy['f1']} | PR-AUC={m_buy['pr_auc']} | Accuracy={m_buy['accuracy']} | Brier={m_buy['brier']}")

    # ==========================================
    # 2. Train SELL Tri-Ensemble with Calibration
    # ==========================================
    print("\n🚀 [2/2] กำลังเทรนโมเดล SELL Signal Tri-Ensemble (LightGBM + XGBoost + Random Forest)...")
    base_lgb_sell = LGBMClassifier(
        n_estimators=150, learning_rate=0.03, max_depth=5, num_leaves=31,
        subsample=0.8, colsample_bytree=0.8, random_state=42, verbose=-1
    )
    lgb_sell = CalibratedClassifierCV(base_lgb_sell, cv=3, method='sigmoid')
    lgb_sell.fit(X_train, y_sell_train)

    base_xgb_sell = XGBClassifier(
        n_estimators=140, learning_rate=0.035, max_depth=4,
        subsample=0.8, colsample_bytree=0.8, random_state=42,
        eval_metric="logloss", verbosity=0
    )
    xgb_sell = CalibratedClassifierCV(base_xgb_sell, cv=3, method='sigmoid')
    xgb_sell.fit(X_train, y_sell_train)

    base_rf_sell = RandomForestClassifier(
        n_estimators=120, max_depth=6, random_state=42, n_jobs=-1
    )
    rf_sell = CalibratedClassifierCV(base_rf_sell, cv=3, method='sigmoid')
    rf_sell.fit(X_train, y_sell_train)

    p_sell = (
        0.40 * lgb_sell.predict_proba(X_test)[:, 1] +
        0.35 * xgb_sell.predict_proba(X_test)[:, 1] +
        0.25 * rf_sell.predict_proba(X_test)[:, 1]
    )
    m_sell = calc_metrics(y_sell_test, p_sell)
    print(f"   ✓ SELL Metrics: ROC-AUC={m_sell['roc_auc']} | F1={m_sell['f1']} | PR-AUC={m_sell['pr_auc']} | Accuracy={m_sell['accuracy']} | Brier={m_sell['brier']}")

    # ==========================================
    # 3. Save Model Bundle & Versioning
    # ==========================================
    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs(VERSIONS_DIR, exist_ok=True)

    version_str = "v2.0.0"
    bundle = {
        "version": version_str,
        "market": "crypto",
        "lgb_buy": lgb_buy,
        "xgb_buy": xgb_buy,
        "rf_buy": rf_buy,
        "lgb_sell": lgb_sell,
        "xgb_sell": xgb_sell,
        "rf_sell": rf_sell,
        "features": FEATURE_COLS,
        "metrics_buy": m_buy,
        "metrics_sell": m_sell,
        "trained_at": pd.Timestamp.now().isoformat()
    }

    # Save active model
    joblib.dump(bundle, MODEL_PATH)
    # Save version archive
    version_file = f"versions/crypto_m5_model_{version_str}.joblib"
    version_path = os.path.join(MODEL_DIR, version_file)
    joblib.dump(bundle, version_path)
    print(f"\n✅ บันทึกโมเดลหลักสำเร็จ: {MODEL_PATH}")
    print(f"📦 บันทึกสำเนาเวอร์ชัน: {version_path}")

    # ==========================================
    # 4. Update Crypto Model Registry
    # ==========================================
    registry_entry = {
        "version": version_str,
        "created_at": pd.Timestamp.now().isoformat(),
        "description": "Upgraded Crypto M5 Calibrated Tri-Ensemble with 16 Microstructure & BTC Cross-Correlation Features",
        "file": version_file,
        "dataset": {
            "source": "Binance Public REST API (Klines M5 - BTC, ETH, SOL)",
            "symbols": list(clean_df['symbol'].unique()),
            "total_samples": int(len(clean_df)),
            "train_samples": int(len(X_train)),
            "test_samples": int(len(X_test)),
            "positive_rate_buy": round(float(clean_df['target_buy'].mean()), 4),
            "positive_rate_sell": round(float(clean_df['target_sell'].mean()), 4)
        },
        "architecture": "Calibrated Tri-Ensemble (LightGBM 40% + XGBoost 35% + Random Forest 25% with Sigmoid Calibration)",
        "weights": {
            "lightgbm": 0.40,
            "xgboost": 0.35,
            "random_forest": 0.25
        },
        "features": FEATURE_COLS,
        "metrics": {
            "roc_auc_buy": m_buy["roc_auc"],
            "roc_auc_sell": m_sell["roc_auc"],
            "pr_auc_buy": m_buy["pr_auc"],
            "pr_auc_sell": m_sell["pr_auc"],
            "accuracy_buy": m_buy["accuracy"],
            "accuracy_sell": m_sell["accuracy"],
            "precision_buy": m_buy["precision"],
            "precision_sell": m_sell["precision"],
            "recall_buy": m_buy["recall"],
            "recall_sell": m_sell["recall"],
            "specificity_buy": m_buy["specificity"],
            "specificity_sell": m_sell["specificity"],
            "f1_buy": m_buy["f1"],
            "f1_sell": m_sell["f1"],
            "f2_buy": m_buy["f2"],
            "f2_sell": m_sell["f2"],
            "mcc_buy": m_buy["mcc"],
            "mcc_sell": m_sell["mcc"],
            "log_loss_buy": m_buy["log_loss"],
            "log_loss_sell": m_sell["log_loss"],
            "brier_buy": m_buy["brier"],
            "brier_sell": m_sell["brier"]
        }
    }

    # Load existing registry and append new version
    registry_data = {"active_version": version_str, "market": "crypto", "versions": []}
    if os.path.exists(REGISTRY_PATH):
        try:
            with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
                registry_data = json.load(f)
        except Exception:
            pass
            
    registry_data["active_version"] = version_str
    # Filter out if v2.0.0 already in versions
    registry_data["versions"] = [v for v in registry_data.get("versions", []) if v.get("version") != version_str]
    registry_data["versions"].append(registry_entry)

    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(registry_data, f, indent=2, ensure_ascii=False)

    print(f"🏷️  อัปเดต Crypto Model Registry สำเร็จ (Active: {version_str}): {REGISTRY_PATH}")
    print("=" * 80)

if __name__ == "__main__":
    train_crypto_model()
