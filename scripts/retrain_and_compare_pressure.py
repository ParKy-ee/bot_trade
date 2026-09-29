"""
Market Pressure Model Retraining & Champion vs Challenger Benchmark
Compares Champion (v1.0.0) vs Challenger (v1.1.0) on both:
1. Out-of-sample recent market bars (chronological holdout)
2. Real-time live execution observations (market_pressure_observations table)
"""

import os
import sys
import json
import warnings
import joblib
import pymysql
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score, balanced_accuracy_score, confusion_matrix

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'market_pressure_bars_v2.json')
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
CHAMPION_PATH = os.path.join(MODEL_DIR, 'forex_market_pressure_v1.0.0.joblib')
CHALLENGER_PATH = os.path.join(MODEL_DIR, 'forex_market_pressure_v1.1.0.joblib')

FEATURE_COLS = [
    'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
    'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
]

def load_and_prepare_bars():
    print(f"📥 Loading dataset from {DATA_PATH}...")
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        bars = json.load(f)
    df = pd.DataFrame(bars)
    
    numeric_cols = ['open', 'high', 'low', 'close', 'volume', 'rsi', 'atr']
    for c in numeric_cols:
        df[c] = pd.to_numeric(df[c], errors='coerce')
        
    dfs_train = []
    dfs_test = []
    
    for symbol, group in df.groupby('symbol'):
        g = group.sort_values('time').reset_index(drop=True).copy()
        
        atr = g['atr'].replace(0, np.nan).bfill().ffill().replace(0, 1e-5)
        c_range = (g['high'] - g['low']).replace(0, 1e-5)
        close = g['close']
        open_p = g['open']
        
        # 1. Microstructure features
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
        g['fwd_3_atr'] = fwd_3
        
        valid = g.iloc[10:-3].dropna(subset=FEATURE_COLS + ['target'])
        
        # Time-based split: First 80% train, Last 20% holdout test
        split_idx = int(len(valid) * 0.80)
        dfs_train.append(valid.iloc[:split_idx])
        dfs_test.append(valid.iloc[split_idx:])
        
    df_train = pd.concat(dfs_train, ignore_index=True)
    df_test = pd.concat(dfs_test, ignore_index=True)
    
    print(f"📊 Dataset Ready -> Train samples: {len(df_train):,} | Out-Of-Sample Test samples: {len(df_test):,}")
    return df_train, df_test

def train_challenger(df_train):
    print("\n🔨 Training Challenger Model (v1.1.0) with enhanced hyperparameters...")
    X_train = df_train[FEATURE_COLS].values
    y_train = df_train['target'].values
    
    # Enhanced Random Forest with deeper trees and balanced subsampling
    challenger = RandomForestClassifier(
        n_estimators=150,
        max_depth=9,
        min_samples_split=12,
        min_samples_leaf=8,
        max_features='sqrt',
        class_weight='balanced_subsample',
        random_state=42,
        n_jobs=-1
    )
    challenger.fit(X_train, y_train)
    
    joblib.dump(challenger, CHALLENGER_PATH)
    print(f"✅ Challenger model saved to: {CHALLENGER_PATH}")
    return challenger

def evaluate_model(model, X, y, fwd_return=None):
    preds = model.predict(X)
    probs = model.predict_proba(X)
    
    acc = accuracy_score(y, preds)
    bal_acc = balanced_accuracy_score(y, preds)
    
    # Class-wise metrics
    pred_buy = (preds == 1)
    pred_sell = (preds == 2)
    pred_chop = (preds == 0)
    
    # Safe rate: Buy that did not dump (y != 2), Sell that did not pump (y != 1)
    buy_safe_rate = (y[pred_buy] != 2).mean() if pred_buy.sum() > 0 else 0
    sell_safe_rate = (y[pred_sell] != 1).mean() if pred_sell.sum() > 0 else 0
    
    # Buy / Sell Precision
    buy_precision = (y[pred_buy] == 1).mean() if pred_buy.sum() > 0 else 0
    sell_precision = (y[pred_sell] == 2).mean() if pred_sell.sum() > 0 else 0
    chop_precision = (y[pred_chop] == 0).mean() if pred_chop.sum() > 0 else 0
    
    # Directional Win Rate (Did price move in the predicted direction?)
    dir_win_rate = 0
    avg_dir_edge = 0
    if fwd_return is not None:
        dir_signals = pred_buy | pred_sell
        if dir_signals.sum() > 0:
            actual_ret = fwd_return[dir_signals]
            dir_expected = np.where(preds[dir_signals] == 1, actual_ret, -actual_ret)
            dir_win_rate = (dir_expected > 0).mean()
            avg_dir_edge = dir_expected.mean()
            
    # High conviction (prob >= 0.42)
    high_buy = probs[:, 1] >= 0.42
    high_sell = probs[:, 2] >= 0.42
    high_conv_count = (high_buy | high_sell).sum()
    high_buy_safe = (y[high_buy] != 2).mean() if high_buy.sum() > 0 else 0
    high_sell_safe = (y[high_sell] != 1).mean() if high_sell.sum() > 0 else 0
    high_safe_avg = (high_buy_safe + high_sell_safe) / 2.0 if (high_buy.sum() > 0 and high_sell.sum() > 0) else max(high_buy_safe, high_sell_safe)
    
    return {
        "accuracy": acc,
        "balanced_accuracy": bal_acc,
        "buy_safe_rate": buy_safe_rate,
        "sell_safe_rate": sell_safe_rate,
        "buy_precision": buy_precision,
        "sell_precision": sell_precision,
        "chop_precision": chop_precision,
        "dir_win_rate": dir_win_rate,
        "avg_dir_edge": avg_dir_edge,
        "high_conv_count": high_conv_count,
        "high_safe_avg": high_safe_avg
    }

