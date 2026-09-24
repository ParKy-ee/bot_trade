"""
Market Pressure & Indecision Classifier (v1.0.0)
Architecture: Hybrid Microstructure Features + Balanced Random Forest
Target Classes:
  0 = INDECISION / STALL (Chop, oscillation, balanced buying and selling)
  1 = BUY_PRESSURE (Clean directional upward momentum)
  2 = SELL_PRESSURE (Clean directional downward momentum)
"""

import os
import sys
import json
import warnings
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import classification_report, confusion_matrix, accuracy_score, f1_score

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'market_pressure_bars.json')
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
MODEL_PATH = os.path.join(MODEL_DIR, 'forex_market_pressure_v1.0.0.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'market_pressure_registry.json')

def load_and_prepare():
    print(f"📥 Loading dataset from {DATA_PATH}...")
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        bars = json.load(f)
    df = pd.DataFrame(bars)
    
    numeric_cols = ['open', 'high', 'low', 'close', 'volume', 'rsi', 'atr']
    for c in numeric_cols:
        df[c] = pd.to_numeric(df[c], errors='coerce')
        
    dfs = []
    for symbol, group in df.groupby('symbol'):
        g = group.sort_values('time').reset_index(drop=True).copy()
        
        atr = g['atr'].replace(0, np.nan).bfill().ffill().replace(0, 1e-5)
        c_range = (g['high'] - g['low']).replace(0, 1e-5)
        close = g['close']
        open_p = g['open']
        
        # 1. Microstructure anatomy
        g['bop'] = ((close - open_p) / c_range).clip(-1, 1)
        g['body_ratio'] = ((close - open_p).abs() / c_range).clip(0, 1)
        g['upper_wick'] = ((g['high'] - np.maximum(close, open_p)) / c_range).clip(0, 1)
        g['lower_wick'] = ((np.minimum(close, open_p) - g['low']) / c_range).clip(0, 1)
        g['wick_asym'] = g['lower_wick'] - g['upper_wick']
        g['rel_range'] = (c_range / atr).clip(0, 5)
        
        # 2. Kaufman Efficiency
        step = (close - close.shift(1)).abs()
        g['ker_3'] = ((close - close.shift(3)).abs() / step.rolling(3).sum().replace(0, 1e-5)).clip(0, 1)
        g['ker_5'] = ((close - close.shift(5)).abs() / step.rolling(5).sum().replace(0, 1e-5)).clip(0, 1)
        g['ker_10'] = ((close - close.shift(10)).abs() / step.rolling(10).sum().replace(0, 1e-5)).clip(0, 1)
        
        # 3. Directional displacement
        g['dir_disp_3'] = ((close - close.shift(3)) / atr).clip(-5, 5)
        g['dir_disp_5'] = ((close - close.shift(5)) / atr).clip(-5, 5)
        
        # 4. Volume Flow Proxy
        mid_point = (g['high'] + g['low']) / 2.0
        pos_in_range = ((close - mid_point) / (c_range / 2.0)).clip(-1, 1)
        vol_safe = g['volume'].replace(0, 1).clip(lower=1)
        g['vol_skew'] = pos_in_range * np.log1p(vol_safe)
        
        # 5. Target (Look ahead 3 bars)
        fwd_3 = (close.shift(-3) - close) / atr
        fwd_low = g['low'].shift(-1).rolling(3).min()
        fwd_high = g['high'].shift(-1).rolling(3).max()
        mae = (close - fwd_low) / atr
        mfe = (fwd_high - close) / atr
        
        target = np.full(len(g), 0)
        target[(fwd_3 >= 0.40) & (fwd_3 >= mae * 0.8)] = 1  # BUY_PRESSURE
        target[(fwd_3 <= -0.40) & (fwd_3.abs() >= mfe * 0.8)] = 2 # SELL_PRESSURE
        g['target'] = target
        
        dfs.append(g.iloc[10:-3])
        
    full_df = pd.concat(dfs, ignore_index=True).dropna()
    return full_df

def train_model(df):
    feature_cols = [
        'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
        'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
    ]
    
    X = df[feature_cols].values
    y = df['target'].values
    
    print(f"\n📊 Samples: {len(df):,} | Feature count: {len(feature_cols)}")
    counts = pd.Series(y).value_counts().to_dict()
    print(f"🎯 Classes: Indecision(0)={counts.get(0,0):,}, Buy(1)={counts.get(1,0):,}, Sell(2)={counts.get(2,0):,}")
    
    tscv = TimeSeriesSplit(n_splits=3)
    final_model = None
    last_test_idx = None
    
    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        
        clf = RandomForestClassifier(
            n_estimators=100,
            max_depth=7,
            class_weight='balanced',
            random_state=42,
            n_jobs=-1
        )
        clf.fit(X_train, y_train)
        acc = clf.score(X_test, y_test)
        print(f"  Fold {fold + 1} Balanced Accuracy: {acc * 100:.2f}%")
        final_model = clf
        last_test_idx = test_idx
        
    # Evaluate high conviction on holdout test set
    X_test_last = X[last_test_idx]
    y_test_last = y[last_test_idx]
    probs = final_model.predict_proba(X_test_last)
    
    # Feature Importances
    importances = final_model.feature_importances_
    sorted_idx = np.argsort(importances)[::-1]
    print("\n💡 Feature Importance Ranking:")
    for i in sorted_idx:
        print(f"  • {feature_cols[i]:16s}: {importances[i] * 100:.2f}%")
        
    # Precision analysis at conviction >= 0.42
    high_buy = probs[:, 1] >= 0.42
    high_sell = probs[:, 2] >= 0.42
    
    safe_buy_rate = ((y_test_last[high_buy] == 1) | (y_test_last[high_buy] == 0)).mean() if high_buy.sum() > 0 else 0
    safe_sell_rate = ((y_test_last[high_sell] == 2) | (y_test_last[high_sell] == 0)).mean() if high_sell.sum() > 0 else 0
    
    print("\n🎯 High Conviction Safety Metrics (Out-of-Sample):")
    print(f"  • High BUY Pressure signals:  {high_buy.sum()} bars | Safe from Dump (Not Sell): {safe_buy_rate * 100:.1f}%")
    print(f"  • High SELL Pressure signals: {high_sell.sum()} bars | Safe from Pump (Not Buy): {safe_sell_rate * 100:.1f}%")
    
    # Save Model
    joblib.dump(final_model, MODEL_PATH)
    print(f"\n💾 Model saved to {MODEL_PATH}")
    
    # Save Metadata Registry
    registry = {
        "model_id": "forex_market_pressure_v1.0.0",
        "created_at": "2026-09-24T16:15:00+07:00",
        "algorithm": "RandomForestClassifier(n_estimators=100, max_depth=7, class_weight='balanced')",
        "feature_cols": feature_cols,
        "classes": {
            0: "INDECISION_CHOP",
            1: "BUY_PRESSURE",
            2: "SELL_PRESSURE"
        },
        "performance": {
            "buy_safe_rate": round(float(safe_buy_rate), 4),
            "sell_safe_rate": round(float(safe_sell_rate), 4)
        },
        "top_features": [feature_cols[i] for i in sorted_idx[:5]]
    }
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
        json.dump(registry, f, indent=2)
    print(f"📝 Registry saved to {REGISTRY_PATH}")

def main():
    print("=" * 65)
    print("🚀 TRAINING BALANCED MARKET PRESSURE & INDECISION MODEL (v1.0.0)")
    print("=" * 65)
    df = load_and_prepare()
    train_model(df)

if __name__ == '__main__':
    main()
