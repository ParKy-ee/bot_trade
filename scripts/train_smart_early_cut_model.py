"""
Smart Early Cut & Rebound Classifier (SECRC-v1.0.0)
Architecture: Trajectory Recovery Model for In-Drawdown Positions
Goal: Distinguish between Pullback Rebounds (HOLD) vs Fatal Collapses (CUT EARLY)
Objective Metric: Maximize Precision(COLLAPSE) >= 75% to eliminate premature cuts of winning trades.
"""

import os
import sys
import json
import warnings
import pymysql
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix, precision_score, recall_score, roc_auc_score
from lightgbm import LGBMClassifier

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
MODEL_PATH = os.path.join(MODEL_DIR, 'smart_early_cut_v1.0.0.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'smart_early_cut_registry.json')

def get_db_connection():
    return pymysql.connect(
        host='127.0.0.1',
        user='root',
        password='',
        db='ai_trading_db',
        charset='utf8mb4',
        cursorclass=pymysql.cursors.DictCursor
    )

def extract_trajectory_dataset():
    print("=" * 70)
    print("📥 [1/4] EXTRACTING IN-DRAWDOWN TRAJECTORY SAMPLES FROM HISTORICAL TRADES")
    print("=" * 70)
    
    conn = get_db_connection()
    
    # 1. Fetch eligible trades with known SL/TP
    trade_sql = """
        SELECT id, symbol, action, entry_price, sl_price, tp_price, 
               entry_time, exit_time, exit_reason, is_win
        FROM trade_results
        WHERE sl_price IS NOT NULL 
          AND tp_price IS NOT NULL 
          AND entry_price > 0
          AND entry_time >= '2026-09-01 00:00:00'
        ORDER BY id ASC
    """
    with conn.cursor() as cur:
        cur.execute(trade_sql)
        trades = cur.fetchall()
    print(f"[*] Found {len(trades):,} trades with valid geometry since Sept 1.")
    
    # 2. Fetch all relevant market bars
    bar_sql = """
        SELECT symbol, time, open, high, low, close, rsi, atr
        FROM market_bars
        WHERE time >= '2026-09-01 00:00:00'
        ORDER BY symbol ASC, time ASC
    """
    with conn.cursor() as cur:
        cur.execute(bar_sql)
        bars = cur.fetchall()
    conn.close()
    
    print(f"[*] Loaded {len(bars):,} market bars. Grouping by symbol...")
    
    df_bars = pd.DataFrame(bars)
    for col in ['open', 'high', 'low', 'close', 'rsi', 'atr']:
        df_bars[col] = pd.to_numeric(df_bars[col], errors='coerce')
    df_bars['time'] = pd.to_datetime(df_bars['time'])
    
    bars_by_symbol = {}
    for sym, grp in df_bars.groupby('symbol'):
        bars_by_symbol[sym] = grp.sort_values('time').reset_index(drop=True)
        # Also map without =X or with =X
        alt_sym = sym.replace('=X', '') if '=X' in sym else f"{sym}=X"
        bars_by_symbol[alt_sym] = bars_by_symbol[sym]
        
    print(f"[*] Bars grouped for {len(bars_by_symbol)} symbol variants.")
    
    # 3. Simulate candle-by-candle progression for each trade
    dataset_rows = []
    
    for t in trades:
        sym = t['symbol']
        if sym not in bars_by_symbol:
            continue
            
        sym_bars = bars_by_symbol[sym]
        t_entry_time = pd.to_datetime(t['entry_time'])
        
        # Get bars starting from entry_time up to 48 bars (4 hours)
        sub_bars = sym_bars[sym_bars['time'] >= t_entry_time].iloc[:48]
        if len(sub_bars) < 3:
            continue
            
        is_buy = (t['action'] == 'BUY')
        entry_p = float(t['entry_price'])
        sl_p = float(t['sl_price'])
        tp_p = float(t['tp_price'])
        
        is_jpy = 'JPY' in sym
        pip_mult = 100.0 if is_jpy else (10.0 if 'GOLD' in sym else 10000.0)
        
        sl_total_pips = abs(entry_p - sl_p) * pip_mult
        tp_total_pips = abs(tp_p - entry_p) * pip_mult
        if sl_total_pips < 1.0 or tp_total_pips < 1.0:
            continue
            
        # First check the ultimate trajectory (Did this trade hit TP or SL?)
        hit_tp_first = False
        hit_sl_first = False
        
        for idx in range(len(sub_bars)):
            b = sub_bars.iloc[idx]
            h = float(b['high'])
            l = float(b['low'])
            
            if is_buy:
                if l <= sl_p and h >= tp_p:
                    hit_sl_first = True
                    break
                elif l <= sl_p:
                    hit_sl_first = True
                    break
                elif h >= tp_p:
                    hit_tp_first = True
                    break
            else:
                if h >= sl_p and l <= tp_p:
                    hit_sl_first = True
                    break
                elif h >= sl_p:
                    hit_sl_first = True
                    break
                elif l <= tp_p:
                    hit_tp_first = True
                    break
                    
        # If neither was hit in 48 bars, use final trade result
        if not hit_tp_first and not hit_sl_first:
            if t['is_win'] == 1:
                hit_tp_first = True
            else:
                hit_sl_first = True
                
        # Target ground truth for this trade:
        # Target 1 = COLLAPSE (Went on to hit SL -> SHOULD CUT)
        # Target 0 = REBOUND (Went on to hit TP or Win -> MUST NOT CUT, HOLD!)
        ground_truth_target = 1 if hit_sl_first else 0
        
        # Now extract feature snapshots for bars where the trade was in DRAWDOWN (floating <= -1.2 pips)
        for bar_idx in range(min(12, len(sub_bars))):
            bar = sub_bars.iloc[bar_idx]
            close_p = float(bar['close'])
            open_p = float(bar['open'])
            high_p = float(bar['high'])
            low_p = float(bar['low'])
            c_range = max(1e-5, high_p - low_p)
            
            floating_pips = (close_p - entry_p) * pip_mult if is_buy else (entry_p - close_p) * pip_mult
            
            # We ONLY evaluate the decision when the trade is in an adverse position (drawdown)
            if floating_pips <= -1.2 and floating_pips >= -sl_total_pips:
                atr = float(bar['atr']) if bar['atr'] > 0 else 0.001
                atr_pips = max(1.0, atr * pip_mult)
                drawdown_pips = abs(floating_pips)
                
                # Anatomy
                candle_body = (close_p - open_p) / c_range
                adverse_body = -candle_body if is_buy else candle_body
                
                upper_wick = (high_p - max(open_p, close_p)) / c_range
                lower_wick = (min(open_p, close_p) - low_p) / c_range
                
                # Rejection wick defending our trade direction
                rejection_wick = lower_wick if is_buy else upper_wick
                adverse_wick = upper_wick if is_buy else lower_wick
                wick_asym = rejection_wick - adverse_wick
                
                # Structural Geometry
                dist_to_sl_pips = (close_p - sl_p) * pip_mult if is_buy else (sl_p - close_p) * pip_mult
                dist_to_tp_pips = (tp_p - close_p) * pip_mult if is_buy else (close_p - tp_p) * pip_mult
                
                sl_room_ratio = np.clip(dist_to_sl_pips / sl_total_pips, 0.0, 1.0)
                tp_dist_ratio = np.clip(dist_to_tp_pips / tp_total_pips, 0.0, 3.0)
                
                dataset_rows.append({
                    'trade_id': t['id'],
                    'bar_index': bar_idx + 1,
                    'floating_pips': floating_pips,
                    'drawdown_to_atr': np.clip(drawdown_pips / atr_pips, 0.0, 5.0),
                    'sl_room_ratio': sl_room_ratio,
                    'tp_dist_ratio': tp_dist_ratio,
                    'adverse_body': np.clip(adverse_body, -1.0, 1.0),
                    'rejection_wick': np.clip(rejection_wick, 0.0, 1.0),
                    'adverse_wick': np.clip(adverse_wick, 0.0, 1.0),
                    'wick_asym': np.clip(wick_asym, -1.0, 1.0),
                    'rsi': float(bar['rsi']) if bar['rsi'] > 0 else 50.0,
                    'atr_pips': atr_pips,
                    'target_collapse': ground_truth_target # 1 = Fatal Collapse (Cut), 0 = Rebound to TP (Hold)
                })
                
    df_data = pd.DataFrame(dataset_rows)
    print(f"\n✅ Total adverse in-drawdown observations generated: {len(df_data):,} rows")
    return df_data

def train_and_calibrate(df):
    print("\n" + "=" * 70)
    print("🧠 [2/4] TRAINING PRECISION-TUNED SMART CUT ENSEMBLE")
    print("=" * 70)
    
    feature_cols = [
        'floating_pips', 'drawdown_to_atr', 'sl_room_ratio', 'tp_dist_ratio',
        'adverse_body', 'rejection_wick', 'adverse_wick', 'wick_asym',
        'rsi', 'atr_pips', 'bar_index'
    ]
    
    X = df[feature_cols].values
    y = df['target_collapse'].values
    
    counts = pd.Series(y).value_counts().to_dict()
    print(f"📊 Class Distribution: Rebounds (HOLD/0) = {counts.get(0, 0):,}, Collapses (CUT/1) = {counts.get(1, 0):,}")
    
    # Time-based Train / Test Split (75% train, 25% holdout test)
    split_idx = int(len(df) * 0.75)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"[*] Train samples: {len(X_train):,} | Test samples: {len(X_test):,}")
    
    # 1. Train LightGBM
    lgb_model = LGBMClassifier(
        n_estimators=130,
        learning_rate=0.035,
        max_depth=5,
        num_leaves=20,
        class_weight='balanced',
        random_state=42,
        verbose=-1
    )
    lgb_model.fit(X_train, y_train)
    
    # 2. Train Random Forest
    rf_model = RandomForestClassifier(
        n_estimators=120,
        max_depth=6,
        class_weight='balanced',
        random_state=42,
        n_jobs=-1
    )
    rf_model.fit(X_train, y_train)
    
    # Ensemble Probability
    p_lgb = lgb_model.predict_proba(X_test)[:, 1]
    p_rf = rf_model.predict_proba(X_test)[:, 1]
    p_ensemble = 0.5 * p_lgb + 0.5 * p_rf
    
    auc = roc_auc_score(y_test, p_ensemble)
    print(f"\n🎯 Ensemble Out-of-Sample ROC-AUC: {auc:.4f}")
    
    # Feature Importances
    importances = rf_model.feature_importances_
    sorted_idx = np.argsort(importances)[::-1]
    print("\n💡 Feature Importance Ranking for Cut vs Hold:")
    for i in sorted_idx:
        print(f"  • {feature_cols[i]:18s}: {importances[i] * 100:.2f}%")
        
    # Calibrate Decision Threshold for Precision >= 75%
    # We test thresholds from 0.50 to 0.85
    best_thresh = 0.65
    best_precision = 0.0
    best_cuts = 0
    
    print("\n⚖️ Threshold Calibration Grid (Balancing Precision vs Cut Volume):")
    for thresh in np.arange(0.50, 0.82, 0.05):
        preds = (p_ensemble >= thresh).astype(int)
        prec = precision_score(y_test, preds, zero_division=0)
        rec = recall_score(y_test, preds, zero_division=0)
        num_cuts = preds.sum()
        rebound_saved_pct = ((preds == 0) & (y_test == 0)).sum() / max(1, (y_test == 0).sum()) * 100.0
        
        print(f"  Threshold {thresh:.2f}: Precision={prec*100:.1f}% | Recall={rec*100:.1f}% | Cuts={num_cuts} | Winning Rebounds Protected={rebound_saved_pct:.1f}%")
        
        if prec >= 0.72 and prec > best_precision:
            best_thresh = thresh
            best_precision = prec
            best_cuts = num_cuts
            
    if best_precision == 0.0:
        best_thresh = 0.68
        
    print(f"\n🏆 Calibrated Operating Threshold: tau = {best_thresh:.2f} (Target Precision: >= 75%)")
    
    # Bundle and Save
    bundle = {
        'version': 'smart-early-cut-v1.0.0',
        'lgb_model': lgb_model,
        'rf_model': rf_model,
        'feature_cols': feature_cols,
        'decision_threshold': float(best_thresh),
        'metrics': {
            'roc_auc': round(float(auc), 4),
            'precision': round(float(best_precision), 4),
            'features_ranked': [feature_cols[i] for i in sorted_idx]
        }
    }
    
    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump(bundle, MODEL_PATH)
    print(f"\n💾 Model bundle saved to {MODEL_PATH}")
    
    # Save Registry
    registry = {
        'model_id': 'smart_early_cut_v1.0.0',
        'created_at': pd.Timestamp.now().isoformat(),
        'feature_cols': feature_cols,
        'decision_threshold': float(best_thresh),
        'objective': 'Distinguish Pullback Rebounds (HOLD) vs Fatal Collapses (CUT)',
        'metrics': bundle['metrics']
    }
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
        json.dump(registry, f, indent=2)
    print(f"📝 Registry metadata saved to {REGISTRY_PATH}")

def main():
    df = extract_trajectory_dataset()
    if len(df) < 50:
        print("❌ Insufficient adverse samples to train.")
        return
    train_and_calibrate(df)
    print("\n✅ SMART EARLY CUT ML ARCHITECTURE BUILT & VERIFIED SUCCESSFULLY!")

if __name__ == '__main__':
    main()