def run_live_observations_benchmark(champion, challenger):
    print("\n🔍 Fetching 1,500+ live ground truth observations from MySQL...")
    try:
        conn = pymysql.connect(
            host='127.0.0.1',
            user='root',
            database='ai_trading_db',
            charset='utf8mb4',
            cursorclass=pymysql.cursors.DictCursor
        )
        with conn.cursor() as cur:
            cur.execute("""
                SELECT 
                    symbol, bop, body_ratio, upper_wick, lower_wick, wick_asym,
                    rel_range, ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew,
                    actual_state, actual_return_atr
                FROM market_pressure_observations
                WHERE outcome_status = 'LABELED' AND actual_state IS NOT NULL
            """)
            rows = cur.fetchall()
        conn.close()
    except Exception as e:
        print(f"⚠️ MySQL Error: {e}")
        return None
        
    if not rows:
        print("No labeled observations found.")
        return None
        
    df_obs = pd.DataFrame(rows)
    state_map = {'INDECISION_CHOP': 0, 'BUY_PRESSURE': 1, 'SELL_PRESSURE': 2}
    y_obs = df_obs['actual_state'].map(state_map).values
    fwd_ret = df_obs['actual_return_atr'].astype(float).values
    X_obs = df_obs[FEATURE_COLS].astype(float).values
    
    champ_eval = evaluate_model(champion, X_obs, y_obs, fwd_ret)
    chall_eval = evaluate_model(challenger, X_obs, y_obs, fwd_ret)
    
    return champ_eval, chall_eval, len(df_obs)

