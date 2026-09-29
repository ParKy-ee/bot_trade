"""
Gold M5 AI Model Retraining & Side-by-Side Comparison
Compares Champion (gold-v1.0.0) vs Candidate (gold-v1.1.0)
Evaluates on:
1. Out-of-sample Gold test bars (20% chronological holdout)
2. Actual closed Gold trades from MySQL (117 trades)
"""

import os
import sys
import types
import json
import warnings
import joblib
import pymysql
import numpy as np
import pandas as pd

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(BASE_DIR, 'python', '.yfinance_cache')
os.makedirs(CACHE_DIR, exist_ok=True)

try:
    import platformdirs
except ModuleNotFoundError:
    platformdirs = types.ModuleType('platformdirs')
    platformdirs.user_cache_dir = lambda appname=None, *args, **kwargs: os.path.join(
        CACHE_DIR, str(appname or 'platformdirs-cache')
    )
    sys.modules['platformdirs'] = platformdirs

from sklearn.preprocessing import RobustScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, fbeta_score, roc_auc_score, average_precision_score,
    log_loss, brier_score_loss, confusion_matrix
)
from lightgbm import LGBMClassifier

MODEL_DIR = os.path.join(BASE_DIR, "python", "models")
CHAMPION_PATH = os.path.join(MODEL_DIR, "gold_m5_model.joblib")
CANDIDATE_PATH = os.path.join(MODEL_DIR, "versions", "gold_m5_model_gold-v1.1.0.joblib")
DATA_PATH = os.path.join(BASE_DIR, "data", "dataset_gold_m5.csv")

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_21_50', 'bb_width', 'asian_sweep',
    'session_num', 'dxy_slope_5', 'h1_trend_slope', 'fvg_bull_bear'
]

def load_data():
    if not os.path.exists(DATA_PATH):
        raise FileNotFoundError(f"Missing {DATA_PATH}")
    df = pd.read_csv(DATA_PATH)
    print(f"📥 Loaded Gold M5 dataset: {len(df):,} bars")
    return df

def find_best_threshold(y_true, probs, min_samples=30):
    thresholds = np.linspace(np.percentile(probs, 40), np.percentile(probs, 98), 50)
    best_th = 0.50
    best_f05 = -1.0
    for th in thresholds:
        pred = (probs >= th).astype(int)
        if pred.sum() >= min_samples:
            score = fbeta_score(y_true, pred, beta=0.5, zero_division=0)
            if score > best_f05:
                best_f05 = score
                best_th = float(th)
    return best_th

def evaluate_head(y_true, probs, threshold=None):
    if threshold is None:
        threshold = find_best_threshold(y_true, probs)
    pred = (probs >= threshold).astype(int)
    
    acc = accuracy_score(y_true, pred)
    prec = precision_score(y_true, pred, zero_division=0)
    rec = recall_score(y_true, pred, zero_division=0)
    f1 = f1_score(y_true, pred, zero_division=0)
    f05 = fbeta_score(y_true, pred, beta=0.5, zero_division=0)
    roc_auc = roc_auc_score(y_true, probs) if len(np.unique(y_true)) > 1 else 0.5
    pr_auc = average_precision_score(y_true, probs) if len(np.unique(y_true)) > 1 else 0.0
    brier = brier_score_loss(y_true, probs)
    
    # High conviction (top 15% probabilities)
    top_th = np.percentile(probs, 85)
    top_pred = (probs >= top_th).astype(int)
    top_prec = precision_score(y_true, top_pred, zero_division=0)
    
    return {
        "threshold": round(threshold, 4),
        "accuracy": round(acc, 4),
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1": round(f1, 4),
        "f05": round(f05, 4),
        "roc_auc": round(roc_auc, 4),
        "pr_auc": round(pr_auc, 4),
        "brier": round(brier, 4),
        "fired_signals": int(pred.sum()),
        "top_prec": round(top_prec, 4)
    }

