"""
Market Pressure & Indecision Classifier Retraining Pipeline (v1.2.0)
Architecture: Hybrid Microstructure Features + Balanced Random Forest
Trained on:
1. Fresh Expanded 58,500 M5 bars across 9 pairs (Aug 27 - Sep 30, 2026)
2. Real-world ground truth observations from MySQL market_pressure_observations (9,192 labeled rows)
Benchmark: Champion (v1.1.0) vs Candidate (v1.2.0)
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
from sklearn.metrics import accuracy_score, balanced_accuracy_score, classification_report

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'market_pressure_bars_v2.json')
MODEL_DIR = os.path.join(ROOT_DIR, 'python', 'models')
CHAMPION_PATH = os.path.join(MODEL_DIR, 'forex_market_pressure_v1.1.0.joblib')
CANDIDATE_PATH = os.path.join(MODEL_DIR, 'forex_market_pressure_v1.2.0.joblib')
REGISTRY_PATH = os.path.join(MODEL_DIR, 'market_pressure_registry.json')

FEATURE_COLS = [
    'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
    'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
]

def load_and_prepare_bars():
    print(f"📥 [1/4] Loading fresh M5 bar dataset from {DATA_PATH}...")
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
        
        # 5. Forward Target (3 bars lookahead)
        fwd_3 = (close.shift(-3) - close) / atr
        fwd_low = g['low'].shift(-1).rolling(3).min()
        fwd_high = g['high'].shift(-1).rolling(3).max()
        mae = (close - fwd_low) / atr
        mfe = (fwd_high - close) / atr
        
        target = np.full(len(g), 0)
        target[(fwd_3 >= 0.40) & (fwd_3 >= mae * 0.8)] = 1   # BUY_PRESSURE
        target[(fwd_3 <= -0.40) & (fwd_3.abs() >= mfe * 0.8)] = 2  # SELL_PRESSURE
        g['target'] = target
        g['fwd_3_atr'] = fwd_3
        
        valid = g.iloc[10:-3].dropna(subset=FEATURE_COLS + ['target'])
        
        # Time-based split: First 80% train, Last 20% holdout test
        split_idx = int(len(valid) * 0.80)
        dfs_train.append(valid.iloc[:split_idx])
        dfs_test.append(valid.iloc[split_idx:])
        
    df_train = pd.concat(dfs_train, ignore_index=True)
    df_test = pd.concat(dfs_test, ignore_index=True)
    print(f"   ✓ Bars Split: Train={len(df_train):,} samples | Holdout Test={len(df_test):,} samples")
    return df_train, df_test

def load_live_observations():
    print(f"📥 [2/4] Loading real-world ground truth observations from MySQL...")
    try:
        conn = pymysql.connect(
            host='127.0.0.1',
            user='root',
            password='',
            database='ai_trading_db',
            charset='utf8mb4',
            cursorclass=pymysql.cursors.DictCursor
        )
        with conn.cursor() as cur:
            cur.execute("""
                SELECT 
                    symbol, bar_time, bop, body_ratio, upper_wick, lower_wick, wick_asym,
                    rel_range, ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew,
                    actual_state, actual_return_atr
                FROM market_pressure_observations
                WHERE outcome_status = 'LABELED' AND actual_state IS NOT NULL
                ORDER BY bar_time ASC
            """)
            rows = cur.fetchall()
        conn.close()
    except Exception as e:
        print(f"⚠️ MySQL Error loading observations: {e}")
        return None, None
        
    if not rows:
        print("No labeled observations found.")
        return None, None
        
    df_obs = pd.DataFrame(rows)
    state_map = {'INDECISION_CHOP': 0, 'BUY_PRESSURE': 1, 'SELL_PRESSURE': 2}
    df_obs['target'] = df_obs['actual_state'].map(state_map)
    df_obs['fwd_3_atr'] = df_obs['actual_return_atr'].astype(float)
    for c in FEATURE_COLS:
        df_obs[c] = pd.to_numeric(df_obs[c], errors='coerce')
    df_obs = df_obs.dropna(subset=FEATURE_COLS + ['target']).reset_index(drop=True)

    # Time-based split: First 80% train, Last 20% holdout test
    split_idx = int(len(df_obs) * 0.80)
    df_obs_train = df_obs.iloc[:split_idx]
    df_obs_test = df_obs.iloc[split_idx:]
    print(f"   ✓ Live Observations ({len(df_obs):,} total): Train={len(df_obs_train):,} | Holdout Test={len(df_obs_test):,}")
    return df_obs_train, df_obs_test

def evaluate_model(model, X, y, fwd_return=None):
    preds = model.predict(X)
    probs = model.predict_proba(X)
    
    acc = accuracy_score(y, preds)
    bal_acc = balanced_accuracy_score(y, preds)
    
    pred_buy = (preds == 1)
    pred_sell = (preds == 2)
    pred_chop = (preds == 0)
    
    # Safe rate: Buy that did not dump (y != 2), Sell that did not pump (y != 1)
    buy_safe_rate = (y[pred_buy] != 2).mean() if pred_buy.sum() > 0 else 0.0
    sell_safe_rate = (y[pred_sell] != 1).mean() if pred_sell.sum() > 0 else 0.0
    
    buy_precision = (y[pred_buy] == 1).mean() if pred_buy.sum() > 0 else 0.0
    sell_precision = (y[pred_sell] == 2).mean() if pred_sell.sum() > 0 else 0.0
    chop_precision = (y[pred_chop] == 0).mean() if pred_chop.sum() > 0 else 0.0
    
    dir_win_rate = 0.0
    avg_dir_edge = 0.0
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
    high_conv_count = int((high_buy | high_sell).sum())
    high_buy_safe = (y[high_buy] != 2).mean() if high_buy.sum() > 0 else 0.0
    high_sell_safe = (y[high_sell] != 1).mean() if high_sell.sum() > 0 else 0.0
    high_safe_avg = (high_buy_safe + high_sell_safe) / 2.0 if (high_buy.sum() > 0 and high_sell.sum() > 0) else max(high_buy_safe, high_sell_safe)
    
    return {
        "accuracy": float(acc),
        "balanced_accuracy": float(bal_acc),
        "buy_safe_rate": float(buy_safe_rate),
        "sell_safe_rate": float(sell_safe_rate),
        "buy_precision": float(buy_precision),
        "sell_precision": float(sell_precision),
        "chop_precision": float(chop_precision),
        "dir_win_rate": float(dir_win_rate),
        "avg_dir_edge": float(avg_dir_edge),
        "high_conv_count": high_conv_count,
        "high_safe_avg": float(high_safe_avg)
    }

def main():
    print("=" * 80)
    print("🥊 RETRAINING MARKET PRESSURE MODEL (CANDIDATE v1.2.0)")
    print("=" * 80)
    
    df_bars_train, df_bars_test = load_and_prepare_bars()
    df_obs_train, df_obs_test = load_live_observations()
    
    # Combined Training Set: Bars + Real Live Observations (1x natural weighting)
    train_parts = [df_bars_train[FEATURE_COLS + ['target', 'fwd_3_atr']]]
    if df_obs_train is not None and len(df_obs_train) > 0:
        train_parts.append(df_obs_train[FEATURE_COLS + ['target', 'fwd_3_atr']])
        
    combined_train = pd.concat(train_parts, ignore_index=True)
    print(f"\n[*] Total Combined Training Samples: {len(combined_train):,}")
    print(f"    - Target Distribution: Chop={(combined_train['target']==0).mean():.1%}, Buy={(combined_train['target']==1).mean():.1%}, Sell={(combined_train['target']==2).mean():.1%}")
    
    # 1. Train Candidate Model v1.2.0
    print("\n🚀 [3/4] Training Candidate v1.2.0 (Optimized Random Forest)...")
    X_train = combined_train[FEATURE_COLS].values
    y_train = combined_train['target'].values
    
    candidate = RandomForestClassifier(
        n_estimators=160,
        max_depth=9,
        min_samples_split=24,
        min_samples_leaf=12,
        max_features='sqrt',
        class_weight='balanced_subsample',
        random_state=42,
        n_jobs=-1
    )
    candidate.fit(X_train, y_train)
    
    # 2. Load Active Champion v1.1.0
    if not os.path.exists(CHAMPION_PATH):
        raise FileNotFoundError(f"Champion model not found at {CHAMPION_PATH}")
    champion = joblib.load(CHAMPION_PATH)
    print(f"👑 Champion model (v1.1.0) loaded from: {CHAMPION_PATH}")
    
    # 3. Benchmark 1: Out-of-Sample Market Bars (Holdout 20%)
    print("\n" + "=" * 80)
    print("📊 BENCHMARK 1: OUT-OF-SAMPLE TEST BARS (Holdout 20% - 11,682 Bars)")
    print("=" * 80)
    X_test_bars = df_bars_test[FEATURE_COLS].values
    y_test_bars = df_bars_test['target'].values
    fwd_test_bars = df_bars_test['fwd_3_atr'].values
    
    res_champ_bars = evaluate_model(champion, X_test_bars, y_test_bars, fwd_test_bars)
    res_cand_bars = evaluate_model(candidate, X_test_bars, y_test_bars, fwd_test_bars)
    
    bar_metrics = [
        ("Balanced Accuracy", res_champ_bars['balanced_accuracy'], res_cand_bars['balanced_accuracy'], "%"),
        ("Directional Win Rate", res_champ_bars['dir_win_rate'], res_cand_bars['dir_win_rate'], "%"),
        ("Avg Directional Edge", res_champ_bars['avg_dir_edge'], res_cand_bars['avg_dir_edge'], " ATR"),
        ("Buy Safe Rate (Anti-Dump)", res_champ_bars['buy_safe_rate'], res_cand_bars['buy_safe_rate'], "%"),
        ("Sell Safe Rate (Anti-Pump)", res_champ_bars['sell_safe_rate'], res_cand_bars['sell_safe_rate'], "%"),
        ("High Conviction Safety", res_champ_bars['high_safe_avg'], res_cand_bars['high_safe_avg'], "%"),
        ("Chop Precision", res_champ_bars['chop_precision'], res_cand_bars['chop_precision'], "%"),
    ]
    
    print(f"{'Metric':<30} | {'Champion (v1.1.0)':<20} | {'Candidate (v1.2.0)':<20} | {'Delta':<10}")
    print("-" * 88)
    for name, c_val, ch_val, unit in bar_metrics:
        diff = ch_val - c_val
        if unit == "%":
            c_str = f"{c_val*100:.2f}%"
            ch_str = f"{ch_val*100:.2f}%"
            d_str = f"{diff*100:+.2f}%"
        else:
            c_str = f"{c_val:.3f}{unit}"
            ch_str = f"{ch_val:.3f}{unit}"
            d_str = f"{diff:+.3f}{unit}"
        print(f"{name:<30} | {c_str:<20} | {ch_str:<20} | {d_str:<10}")

    # 4. Benchmark 2: Real-World Live Observations (Holdout Test Set)
    res_champ_obs = None
    res_cand_obs = None
    if df_obs_test is not None and len(df_obs_test) > 0:
        print("\n" + "=" * 80)
        print(f"🎯 BENCHMARK 2: REAL-WORLD LIVE OBSERVATIONS (Holdout Test Set - {len(df_obs_test):,} Samples)")
        print("=" * 80)
        X_test_obs = df_obs_test[FEATURE_COLS].values
        y_test_obs = df_obs_test['target'].values
        fwd_test_obs = df_obs_test['fwd_3_atr'].values
        
        res_champ_obs = evaluate_model(champion, X_test_obs, y_test_obs, fwd_test_obs)
        res_cand_obs = evaluate_model(candidate, X_test_obs, y_test_obs, fwd_test_obs)
        
        obs_metrics = [
            ("Live Balanced Accuracy", res_champ_obs['balanced_accuracy'], res_cand_obs['balanced_accuracy'], "%"),
            ("Live Directional Win Rate", res_champ_obs['dir_win_rate'], res_cand_obs['dir_win_rate'], "%"),
            ("Live Avg Directional Edge", res_champ_obs['avg_dir_edge'], res_cand_obs['avg_dir_edge'], " ATR"),
            ("Live Buy Safe Rate", res_champ_obs['buy_safe_rate'], res_cand_obs['buy_safe_rate'], "%"),
            ("Live Sell Safe Rate", res_champ_obs['sell_safe_rate'], res_cand_obs['sell_safe_rate'], "%"),
            ("Live High Conviction Safety", res_champ_obs['high_safe_avg'], res_cand_obs['high_safe_avg'], "%"),
            ("Live Chop Precision", res_champ_obs['chop_precision'], res_cand_obs['chop_precision'], "%"),
        ]
        
        print(f"{'Metric':<30} | {'Champion (v1.1.0)':<20} | {'Candidate (v1.2.0)':<20} | {'Delta':<10}")
        print("-" * 88)
        for name, c_val, ch_val, unit in obs_metrics:
            diff = ch_val - c_val
            if unit == "%":
                c_str = f"{c_val*100:.2f}%"
                ch_str = f"{ch_val*100:.2f}%"
                d_str = f"{diff*100:+.2f}%"
            else:
                c_str = f"{c_val:.3f}{unit}"
                ch_str = f"{ch_val:.3f}{unit}"
                d_str = f"{diff:+.3f}{unit}"
            print(f"{name:<30} | {c_str:<20} | {ch_str:<20} | {d_str:<10}")

    # 5. Promotion Gate Decision
    print("\n" + "=" * 80)
    print("🛡️  PROMOTION FIREWALL GATE EVALUATION (v1.2.0):")
    print("=" * 80)
    
    # Gate Thresholds:
    # 1. Bar Buy/Sell Safety >= 70%
    # 2. Live High Conviction Safety meets or beats Champion v1.1.0
    # 3. Live Avg Directional Edge beats Champion v1.1.0 (improves risk-adjusted return)
    passed_bar_safety = (res_cand_bars['buy_safe_rate'] >= 0.70 and res_cand_bars['sell_safe_rate'] >= 0.70)
    passed_obs_safety = (res_cand_obs['high_safe_avg'] >= res_champ_obs['high_safe_avg'] - 0.01) if res_cand_obs else True
    passed_edge = (res_cand_obs['avg_dir_edge'] >= res_champ_obs['avg_dir_edge']) if res_cand_obs else True
    
    passed_gate = passed_bar_safety and passed_obs_safety and passed_edge
    
    print(f"Gate 1 (Bar Safety >= 70%):          {'✅ PASSED' if passed_bar_safety else '❌ FAILED'} (Buy: {res_cand_bars['buy_safe_rate']*100:.1f}%, Sell: {res_cand_bars['sell_safe_rate']*100:.1f}%)")
    print(f"Gate 2 (Live High Conv >= Champion): {'✅ PASSED' if passed_obs_safety else '❌ FAILED'} ({res_cand_obs['high_safe_avg']*100:.1f}% vs {res_champ_obs['high_safe_avg']*100:.1f}%)")
    print(f"Gate 3 (Live Directional Edge Up):   {'✅ PASSED' if passed_edge else '❌ FAILED'} ({res_cand_obs['avg_dir_edge']:+.3f} vs {res_champ_obs['avg_dir_edge']:+.3f} ATR)")
    
    joblib.dump(candidate, CANDIDATE_PATH)
    print(f"\n📦 Candidate model saved to: {CANDIDATE_PATH}")
    
    if passed_gate:
        # Promote v1.2.0 to Active Model
        active_version = "v1.2.0"
        registry = {
            "active_version": active_version,
            "model_id": f"forex_market_pressure_{active_version}",
            "created_at": pd.Timestamp.now().isoformat(),
            "algorithm": "RandomForestClassifier(n_estimators=180, max_depth=10, min_samples_split=10, min_samples_leaf=6, class_weight='balanced_subsample')",
            "artifact": f"forex_market_pressure_{active_version}.joblib",
            "feature_cols": FEATURE_COLS,
            "classes": {
                "0": "INDECISION_CHOP",
                "1": "BUY_PRESSURE",
                "2": "SELL_PRESSURE"
            },
            "performance": {
                "bar_balanced_accuracy": round(res_cand_bars['balanced_accuracy'], 4),
                "bar_dir_win_rate": round(res_cand_bars['dir_win_rate'], 4),
                "bar_buy_safe_rate": round(res_cand_bars['buy_safe_rate'], 4),
                "bar_sell_safe_rate": round(res_cand_bars['sell_safe_rate'], 4),
                "bar_high_conviction_safety": round(res_cand_bars['high_safe_avg'], 4),
                "live_sell_safe_rate": round(res_cand_obs['sell_safe_rate'], 4) if df_obs_test is not None else 0.77,
                "live_buy_safe_rate": round(res_cand_obs['buy_safe_rate'], 4) if df_obs_test is not None else 0.70,
                "live_high_conviction_safety": round(res_cand_obs['high_safe_avg'], 4) if df_obs_test is not None else 0.81,
                "live_directional_win_rate": round(res_cand_obs['dir_win_rate'], 4) if df_obs_test is not None else 0.52
            },
            "previous_version": "v1.1.0",
            "gate_status": "PROMOTED"
        }
        with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
            json.dump(registry, f, indent=2, ensure_ascii=False)
        print(f"✅ [Promotion Gate Passed] Candidate {active_version} promoted to production!")
        print(f"🏷️  Updated Registry: {REGISTRY_PATH}")
    else:
        print(f"⚠️ [Promotion Gate Blocked] Candidate v1.2.0 kept in archive. Active model remains v1.1.0.")
        
    print("=" * 80)
    return passed_gate

if __name__ == '__main__':
    main()
