"""
Intra-Trade Exit Challenger Model (Challenger-Exit-v1.1.0)
Extracts bar-by-bar progression while holding orders from `trade_results` + `market_bars`
Trains a model to predict:
  0 = HOLD (Continue running)
  1 = EARLY_CUT (Cut loss early to save capital before Hard SL)
  2 = STALL_HARVEST (Lock in floating profit before reversal)
"""

import os
import sys
import json
import warnings
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
VERSIONS_DIR = os.path.join(MODEL_DIR, 'versions')
MODEL_PATH = os.path.join(MODEL_DIR, 'forex_exit_challenger_v1.1.0.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'exit_challenger_registry.json')
DATASET_PATH = os.path.join(ROOT_DIR, 'data', 'intra_trade_progression.json')

def extract_intra_trade_bars():
    print("📥 กำลังอ่านข้อมูลแท่งเทียนระหว่างถือครองออเดอร์ (Intra-Trade Candle Progression)...")
    if not os.path.exists(DATASET_PATH):
        raise FileNotFoundError(f"Missing dataset at {DATASET_PATH}")
    with open(DATASET_PATH, 'r', encoding='utf-8') as f:
        rows = json.load(f)
    print(f"✅ โหลดแท่งเทียนระหว่างถือครองสำเร็จ: ทั้งหมด {len(rows)} แท่ง จากออเดอร์ในประวัติ")
    return pd.DataFrame(rows)

def build_features_and_labels(df):
    if df.empty:
        return df, []
    
    print("⚙️ กำลังคำนวณ Features พลวัตของแท่งเทียน (Candle Dynamics) และ Target Labels...")
    
    # คำนวณ Pip multiplier (JPY = 100, Major = 10000)
    is_jpy = df['symbol'].astype(str).str.contains('JPY')
    pip_mult = np.where(is_jpy, 100.0, 10000.0)
    
    df['is_buy'] = (df['action'] == 'BUY').astype(int)
    
    # 1. Floating Pips ณ แท่งปัจจุบัน
    entry_price = df['entry_price'].astype(float)
    close_price = df['close'].astype(float)
    high_price = df['high'].astype(float)
    low_price = df['low'].astype(float)
    open_price = df['open'].astype(float)
    
    df['floating_pips'] = np.where(
        df['action'] == 'BUY',
        (close_price - entry_price) * pip_mult,
        (entry_price - close_price) * pip_mult
    )
    
    # 2. Bar MFE & MAE ในแท่งนั้น
    df['bar_mfe_pips'] = np.where(
        df['action'] == 'BUY',
        (high_price - entry_price) * pip_mult,
        (entry_price - low_price) * pip_mult
    )
    df['bar_mae_pips'] = np.where(
        df['action'] == 'BUY',
        (low_price - entry_price) * pip_mult,
        (entry_price - high_price) * pip_mult
    )
    
    # คำนวณลำดับแท่งนับตั้งแต่เปิดออเดอร์ (Bar Index) และ Cumulative MFE
    df['bar_index'] = df.groupby('trade_id').cumcount() + 1
    df['cum_mfe_pips'] = df.groupby('trade_id')['bar_mfe_pips'].cummax()
    df['cum_mae_pips'] = df.groupby('trade_id')['bar_mae_pips'].cummin()
    
    # 3. Giveback Pips (กำไรที่หดหายไปจากจุดสูงสุดที่เคยทำได้)
    df['giveback_pips'] = np.maximum(0.0, df['cum_mfe_pips'] - df['floating_pips'])
    
    # 4. คุณลักษณะของแท่งเทียน (Candle Morphology)
    candle_range = (high_price - low_price) + 1e-5
    df['candle_body_ratio'] = (close_price - open_price) / candle_range
    df['upper_wick_ratio'] = (high_price - np.maximum(close_price, open_price)) / candle_range
    df['lower_wick_ratio'] = (np.minimum(close_price, open_price) - low_price) / candle_range
    
    # สัญญาณแท่งเทียนสวนทางกับทิศทางเทรด (Adverse Bar Pressure)
    df['adverse_pressure'] = np.where(
        df['action'] == 'BUY',
        -df['candle_body_ratio'], # ถ้า BUY แล้วแท่งแดง = adverse
        df['candle_body_ratio']   # ถ้า SELL แล้วแท่งเขียว = adverse
    )
    
    df['rsi'] = df['rsi'].astype(float).fillna(50.0)
    df['atr_pips'] = (df['atr'].astype(float) * pip_mult).fillna(10.0)
    
    # 5. TARGET LABELING (การตัดสินใจที่ถูกต้องที่สุดในแท่งนี้):
    #   Target 0 = HOLD (ถือต่อตามปกติ)
    #   Target 1 = EARLY_CUT (ออเดอร์นี้สุดท้ายจะแพ้ และ ณ แท่งนี้ยังติดลบน้อย ควรชิงปิดเพื่อประหยัดทุน)
    #   Target 2 = STALL_HARVEST (ออเดอร์นี้กำไรไปแล้ว แต่เริ่มไหลย้อนกลับ ควรล็อกกำไรทันที)
    
    final_pips = df['final_pips'].astype(float).fillna(0.0)
    is_win = df['is_win'].astype(int).fillna(0)
    
    target = np.zeros(len(df), dtype=int) # Default 0 = HOLD
    
    # เงื่อนไข EARLY_CUT:
    # ไม้นี้สุดท้ายจบแพ้ (is_win == 0 หรือ final_pips < -4 pips)
    # และแท่งนี้มีอาการ adverse pressure ชัดเจน + floating_pips ดีกว่า final_pips อย่างน้อย 4 pips
    is_failing_trade = (is_win == 0) & (final_pips <= -4.0)
    should_early_cut = is_failing_trade & (df['floating_pips'] > final_pips + 3.5) & (df['bar_index'] >= 2)
    target[should_early_cut] = 1
    
    # เงื่อนไข STALL_HARVEST:
    # ไม้นี้เคยบวกไปสวยงาม (cum_mfe_pips >= 5.0) แต่กำลังไหลย้อนกลับ (giveback >= 2.5) หรือสุดท้ายเหลือกำไรนิดเดียว
    should_harvest = (df['cum_mfe_pips'] >= 5.0) & (df['giveback_pips'] >= 2.5) & (df['floating_pips'] >= 2.0)
    target[should_harvest] = 2
    
    df['target_action'] = target
    
    feature_cols = [
        'is_buy', 'bar_index', 'floating_pips', 'cum_mfe_pips', 'cum_mae_pips',
        'giveback_pips', 'candle_body_ratio', 'upper_wick_ratio', 'lower_wick_ratio',
        'adverse_pressure', 'rsi', 'atr_pips'
    ]
    
    return df, feature_cols

def train_challenger_exit_model():
    print("=" * 70)
    print("🚀 เริ่มกระบวนการฝึกอบรม Intra-Trade Exit Challenger V1.1.0")
    print("=" * 70)
    
    raw_df = extract_intra_trade_bars()
    if raw_df.empty or len(raw_df) < 50:
        print("⚠️ ข้อมูลแท่งเทียนไม่เพียงพอสำหรับการเทรน (ต้องการอย่างน้อย 50 แท่ง)")
        return
    
    df, feature_cols = build_features_and_labels(raw_df)
    
    # Distribution of labels
    label_counts = df['target_action'].value_counts().to_dict()
    print(f"📊 สัดส่วน Labels: HOLD (0): {label_counts.get(0, 0)} | EARLY_CUT (1): {label_counts.get(1, 0)} | STALL_HARVEST (2): {label_counts.get(2, 0)}")
    
    X = df[feature_cols].values
    y = df['target_action'].values
    
    # Train / Test Split (Time-based split: 80% train, 20% test)
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"🧠 จำนวนตัวอย่างเทรน: {len(X_train)} | จำนวนตัวอย่างทดสอบ: {len(X_test)}")
    
    # ใช้ Random Forest + GradientBoosting Ensemble สำหรับ Multi-Class Classification
    clf = RandomForestClassifier(
        n_estimators=120,
        max_depth=6,
        class_weight='balanced',
        random_state=42,
        n_jobs=-1
    )
    clf.fit(X_train, y_train)
    
    y_pred = clf.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    
    print(f"\n📈 ผลการทดสอบโมเดล (Test Accuracy): {acc * 100:.2f}%")
    print("\n📋 รายงานผลการจำแนกประเภท (Classification Report):")
    target_names = ['HOLD (0)', 'EARLY_CUT (1)', 'STALL_HARVEST (2)']
    unique_test_labels = np.unique(y_test)
    names = [target_names[i] for i in unique_test_labels]
    print(classification_report(y_test, y_pred, target_names=names, zero_division=0))
    
    # Feature Importance
    importances = clf.feature_importances_
    feat_imp = sorted(zip(feature_cols, importances), key=lambda x: x[1], reverse=True)
    print("🔥 ปัจจัยที่มีผลต่อการตัดสินใจ Exit มากที่สุด (Top Feature Importances):")
    for name, imp in feat_imp[:6]:
        print(f"   • {name:20s}: {imp * 100:.1f}%")
    
    # ประเมินผลกระทบต่อกำไร/ขาดทุนจำลอง (Simulated PnL Impact)
    test_df = df.iloc[split_idx:].copy()
    test_df['predicted_action'] = y_pred
    test_df['final_pips'] = pd.to_numeric(test_df['final_pips'], errors='coerce').fillna(0.0)
    test_df['floating_pips'] = pd.to_numeric(test_df['floating_pips'], errors='coerce').fillna(0.0)
    
    # คำนวณ Pips ที่เซฟได้จาก Early Cut
    early_cut_cases = test_df[(test_df['predicted_action'] == 1) & (test_df['final_pips'] < 0)]
    saved_pips = float((early_cut_cases['floating_pips'] - early_cut_cases['final_pips']).sum())
    print(f"\n💰 ประมาณการ Pips ที่เซฟได้จากการตัดขาดทุนล่วงหน้า (Early Cut Savings): +{saved_pips:.1f} pips ในกลุ่มทดสอบ!")
    
    # บันทึกโมเดล
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    bundle = {
        'version': 'Challenger-Exit-v1.1.0',
        'model_type': 'RandomForest_Exit_Classifier',
        'feature_cols': feature_cols,
        'model': clf,
        'accuracy': float(acc),
        'saved_pips_estimate': float(saved_pips),
        'trained_at': pd.Timestamp.now().isoformat()
    }
    
    joblib.dump(bundle, MODEL_PATH)
    archive_path = os.path.join(VERSIONS_DIR, 'forex_exit_challenger_v1.1.0.joblib')
    joblib.dump(bundle, archive_path)
    
    registry_data = {
        'active_version': 'Challenger-Exit-v1.1.0',
        'artifact': 'forex_exit_challenger_v1.1.0.joblib',
        'accuracy': round(float(acc), 4),
        'features': feature_cols,
        'classes': {0: 'HOLD', 1: 'EARLY_CUT', 2: 'STALL_HARVEST'},
        'trained_samples': len(X_train),
        'test_samples': len(X_test),
        'updated_at': pd.Timestamp.now().isoformat()
    }
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
        json.dump(registry_data, f, ensure_ascii=False, indent=2)
        
    print(f"\n✅ บันทึกโมเดลสำเร็จที่: {MODEL_PATH}")
    print(f"✅ บันทึก Registry ที่: {REGISTRY_PATH}")
    print("=" * 70)

if __name__ == '__main__':
    train_challenger_exit_model()