def train_candidate(df):
    print("\n🔨 Training Candidate Gold Model (gold-v1.1.0) with Enhanced LightGBM...")
    X = df[FEATURE_COLS].values
    y_buy = df['target_buy'].values
    y_sell = df['target_sell'].values

    split_idx = int(len(df) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_buy_train, y_buy_test = y_buy[:split_idx], y_buy[split_idx:]
    y_sell_train, y_sell_test = y_sell[:split_idx], y_sell[split_idx:]

    scaler = RobustScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Enhanced LightGBM parameters (better tree structure, regularized)
    lgbm_params = {
        'n_estimators': 180,
        'learning_rate': 0.03,
        'max_depth': 5,
        'num_leaves': 20,
        'min_child_samples': 25,
        'subsample': 0.80,
        'colsample_bytree': 0.80,
        'random_state': 42,
        'class_weight': 'balanced',
        'verbosity': -1
    }

    # BUY Model
    base_buy = LGBMClassifier(**lgbm_params)
    buy_model = CalibratedClassifierCV(estimator=base_buy, method='sigmoid', cv=3)
    buy_model.fit(X_train_scaled, y_buy_train)

    # SELL Model
    base_sell = LGBMClassifier(**lgbm_params)
    sell_model = CalibratedClassifierCV(estimator=base_sell, method='sigmoid', cv=3)
    sell_model.fit(X_train_scaled, y_sell_train)

    candidate_bundle = {
        "version": "gold-v1.1.0",
        "feature_cols": FEATURE_COLS,
        "scaler": scaler,
        "buy_model": buy_model,
        "sell_model": sell_model,
        "trained_at": pd.Timestamp.now().isoformat()
    }
    os.makedirs(os.path.dirname(CANDIDATE_PATH), exist_ok=True)
    joblib.dump(candidate_bundle, CANDIDATE_PATH)
    print(f"✅ Candidate model saved to: {CANDIDATE_PATH}")

    return candidate_bundle, X_test_scaled, y_buy_test, y_sell_test

def test_on_real_trades(champ_bundle, cand_bundle):
    print("\n🔍 Fetching actual closed Gold trades from MySQL...")
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
                    symbol, action, entry_price, pips, profit_loss, is_win,
                    rsi, adx, atr, ema21, ema50, exit_reason
                FROM trade_results
                WHERE market_type = 'gold' OR symbol IN ('GOLD', 'XAUUSD')
                ORDER BY id DESC
            """)
            rows = cur.fetchall()
        conn.close()
    except Exception as e:
        print(f"⚠️ MySQL Error: {e}")
        return None

    if not rows:
        return None

    df_trades = pd.DataFrame(rows)
    wins = ((df_trades['is_win'] == 1) | (df_trades['profit_loss'] > 0)).sum()
    tot = len(df_trades)
    net_usd = df_trades['profit_loss'].astype(float).sum()
    print(f"📊 Gold Real History: {tot} closed trades | {wins} wins ({(wins/tot)*100:.1f}%) | Net PnL: ${net_usd:.2f}")
    return df_trades

def main():
    print("=" * 75)
    print("🥇 GOLD AI MODEL RETRAINING & CHAMPION vs CANDIDATE BENCHMARK")
    print("=" * 75)

    df = load_data()

    # Load Champion
    champ_bundle = joblib.load(CHAMPION_PATH)
    print(f"👑 Champion loaded from {CHAMPION_PATH} (Version: {champ_bundle.get('version')})")

    # Train Candidate
    cand_bundle, X_test_cand, y_buy_test, y_sell_test = train_candidate(df)

    # Prepare Champion test inputs
    X_test_champ = champ_bundle['scaler'].transform(df[FEATURE_COLS].values[int(len(df) * 0.8):])

    # 1. Champion Predictions
    p_buy_champ = champ_bundle['buy_model'].predict_proba(X_test_champ)[:, 1]
    p_sell_champ = champ_bundle['sell_model'].predict_proba(X_test_champ)[:, 1]

    # Relative probabilities for Champion
    tot_champ = p_buy_champ + p_sell_champ
    rel_buy_champ = p_buy_champ / tot_champ
    rel_sell_champ = p_sell_champ / tot_champ

    champ_eval_buy = evaluate_head(y_buy_test, rel_buy_champ)
    champ_eval_sell = evaluate_head(y_sell_test, rel_sell_champ)

    # 2. Candidate Predictions
    p_buy_cand = cand_bundle['buy_model'].predict_proba(X_test_cand)[:, 1]
    p_sell_cand = cand_bundle['sell_model'].predict_proba(X_test_cand)[:, 1]

    tot_cand = p_buy_cand + p_sell_cand
    rel_buy_cand = p_buy_cand / tot_cand
    rel_sell_cand = p_sell_cand / tot_cand

    cand_eval_buy = evaluate_head(y_buy_test, rel_buy_cand)
    cand_eval_sell = evaluate_head(y_sell_test, rel_sell_cand)

    print("\n" + "=" * 75)
    print("📊 1. BUY HEAD COMPARISON (Out-of-Sample 2,665 Bars)")
    print("=" * 75)
    metrics_buy = [
        ("ROC-AUC", f"{champ_eval_buy['roc_auc']:.4f}", f"{cand_eval_buy['roc_auc']:.4f}"),
        ("PR-AUC (Average Precision)", f"{champ_eval_buy['pr_auc']:.4f}", f"{cand_eval_buy['pr_auc']:.4f}"),
        ("Optimal Threshold", f"{champ_eval_buy['threshold']:.4f}", f"{cand_eval_buy['threshold']:.4f}"),
        ("Fired Signals (Count)", f"{champ_eval_buy['fired_signals']}", f"{cand_eval_buy['fired_signals']}"),
        ("Precision at Threshold", f"{champ_eval_buy['precision']*100:.2f}%", f"{cand_eval_buy['precision']*100:.2f}%"),
        ("F0.5 Score (Precision Focus)", f"{champ_eval_buy['f05']:.4f}", f"{cand_eval_buy['f05']:.4f}"),
        ("Top 15% Conviction Precision", f"{champ_eval_buy['top_prec']*100:.2f}%", f"{cand_eval_buy['top_prec']*100:.2f}%"),
    ]
    print(f"{'Metric':<30} | {'Champion (v1.0.0)':<20} | {'Candidate (v1.1.0)':<20} | {'Delta':<10}")
    print("-" * 85)
    for name, c_val, cd_val in metrics_buy:
        c_num = float(c_val.replace('%', ''))
        cd_num = float(cd_val.replace('%', ''))
        diff = cd_num - c_num
        diff_str = f"+{diff:.2f}" if diff > 0 else f"{diff:.2f}"
        if '%' in c_val: diff_str += "%"
        print(f"{name:<30} | {c_val:<20} | {cd_val:<20} | {diff_str:<10}")

    print("\n" + "=" * 75)
    print("📊 2. SELL HEAD COMPARISON (Out-of-Sample 2,665 Bars)")
    print("=" * 75)
    metrics_sell = [
        ("ROC-AUC", f"{champ_eval_sell['roc_auc']:.4f}", f"{cand_eval_sell['roc_auc']:.4f}"),
        ("PR-AUC (Average Precision)", f"{champ_eval_sell['pr_auc']:.4f}", f"{cand_eval_sell['pr_auc']:.4f}"),
        ("Optimal Threshold", f"{champ_eval_sell['threshold']:.4f}", f"{cand_eval_sell['threshold']:.4f}"),
        ("Fired Signals (Count)", f"{champ_eval_sell['fired_signals']}", f"{cand_eval_sell['fired_signals']}"),
        ("Precision at Threshold", f"{champ_eval_sell['precision']*100:.2f}%", f"{cand_eval_sell['precision']*100:.2f}%"),
        ("F0.5 Score (Precision Focus)", f"{champ_eval_sell['f05']:.4f}", f"{cand_eval_sell['f05']:.4f}"),
        ("Top 15% Conviction Precision", f"{champ_eval_sell['top_prec']*100:.2f}%", f"{cand_eval_sell['top_prec']*100:.2f}%"),
    ]
    print(f"{'Metric':<30} | {'Champion (v1.0.0)':<20} | {'Candidate (v1.1.0)':<20} | {'Delta':<10}")
    print("-" * 85)
    for name, c_val, cd_val in metrics_sell:
        c_num = float(c_val.replace('%', ''))
        cd_num = float(cd_val.replace('%', ''))
        diff = cd_num - c_num
        diff_str = f"+{diff:.2f}" if diff > 0 else f"{diff:.2f}"
        if '%' in c_val: diff_str += "%"
        print(f"{name:<30} | {c_val:<20} | {cd_val:<20} | {diff_str:<10}")

    test_on_real_trades(champ_bundle, cand_bundle)

if __name__ == '__main__':
    main()