def main():
    print("=" * 75)
    print("🥊 CHAMPION vs CHALLENGER: MARKET PRESSURE RETRAINING BENCHMARK")
    print("=" * 75)
    
    df_train, df_test = load_and_prepare_bars()
    
    # 1. Train Challenger
    challenger = train_challenger(df_train)
    
    # 2. Load Champion
    if not os.path.exists(CHAMPION_PATH):
        raise FileNotFoundError(f"Champion model not found at {CHAMPION_PATH}")
    champion = joblib.load(CHAMPION_PATH)
    print(f"👑 Champion model loaded from: {CHAMPION_PATH}")
    
    # 3. Benchmark 1: Out-of-Sample Market Bars (Holdout Test Set)
    print("\n" + "=" * 75)
    print("📊 BENCHMARK 1: RECENT OUT-OF-SAMPLE TEST BARS (Holdout 20%)")
    print("=" * 75)
    
    X_test = df_test[FEATURE_COLS].values
    y_test = df_test['target'].values
    fwd_test = df_test['fwd_3_atr'].values
    
    res_champ_oos = evaluate_model(champion, X_test, y_test, fwd_test)
    res_chall_oos = evaluate_model(challenger, X_test, y_test, fwd_test)
    
    metrics_oos = [
        ("Balanced Accuracy", f"{res_champ_oos['balanced_accuracy']*100:.2f}%", f"{res_chall_oos['balanced_accuracy']*100:.2f}%"),
        ("Overall Accuracy", f"{res_champ_oos['accuracy']*100:.2f}%", f"{res_chall_oos['accuracy']*100:.2f}%"),
        ("Directional Win Rate", f"{res_champ_oos['dir_win_rate']*100:.2f}%", f"{res_chall_oos['dir_win_rate']*100:.2f}%"),
        ("Avg Directional Edge (ATR)", f"{res_champ_oos['avg_dir_edge']:.3f} ATR", f"{res_chall_oos['avg_dir_edge']:.3f} ATR"),
        ("Buy Safe Rate (Anti-Dump)", f"{res_champ_oos['buy_safe_rate']*100:.2f}%", f"{res_chall_oos['buy_safe_rate']*100:.2f}%"),
        ("Sell Safe Rate (Anti-Pump)", f"{res_champ_oos['sell_safe_rate']*100:.2f}%", f"{res_chall_oos['sell_safe_rate']*100:.2f}%"),
        ("High Conviction Safety", f"{res_champ_oos['high_safe_avg']*100:.2f}%", f"{res_chall_oos['high_safe_avg']*100:.2f}%"),
        ("Chop Precision", f"{res_champ_oos['chop_precision']*100:.2f}%", f"{res_chall_oos['chop_precision']*100:.2f}%"),
        ("Buy Signal Precision", f"{res_champ_oos['buy_precision']*100:.2f}%", f"{res_chall_oos['buy_precision']*100:.2f}%"),
        ("Sell Signal Precision", f"{res_champ_oos['sell_precision']*100:.2f}%", f"{res_chall_oos['sell_precision']*100:.2f}%"),
    ]
    
    print(f"\n{'Metric':<28} | {'Champion (v1.0.0)':<20} | {'Challenger (v1.1.0)':<20} | {'Delta':<10}")
    print("-" * 85)
    for name, c_val, ch_val in metrics_oos:
        # Calculate delta string
        c_num = float(c_val.replace('%', '').replace(' ATR', ''))
        ch_num = float(ch_val.replace('%', '').replace(' ATR', ''))
        diff = ch_num - c_num
        diff_str = f"+{diff:.2f}" if diff > 0 else f"{diff:.2f}"
        if '%' in c_val: diff_str += "%"
        elif 'ATR' in c_val: diff_str += " ATR"
        print(f"{name:<28} | {c_val:<20} | {ch_val:<20} | {diff_str:<10}")
        
    # 4. Benchmark 2: Real Live Observations
    obs_res = run_live_observations_benchmark(champion, challenger)
    if obs_res:
        champ_obs, chall_obs, obs_count = obs_res
        print("\n" + "=" * 75)
        print(f"🎯 BENCHMARK 2: REAL-WORLD LIVE OBSERVATIONS ({obs_count:,} Samples)")
        print("=" * 75)
        
        metrics_obs = [
            ("Live Overall Accuracy", f"{champ_obs['accuracy']*100:.2f}%", f"{chall_obs['accuracy']*100:.2f}%"),
            ("Live Balanced Accuracy", f"{champ_obs['balanced_accuracy']*100:.2f}%", f"{chall_obs['balanced_accuracy']*100:.2f}%"),
            ("Live Directional Win Rate", f"{champ_obs['dir_win_rate']*100:.2f}%", f"{chall_obs['dir_win_rate']*100:.2f}%"),
            ("Live Avg Directional Edge", f"{champ_obs['avg_dir_edge']:.3f} ATR", f"{chall_obs['avg_dir_edge']:.3f} ATR"),
            ("Live Buy Safe Rate", f"{champ_obs['buy_safe_rate']*100:.2f}%", f"{chall_obs['buy_safe_rate']*100:.2f}%"),
            ("Live Sell Safe Rate", f"{champ_obs['sell_safe_rate']*100:.2f}%", f"{chall_obs['sell_safe_rate']*100:.2f}%"),
            ("Live High Conviction Safety", f"{champ_obs['high_safe_avg']*100:.2f}%", f"{chall_obs['high_safe_avg']*100:.2f}%"),
            ("Live Chop Detection Precision", f"{champ_obs['chop_precision']*100:.2f}%", f"{chall_obs['chop_precision']*100:.2f}%"),
        ]
        
        print(f"\n{'Metric':<28} | {'Champion (v1.0.0)':<20} | {'Challenger (v1.1.0)':<20} | {'Delta':<10}")
        print("-" * 85)
        for name, c_val, ch_val in metrics_obs:
            c_num = float(c_val.replace('%', '').replace(' ATR', ''))
            ch_num = float(ch_val.replace('%', '').replace(' ATR', ''))
            diff = ch_num - c_num
            diff_str = f"+{diff:.2f}" if diff > 0 else f"{diff:.2f}"
            if '%' in c_val: diff_str += "%"
            elif 'ATR' in c_val: diff_str += " ATR"
            print(f"{name:<28} | {c_val:<20} | {ch_val:<20} | {diff_str:<10}")

    print("\n" + "=" * 75)
    print("🏆 SUMMARY & DECISION")
    print("=" * 75)

if __name__ == '__main__':
    main()
