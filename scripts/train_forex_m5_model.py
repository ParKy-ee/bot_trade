import sys
import os
import json
import warnings

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")
import pandas as pd
import numpy as np
import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, accuracy_score, precision_score
from lightgbm import LGBMClassifier

warnings.filterwarnings("ignore")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_forex_m5.csv")
MODEL_DIR = os.path.join(ROOT_DIR, "python", "models")
MODEL_PATH = os.path.join(MODEL_DIR, "forex_m5_model.joblib")

def train_forex_model():
    print("=" * 70)
    print("🧠 กำลังเทรนโมเดล AI / Machine Learning แยกเฉพาะสำหรับ Forex M5")
    print("=" * 70)

    if not os.path.exists(DATA_PATH):
        print(f"❌ ไม่พบไฟล์ชุดข้อมูล {DATA_PATH}")
        return

    df = pd.read_csv(DATA_PATH)
    print(f"[*] โหลดข้อมูล Forex M5 สำเร็จ: {len(df):,} แถว ({df['symbol'].nunique()} คู่เงิน)")

    # 1. Feature Engineering & Clean Target
    # For M5 Scalping: Target 1 = price moves favorably by >= 0.8 * ATR within 5 bars
    # Target 0 = price stays flat or reverses
    df['atr_thresh'] = df['atr_pct'] * 0.8
    df['target_buy'] = (df['target_ret_5'] >= df['atr_thresh']).astype(int)
    df['target_sell'] = (df['target_ret_5'] <= -df['atr_thresh']).astype(int)

    feature_cols = [
        'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
        'ema_spread_20_50', 'macd_hist'
    ]

    # Drop NaN
    clean_df = df.dropna(subset=feature_cols + ['target_buy', 'target_sell'])
    print(f"[*] ข้อมูลที่สมบูรณ์หลังคลีน: {len(clean_df):,} แถว")
    print(f"[*] สัดส่วนสัญญาณ Buy Scalp: {clean_df['target_buy'].mean():.1%}")
    print(f"[*] สัดส่วนสัญญาณ Sell Scalp: {clean_df['target_sell'].mean():.1%}")

    # Time-based Train / Test Split (80% train, 20% test)
    split_idx = int(len(clean_df) * 0.8)
    train_df = clean_df.iloc[:split_idx]
    test_df = clean_df.iloc[split_idx:]

    X_train = train_df[feature_cols]
    y_buy_train = train_df['target_buy']
    y_sell_train = train_df['target_sell']

    X_test = test_df[feature_cols]
    y_buy_test = test_df['target_buy']
    y_sell_test = test_df['target_sell']

    # 2. Train BUY Scalp Ensemble (LightGBM + Random Forest)
    print("\n🚀 [1/2] กำลังเทรนโมเดลทำนาย BUY Scalp...")
    lgb_buy = LGBMClassifier(
        n_estimators=120,
        learning_rate=0.04,
        max_depth=5,
        num_leaves=25,
        random_state=42,
        verbose=-1
    )
    lgb_buy.fit(X_train, y_buy_train)

    rf_buy = RandomForestClassifier(
        n_estimators=100,
        max_depth=6,
        random_state=42,
        n_jobs=-1
    )
    rf_buy.fit(X_train, y_buy_train)

    p_buy_lgb = lgb_buy.predict_proba(X_test)[:, 1]
    p_buy_rf = rf_buy.predict_proba(X_test)[:, 1]
    p_buy_ensemble = 0.5 * p_buy_lgb + 0.5 * p_buy_rf
    auc_buy = roc_auc_score(y_buy_test, p_buy_ensemble)
    print(f"   -> BUY Scalp Ensemble ROC-AUC: {auc_buy:.4f}")

    # 3. Train SELL Scalp Ensemble (LightGBM + Random Forest)
    print("\n🚀 [2/2] กำลังเทรนโมเดลทำนาย SELL Scalp...")
    lgb_sell = LGBMClassifier(
        n_estimators=120,
        learning_rate=0.04,
        max_depth=5,
        num_leaves=25,
        random_state=42,
        verbose=-1
    )
    lgb_sell.fit(X_train, y_sell_train)

    rf_sell = RandomForestClassifier(
        n_estimators=100,
        max_depth=6,
        random_state=42,
        n_jobs=-1
    )
    rf_sell.fit(X_train, y_sell_train)

    p_sell_lgb = lgb_sell.predict_proba(X_test)[:, 1]
    p_sell_rf = rf_sell.predict_proba(X_test)[:, 1]
    p_sell_ensemble = 0.5 * p_sell_lgb + 0.5 * p_sell_rf
    auc_sell = roc_auc_score(y_sell_test, p_sell_ensemble)
    print(f"   -> SELL Scalp Ensemble ROC-AUC: {auc_sell:.4f}")

    # 4. Save dedicated Forex model package
    os.makedirs(MODEL_DIR, exist_ok=True)
    bundle = {
        "lgb_buy": lgb_buy,
        "rf_buy": rf_buy,
        "lgb_sell": lgb_sell,
        "rf_sell": rf_sell,
        "features": feature_cols,
        "auc_buy": auc_buy,
        "auc_sell": auc_sell,
        "trained_at": pd.Timestamp.now().isoformat()
    }
    joblib.dump(bundle, MODEL_PATH)
    print(f"\n✅ บันทึกโมเดลสำเร็จที่: {MODEL_PATH}")

if __name__ == "__main__":
    train_forex_model()
