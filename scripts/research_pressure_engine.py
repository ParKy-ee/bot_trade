import mysql.connector
import os
import json
import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sklearn.model_selection import TimeSeriesSplit
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix

load_dotenv()

def run_experiment():
    print("=== RESEARCH: TESTING PRESSURE & INDECISION METHODOLOGIES ===")
    conn = mysql.connector.connect(
        host=os.getenv('DB_HOST', '127.0.0.1'),
        user=os.getenv('DB_USER', 'root'),
        password=os.getenv('DB_PASS', ''),
        database=os.getenv('DB_NAME', 'ai_trading_db')
    )
    
    # Query 25,000 bars for major pairs
    query = """
        SELECT symbol, time, open, high, low, close, volume, atr
        FROM market_bars
        WHERE market_type IN ('forex', 'gold')
        ORDER BY symbol ASC, time ASC
    """
    print("Loading market_bars...")
    df = pd.read_sql(query, conn)
    conn.close()
    
    print(f"Loaded {len(df):,} total bars.")
    if len(df) < 5000:
        print("Not enough bars to run deep analysis.")
        return

    # Clean types
    for col in ['open', 'high', 'low', 'close', 'volume', 'atr']:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df = df.dropna().reset_index(drop=True)

    # Process by symbol
    processed_dfs = []
    for symbol, group in df.groupby('symbol'):
        g = group.copy().sort_values('time').reset_index(drop=True)
        if len(g) < 200:
            continue
            
        # Features:
        # 1. Bar anatomy
        body = (g['close'] - g['open']).abs()
        candle_range = (g['high'] - g['low']).replace(0, 1e-5)
        g['body_ratio'] = body / candle_range
        g['upper_wick'] = (g['high'] - np.maximum(g['close'], g['open'])) / candle_range
        g['lower_wick'] = (np.minimum(g['close'], g['open']) - g['low']) / candle_range
        g['bar_dir'] = np.where(g['close'] > g['open'], 1, np.where(g['close'] < g['open'], -1, 0))
        
        # 2. Normalized Range (vs ATR)
        atr_safe = g['atr'].replace(0, np.nan).fillna(method='bfill').replace(0, 1e-5)
        g['rel_range'] = candle_range / atr_safe
        
        # 3. Kaufman Efficiency Ratio (KER) over 5 bars
        close_series = g['close']
        net_disp_5 = (close_series - close_series.shift(5)).abs()
        step_diffs = (close_series - close_series.shift(1)).abs()
        path_5 = step_diffs.rolling(5).sum().replace(0, 1e-5)
        g['ker_5'] = (net_disp_5 / path_5).clip(0, 1)
        
        # KER over 3 bars
        net_disp_3 = (close_series - close_series.shift(3)).abs()
        path_3 = step_diffs.rolling(3).sum().replace(0, 1e-5)
        g['ker_3'] = (net_disp_3 / path_3).clip(0, 1)
        
        # Directional displacement
        g['dir_disp_5'] = (close_series - close_series.shift(5)) / atr_safe

        # 4. Target Definition (Forward 3 bars):
        # Look ahead 3 bars to see what actually happened
        # Class 1: BUY_PRESSURE  (Future 3-bar displacement > +0.5 ATR)
        # Class 2: SELL_PRESSURE (Future 3-bar displacement < -0.5 ATR)
        # Class 0: INDECISION_CHOP (|Future 3-bar displacement| <= 0.35 ATR or oscillating)
        forward_disp_3 = (close_series.shift(-3) - close_series) / atr_safe
        
        # Target
        conditions = [
            (forward_disp_3 >= 0.50),
            (forward_disp_3 <= -0.50),
            (forward_disp_3.abs() <= 0.25)
        ]
        choices = [1, 2, 0] # 1: BUY, 2: SELL, 0: INDECISION
        g['target'] = np.select(conditions, choices, default=np.nan)
        
        processed_dfs.append(g)

    all_data = pd.concat(processed_dfs, ignore_index=True).dropna(subset=['target', 'ker_5', 'rel_range'])
    all_data['target'] = all_data['target'].astype(int)
    print(f"Usable labeled dataset: {len(all_data):,} samples across symbols.")
    
    target_counts = all_data['target'].value_counts()
    print("Class distribution:")
    print(f"  Class 0 (INDECISION / CHOP): {target_counts.get(0, 0):,} ({target_counts.get(0, 0)/len(all_data)*100:.1f}%)")
    print(f"  Class 1 (BUY PRESSURE):     {target_counts.get(1, 0):,} ({target_counts.get(1, 0)/len(all_data)*100:.1f}%)")
    print(f"  Class 2 (SELL PRESSURE):    {target_counts.get(2, 0):,} ({target_counts.get(2, 0)/len(all_data)*100:.1f}%)")

    # Features list
    feature_cols = [
        'body_ratio', 'upper_wick', 'lower_wick', 'bar_dir',
        'rel_range', 'ker_5', 'ker_3', 'dir_disp_5'
    ]

    # METHOD 1: Rule-based Heuristic Evaluation
    print("\n--- METHOD 1: HEURISTIC / QUANT RULES ---")
    # Rule: 
    # Indecision if ker_5 < 0.25 and body_ratio < 0.35
    # Buy pressure if dir_disp_5 > 0.5 and ker_5 > 0.55
    # Sell pressure if dir_disp_5 < -0.5 and ker_5 > 0.55
    m1_pred = np.zeros(len(all_data))
    m1_pred = np.where(
        (all_data['ker_5'] < 0.25) & (all_data['body_ratio'] < 0.35), 0,
        np.where((all_data['dir_disp_5'] > 0.4) & (all_data['ker_5'] > 0.5), 1,
        np.where((all_data['dir_disp_5'] < -0.4) & (all_data['ker_5'] > 0.5), 2, 0))
    )
    acc_m1 = (m1_pred == all_data['target']).mean()
    print(f"Heuristic Rule Accuracy: {acc_m1 * 100:.2f}%")

    # METHOD 2: Machine Learning (Random Forest with TimeSeries CV)
    print("\n--- METHOD 2: MACHINE LEARNING (Random Forest / Gradient Boosted) ---")
    tscv = TimeSeriesSplit(n_splits=3)
    X = all_data[feature_cols].values
    y = all_data['target'].values
    
    cv_scores = []
    last_model = None
    last_test_idx = None
    
    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        
        clf = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42, n_jobs=-1)
        clf.fit(X_train, y_train)
        score = clf.score(X_test, y_test)
        cv_scores.append(score)
        print(f"Fold {fold+1} Accuracy: {score * 100:.2f}%")
        last_model = clf
        last_test_idx = test_idx
        
    print(f"Mean ML Accuracy: {np.mean(cv_scores) * 100:.2f}%")
    
    # Feature Importances
    importances = dict(zip(feature_cols, last_model.feature_importances_))
    sorted_imp = sorted(importances.items(), key=lambda x: x[1], reverse=True)
    print("\nFeature Importances (Top Quant Drivers):")
    for feat, imp in sorted_imp:
        print(f"  • {feat:12s}: {imp * 100:.1f}%")

    # Detailed test report on last fold
    y_test_last = y[last_test_idx]
    y_pred_last = last_model.predict(X[last_test_idx])
    print("\nClassification Report (Hold-out Test Set):")
    print(classification_report(y_test_last, y_pred_last, target_names=['INDECISION', 'BUY_PRESSURE', 'SELL_PRESSURE']))

if __name__ == '__main__':
    run_experiment()
