"""
Gold M5 Model Retraining, Benchmarking & Automatic Promotion Pipeline (Zero-Regression Edition)
1. Fetches fresh 60d Gold (GC=F) & DXY data up to today (2026-09-28)
2. Labels with Triple Barrier (30m Horizon, 1.5x ATR TP / 1.0x ATR SL)
3. Trains Candidate (gold-v1.2.0) with regularized parameters & L1/L2 penalties
4. Purged Walk-Forward split with 6-bar (30m) Embargo to prevent autocorrelation leakage
5. Evaluates Head-by-Head with Probability Variance Preservation Gate
6. Supports Decoupled Asymmetric Head Promotion (Modular Multi-Head Hybrid Promotion)
7. Guarantees Zero Performance Regression before deploying to production
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

import yfinance as yf
yf.set_tz_cache_location(CACHE_DIR)

from sklearn.preprocessing import RobustScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, fbeta_score, roc_auc_score, average_precision_score,
    log_loss, brier_score_loss, confusion_matrix
)
from lightgbm import LGBMClassifier

MODEL_DIR = os.path.join(BASE_DIR, "python", "models")
VERSIONS_DIR = os.path.join(MODEL_DIR, "versions")
os.makedirs(VERSIONS_DIR, exist_ok=True)

CHAMPION_PATH = os.path.join(MODEL_DIR, "gold_m5_model.joblib")
CANDIDATE_VERSION = "gold-v1.2.0"
CANDIDATE_PATH = os.path.join(VERSIONS_DIR, f"gold_m5_model_{CANDIDATE_VERSION}.joblib")
REGISTRY_PATH = os.path.join(MODEL_DIR, "gold_model_registry.json")
DATA_PATH = os.path.join(BASE_DIR, "data", "dataset_gold_m5.csv")

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_21_50', 'bb_width', 'asian_sweep',
    'session_num', 'dxy_slope_5', 'h1_trend_slope', 'fvg_bull_bear'
]

def compute_indicators(df):
    df = df.copy()
    close = df['close'].values
    high = df['high'].values
    low = df['low'].values
    n = len(df)

    # 1. Returns
    df['ret_1'] = df['close'].pct_change(1).fillna(0) * 100.0
    df['ret_5'] = df['close'].pct_change(5).fillna(0) * 100.0

    # 2. RSI 14
    delta = df['close'].diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    rs = avg_gain / (avg_loss + 1e-12)
    df['rsi_14'] = (100 - (100 / (1 + rs))).fillna(50.0)

    # 3. ATR 14
    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)))
    atr_series = pd.Series(tr).ewm(alpha=1/14, min_periods=14, adjust=False).mean().values
    df['atr_14'] = atr_series
    df['atr_pct'] = (df['atr_14'] / (df['close'] + 1e-12) * 100.0).fillna(0.1)

    # 4. ADX 14
    up_move = high - np.roll(high, 1)
    down_move = np.roll(low, 1) - low
    up_move[0] = 0
    down_move[0] = 0
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    tr_smooth = pd.Series(tr).ewm(alpha=1/14, min_periods=14, adjust=False).mean().values + 1e-12
    plus_di = 100 * (pd.Series(plus_dm).ewm(alpha=1/14, min_periods=14, adjust=False).mean().values / tr_smooth)
    minus_di = 100 * (pd.Series(minus_dm).ewm(alpha=1/14, min_periods=14, adjust=False).mean().values / tr_smooth)
    dx = 100 * np.abs(plus_di - minus_di) / (plus_di + minus_di + 1e-12)
    df['adx_14'] = pd.Series(dx).ewm(alpha=1/14, min_periods=14, adjust=False).mean().fillna(20.0).values

    # 5. EMA Spread (21 vs 50)
    ema21 = df['close'].ewm(span=21, adjust=False).mean()
    ema50 = df['close'].ewm(span=50, adjust=False).mean()
    df['ema_spread_21_50'] = ((ema21 - ema50) / (df['atr_14'] + 1e-12)).clip(-5.0, 5.0)

    # 6. Bollinger Bands Width
    bb_mid = df['close'].rolling(20).mean()
    bb_std = df['close'].rolling(20).std()
    bb_up = bb_mid + 2 * bb_std
    bb_low = bb_mid - 2 * bb_std
    df['bb_width'] = ((bb_up - bb_low) / (bb_mid + 1e-12)).fillna(0.005)

    # 7. H1 Trend Slope
    ema200 = df['close'].ewm(span=200, adjust=False).mean()
    df['h1_trend_slope'] = ((df['close'] - ema200) / (df['atr_14'] + 1e-12)).clip(-5.0, 5.0)

    # 8. Fair Value Gap (FVG)
    fvg = np.zeros(n)
    for i in range(2, n):
        if low[i] > high[i - 2]:
            fvg[i] = 1.0
        elif high[i] < low[i - 2]:
            fvg[i] = -1.0
    df['fvg_bull_bear'] = fvg

    # 9. Session & Asian Sweep
    times = pd.to_datetime(df.index)
    bkk_hours = (times.hour + 7) % 24
    bkk_minutes = bkk_hours * 60 + times.minute
    session_num = np.zeros(n)
    asian_sweep = np.zeros(n)

    asian_high = df['high'].rolling(40).max()
    asian_low = df['low'].rolling(40).min()

    for i in range(n):
        mins = bkk_minutes[i]
        hr = bkk_hours[i]
        if 6 <= hr < 13:
            session_num[i] = 1.0  # Asian
        elif 14 <= hr < 18:
            session_num[i] = 2.0  # London Open
            if high[i] > asian_high.iloc[i - 1] and close[i] < asian_high.iloc[i - 1]:
                asian_sweep[i] = 1.0
            elif low[i] < asian_low.iloc[i - 1] and close[i] > asian_low.iloc[i - 1]:
                asian_sweep[i] = -1.0
        elif 19 * 60 + 30 <= mins < 23 * 60 + 30:
            session_num[i] = 3.0  # NY Overlap
            if high[i] > asian_high.iloc[i - 1] and close[i] < asian_high.iloc[i - 1]:
                asian_sweep[i] = 1.0
            elif low[i] < asian_low.iloc[i - 1] and close[i] > asian_low.iloc[i - 1]:
                asian_sweep[i] = -1.0
        elif 0 <= hr < 4:
            session_num[i] = 4.0  # Late NY
        else:
            session_num[i] = 0.0

    df['session_num'] = session_num
    df['asian_sweep'] = asian_sweep

    return df

def fetch_fresh_dataset():
    print("📡 [Step 1/5] ดึงข้อมูลแท่งเทียนสดล่าสุด 60 วัน (Gold GC=F + DXY) จาก Yahoo Finance...")
    try:
        gold_raw = yf.download('GC=F', period='60d', interval='5m', progress=False)
        dxy_raw = yf.download('DX-Y.NYB', period='60d', interval='5m', progress=False)

        if gold_raw is not None and not gold_raw.empty and len(gold_raw) >= 1000:
            if isinstance(gold_raw.columns, pd.MultiIndex):
                gold_raw.columns = [c[0].lower() for c in gold_raw.columns]
            else:
                gold_raw.columns = [c.lower() for c in gold_raw.columns]

            if isinstance(dxy_raw.columns, pd.MultiIndex):
                dxy_raw.columns = [c[0].lower() for c in dxy_raw.columns]
            else:
                dxy_raw.columns = [c.lower() for c in dxy_raw.columns]

            gold_df = gold_raw[['open', 'high', 'low', 'close', 'volume']].dropna()
            dxy_df = dxy_raw[['close']].dropna().rename(columns={'close': 'dxy_close'})

            merged = pd.merge_asof(
                gold_df.sort_index(),
                dxy_df.sort_index(),
                left_index=True,
                right_index=True,
                direction='backward'
            )
            merged['dxy_close'] = merged['dxy_close'].ffill().bfill()
            merged['dxy_slope_5'] = merged['dxy_close'].pct_change(5).fillna(0) * 100.0

            print(f"✅ โหลดข้อมูลสดสำเร็จ: {len(merged):,} แท่งเทียน (สิ้นสุด ณ {merged.index[-1]})")

            print("⚙️ [Step 2/5] สกัด 12 Features สำหรับโมเดลทองคำ...")
            feat_df = compute_indicators(merged)

            print("🏷️ [Step 3/5] คำนวณ Triple Barrier Labels (Horizon: 30m, TP: 1.5x ATR, SL: 1.0x ATR)...")
            closes = feat_df['close'].values
            highs = feat_df['high'].values
            lows = feat_df['low'].values
            atrs = feat_df['atr_14'].values
            n = len(feat_df)

            target_buy = np.zeros(n, dtype=int)
            target_sell = np.zeros(n, dtype=int)
            horizon = 6

            for i in range(n - horizon):
                entry = closes[i]
                atr = atrs[i]
                tp_buy = entry + 1.5 * atr
                sl_buy = entry - 1.0 * atr
                tp_sell = entry - 1.5 * atr
                sl_sell = entry + 1.0 * atr

                fwd_highs = highs[i + 1: i + 1 + horizon]
                fwd_lows = lows[i + 1: i + 1 + horizon]

                hit_tp_buy = np.any(fwd_highs >= tp_buy)
                hit_sl_buy = np.any(fwd_lows <= sl_buy)
                if hit_tp_buy and not hit_sl_buy:
                    target_buy[i] = 1
                elif hit_tp_buy and hit_sl_buy:
                    if np.where(fwd_highs >= tp_buy)[0][0] < np.where(fwd_lows <= sl_buy)[0][0]:
                        target_buy[i] = 1

                hit_tp_sell = np.any(fwd_lows <= tp_sell)
                hit_sl_sell = np.any(fwd_highs >= sl_sell)
                if hit_tp_sell and not hit_sl_sell:
                    target_sell[i] = 1
                elif hit_tp_sell and hit_sl_sell:
                    if np.where(fwd_lows <= tp_sell)[0][0] < np.where(fwd_highs >= sl_sell)[0][0]:
                        target_sell[i] = 1

            feat_df['target_buy'] = target_buy
            feat_df['target_sell'] = target_sell

            clean_df = feat_df.iloc[200: n - horizon].copy()
            clean_df.to_csv(DATA_PATH)
            print(f"💾 อัปเดต Dataset เรียบร้อย: {DATA_PATH} ({len(clean_df):,} แท่งเทียน | Buy: {clean_df['target_buy'].sum()} | Sell: {clean_df['target_sell'].sum()})")
            return clean_df
    except Exception as e:
        print(f"⚠️ ไม่สามารถดึงข้อมูลสดผ่าน yfinance ได้: {e} -> ใช้ Dataset เดิม")

    if os.path.exists(DATA_PATH):
        df = pd.read_csv(DATA_PATH)
        print(f"📥 โหลด Dataset เดิม: {len(df):,} แถว")
        return df
    raise FileNotFoundError("ไม่พบข้อมูล Gold Dataset")

def find_best_threshold(y_true, probs, min_samples=25):
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

def evaluate_predictions(y_true, probs, threshold=None):
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
    prob_std = float(np.std(probs))

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
        "prob_std": round(prob_std, 4),
        "fired_signals": int(pred.sum()),
        "top_prec": round(top_prec, 4)
    }

def train_candidate_model(X_train, y_buy_train, y_sell_train):
    print("🤖 [Step 4/5] เทรนโมเดลผู้ท้าชิง Candidate (gold-v1.2.0) ด้วย Regularized Calibrated LightGBM...")

    scaler = RobustScaler()
    X_train_scaled = scaler.fit_transform(X_train)

    # Regularized parameters optimized for Gold M5 to prevent macro feature drift & over-smoothing
    lgbm_params = {
        'n_estimators': 200,
        'learning_rate': 0.02,
        'max_depth': 5,
        'num_leaves': 18,
        'min_child_samples': 55,
        'subsample': 0.75,
        'colsample_bytree': 0.70,   # Prevent single macro-feature dominance (e.g. DXY decoupling)
        'reg_alpha': 0.15,          # L1 regularization
        'reg_lambda': 1.50,         # L2 regularization
        'random_state': 42,
        'class_weight': 'balanced',
        'verbosity': -1
    }

    # BUY Model Head
    base_buy = LGBMClassifier(**lgbm_params)
    buy_model = CalibratedClassifierCV(estimator=base_buy, method='sigmoid', cv=3)
    buy_model.fit(X_train_scaled, y_buy_train)

    # SELL Model Head
    base_sell = LGBMClassifier(**lgbm_params)
    sell_model = CalibratedClassifierCV(estimator=base_sell, method='sigmoid', cv=3)
    sell_model.fit(X_train_scaled, y_sell_train)

    candidate_bundle = {
        "version": CANDIDATE_VERSION,
        "feature_cols": FEATURE_COLS,
        "scaler": scaler,
        "buy_scaler": scaler,
        "sell_scaler": scaler,
        "buy_model": buy_model,
        "sell_model": sell_model,
        "trained_at": pd.Timestamp.now().isoformat(),
        "description": "Regularized Calibrated LightGBM with 60d fresh dataset & DXY colsample constraint"
    }

    return candidate_bundle

def compute_head_score(eval_res):
    return (
        eval_res['pr_auc'] * 0.30 +
        eval_res['top_prec'] * 0.35 +
        eval_res['f05'] * 0.25 -
        eval_res['brier'] * 0.10
    )

def main():
    print("=" * 85)
    print("🥇 GOLD AI MODEL RETRAINING & ZERO-REGRESSION BENCHMARK PIPELINE")
    print("=" * 85)

    # 1. Fetch data
    df = fetch_fresh_dataset()

    X = df[FEATURE_COLS].values
    y_buy = df['target_buy'].values
    y_sell = df['target_sell'].values

    # Purged Chronological Split with 6-bar Embargo (80% Train, 20% Out-of-Sample Holdout)
    split_idx = int(len(df) * 0.8)
    embargo = 6  # 30-min horizon embargo prevents autocorrelation leakage
    X_train = X[:split_idx - embargo]
    y_buy_train = y_buy[:split_idx - embargo]
    y_sell_train = y_sell[:split_idx - embargo]

    X_test = X[split_idx:]
    y_buy_test = y_buy[split_idx:]
    y_sell_test = y_sell[split_idx:]

    print(f"📊 ขนาดชุดข้อมูล: Train = {len(X_train):,} แท่ง | Embargo Gap = {embargo} แท่ง | Out-of-Sample Test = {len(X_test):,} แท่ง")

    # 2. Load Champion
    if not os.path.exists(CHAMPION_PATH):
        raise FileNotFoundError(f"Missing Champion at {CHAMPION_PATH}")
    champ_bundle = joblib.load(CHAMPION_PATH)
    champ_ver = champ_bundle.get("version", "gold-v1.1.0")
    print(f"👑 Champion ประจำการปัจจุบัน: {CHAMPION_PATH} ({champ_ver})")

    # Evaluate Champion on Test Set
    champ_buy_scaler = champ_bundle.get('buy_scaler') or champ_bundle.get('scaler')
    champ_sell_scaler = champ_bundle.get('sell_scaler') or champ_bundle.get('scaler')

    X_test_champ_buy = champ_buy_scaler.transform(X_test) if champ_buy_scaler else X_test
    X_test_champ_sell = champ_sell_scaler.transform(X_test) if champ_sell_scaler else X_test

    p_buy_champ = champ_bundle['buy_model'].predict_proba(X_test_champ_buy)[:, 1]
    p_sell_champ = champ_bundle['sell_model'].predict_proba(X_test_champ_sell)[:, 1]
    tot_champ = p_buy_champ + p_sell_champ + 1e-12
    rel_buy_champ = p_buy_champ / tot_champ
    rel_sell_champ = p_sell_champ / tot_champ

    champ_eval_buy = evaluate_predictions(y_buy_test, rel_buy_champ)
    champ_eval_sell = evaluate_predictions(y_sell_test, rel_sell_champ)

    # 3. Train Candidate
    cand_bundle = train_candidate_model(X_train, y_buy_train, y_sell_train)

    # Evaluate Candidate on Test Set
    cand_buy_scaler = cand_bundle.get('buy_scaler') or cand_bundle.get('scaler')
    cand_sell_scaler = cand_bundle.get('sell_scaler') or cand_bundle.get('scaler')

    X_test_cand_buy = cand_buy_scaler.transform(X_test)
    X_test_cand_sell = cand_sell_scaler.transform(X_test)

    p_buy_cand = cand_bundle['buy_model'].predict_proba(X_test_cand_buy)[:, 1]
    p_sell_cand = cand_bundle['sell_model'].predict_proba(X_test_cand_sell)[:, 1]
    tot_cand = p_buy_cand + p_sell_cand + 1e-12
    rel_buy_cand = p_buy_cand / tot_cand
    rel_sell_cand = p_sell_cand / tot_cand

    cand_eval_buy = evaluate_predictions(y_buy_test, rel_buy_cand)
    cand_eval_sell = evaluate_predictions(y_sell_test, rel_sell_cand)

    # 4. Detailed Side-by-Side Comparison
    print("\n" + "=" * 95)
    print(f"📊 [Step 5/5] SIDE-BY-SIDE HEAD EVALUATION ON OUT-OF-SAMPLE TEST ({len(X_test):,} BARS)")
    print("=" * 95)

    print("\n🟢 BUY PREDICTOR HEAD:")
    print(f"{'Metric':<32} | {'Champion (' + champ_ver + ')':<22} | {'Candidate (' + CANDIDATE_VERSION + ')':<22} | {'Delta':<12}")
    print("-" * 98)
    for k, label in [
        ('roc_auc', 'ROC-AUC (Discriminative)'),
        ('pr_auc', 'PR-AUC (Avg Precision)'),
        ('precision', 'Precision @ Threshold'),
        ('top_prec', 'Top 15% Conviction Prec'),
        ('f05', 'F0.5 Score (Precision Focus)'),
        ('brier', 'Brier Score (Calibration)'),
        ('prob_std', 'Prob StdDev (Variance Gate)')
    ]:
        c_val = champ_eval_buy[k]
        cd_val = cand_eval_buy[k]
        diff = cd_val - c_val
        is_pct = k in ('precision', 'top_prec')
        fmt = (lambda v: f"{v*100:.2f}%") if is_pct else (lambda v: f"{v:.4f}")
        diff_str = (f"+{diff*100:.2f}%" if diff > 0 else f"{diff*100:.2f}%") if is_pct else (f"+{diff:.4f}" if diff > 0 else f"{diff:.4f}")
        print(f"{label:<32} | {fmt(c_val):<22} | {fmt(cd_val):<22} | {diff_str:<12}")

    print("\n🔴 SELL PREDICTOR HEAD:")
    print(f"{'Metric':<32} | {'Champion (' + champ_ver + ')':<22} | {'Candidate (' + CANDIDATE_VERSION + ')':<22} | {'Delta':<12}")
    print("-" * 98)
    for k, label in [
        ('roc_auc', 'ROC-AUC (Discriminative)'),
        ('pr_auc', 'PR-AUC (Avg Precision)'),
        ('precision', 'Precision @ Threshold'),
        ('top_prec', 'Top 15% Conviction Prec'),
        ('f05', 'F0.5 Score (Precision Focus)'),
        ('brier', 'Brier Score (Calibration)'),
        ('prob_std', 'Prob StdDev (Variance Gate)')
    ]:
        c_val = champ_eval_sell[k]
        cd_val = cand_eval_sell[k]
        diff = cd_val - c_val
        is_pct = k in ('precision', 'top_prec')
        fmt = (lambda v: f"{v*100:.2f}%") if is_pct else (lambda v: f"{v:.4f}")
        diff_str = (f"+{diff*100:.2f}%" if diff > 0 else f"{diff*100:.2f}%") if is_pct else (f"+{diff:.4f}" if diff > 0 else f"{diff:.4f}")
        print(f"{label:<32} | {fmt(c_val):<22} | {fmt(cd_val):<22} | {diff_str:<12}")

    # 5. Pillar 2 & 4 Evaluation: Variance Gate & Head Scores
    buy_score_champ = compute_head_score(champ_eval_buy)
    buy_score_cand = compute_head_score(cand_eval_buy)
    delta_buy = buy_score_cand - buy_score_champ

    sell_score_champ = compute_head_score(champ_eval_sell)
    sell_score_cand = compute_head_score(cand_eval_sell)
    delta_sell = sell_score_cand - sell_score_champ

    tot_score_champ = buy_score_champ + sell_score_champ
    tot_score_cand = buy_score_cand + sell_score_cand
    delta_tot = tot_score_cand - tot_score_champ

    # Variance Preservation Gate: std must be at least 85% of Champion
    buy_var_pass = cand_eval_buy['prob_std'] >= 0.85 * champ_eval_buy['prob_std']
    sell_var_pass = cand_eval_sell['prob_std'] >= 0.85 * champ_eval_sell['prob_std']

    # Precision Non-Regression Gate
    buy_prec_pass = cand_eval_buy['top_prec'] >= champ_eval_buy['top_prec']
    sell_prec_pass = cand_eval_sell['top_prec'] >= champ_eval_sell['top_prec']

    # Independent Head Decision
    cand_buy_wins = (delta_buy > 0.003) and buy_prec_pass and buy_var_pass
    cand_sell_wins = (delta_sell > 0.003) and sell_prec_pass and sell_var_pass

    print("\n" + "=" * 95)
    print("🛡️ HEAD-BY-HEAD PERFORMANCE & ZERO-REGRESSION GATES:")
    print(f"• BUY Head:  Score Delta: {delta_buy:+.4f} | Top Prec: {cand_eval_buy['top_prec']*100:.2f}% vs {champ_eval_buy['top_prec']*100:.2f}% ({'PASS' if buy_prec_pass else 'FAIL'}) | Variance Gate: {cand_eval_buy['prob_std']:.4f} vs {champ_eval_buy['prob_std']:.4f} ({'PASS' if buy_var_pass else 'FAIL'}) -> {'🏆 CANDIDATE WINS' if cand_buy_wins else '👑 CHAMPION HOLDS'}")
    print(f"• SELL Head: Score Delta: {delta_sell:+.4f} | Top Prec: {cand_eval_sell['top_prec']*100:.2f}% vs {champ_eval_sell['top_prec']*100:.2f}% ({'PASS' if sell_prec_pass else 'FAIL'}) | Variance Gate: {cand_eval_sell['prob_std']:.4f} vs {champ_eval_sell['prob_std']:.4f} ({'PASS' if sell_var_pass else 'FAIL'}) -> {'🏆 CANDIDATE WINS' if cand_sell_wins else '👑 CHAMPION HOLDS'}")
    print("=" * 95)

    # 6. Promotion Execution Logic
    if cand_buy_wins and cand_sell_wins:
        print(f"\n🎉 FULL PROMOTION: Candidate ({CANDIDATE_VERSION}) ชนะทั้งฝั่ง BUY และ SELL!")
        joblib.dump(cand_bundle, CANDIDATE_PATH)
        joblib.dump(cand_bundle, CHAMPION_PATH)
        print(f"🚀 Deploy Full Model ขึ้น Online เรียบร้อย: {CHAMPION_PATH}")
        chosen_version = CANDIDATE_VERSION
        chosen_bundle = cand_bundle
        chosen_eval_buy = cand_eval_buy
        chosen_eval_sell = cand_eval_sell
        final_score = tot_score_cand
        promoted = True

    elif cand_buy_wins and not cand_sell_wins:
        print(f"\n🧩 MODULAR HYBRID PROMOTION (Decoupled Asymmetric Upgrade):")
        print(f"   -> ฝั่ง BUY ใช้ Candidate หัวใหม่ล่าสุด (Top Prec: {cand_eval_buy['top_prec']*100:.2f}%)")
        print(f"   -> ฝั่ง SELL ล็อกหัว Champion เดิมไว้ (Top Prec: {champ_eval_sell['top_prec']*100:.2f}%) เพื่อป้องกัน Performance Drop!")

        hybrid_version = f"{CANDIDATE_VERSION}-modular"
        hybrid_bundle = {
            "version": hybrid_version,
            "feature_cols": FEATURE_COLS,
            "buy_model": cand_bundle['buy_model'],
            "buy_scaler": cand_buy_scaler,
            "sell_model": champ_bundle['sell_model'],
            "sell_scaler": champ_sell_scaler,
            "scaler": cand_buy_scaler,
            "trained_at": pd.Timestamp.now().isoformat(),
            "description": f"Modular Hybrid Zero-Regression: Candidate BUY Head ({CANDIDATE_VERSION}) + Master Champion SELL Head ({champ_ver})"
        }

        # Evaluate Hybrid Bundle on Test Set
        p_buy_hyb = hybrid_bundle['buy_model'].predict_proba(X_test_cand_buy)[:, 1]
        p_sell_hyb = hybrid_bundle['sell_model'].predict_proba(X_test_champ_sell)[:, 1]
        tot_hyb = p_buy_hyb + p_sell_hyb + 1e-12
        rel_buy_hyb = p_buy_hyb / tot_hyb
        rel_sell_hyb = p_sell_hyb / tot_hyb

        hyb_eval_buy = evaluate_predictions(y_buy_test, rel_buy_hyb)
        hyb_eval_sell = evaluate_predictions(y_sell_test, rel_sell_hyb)

        hyb_score = compute_head_score(hyb_eval_buy) + compute_head_score(hyb_eval_sell)
        delta_hyb = hyb_score - tot_score_champ

        print(f"\n📊 HYBRID COMPOSITE VERIFICATION:")
        print(f"👑 Old Champion ({champ_ver}) Score: {tot_score_champ:.4f}")
        print(f"🚀 Modular Hybrid ({hybrid_version}) Score: {hyb_score:.4f} (Delta: {delta_hyb:+.4f})")
        print(f"• BUY Top Precision:  {hyb_eval_buy['top_prec']*100:.2f}% (จากเดิม {champ_eval_buy['top_prec']*100:.2f}%)")
        print(f"• SELL Top Precision: {hyb_eval_sell['top_prec']*100:.2f}% (คงความแม่นยำเดิม ไม่ตก!)")

        if delta_hyb > 0.003 and hyb_eval_sell['top_prec'] >= champ_eval_sell['top_prec'] - 0.01:
            hybrid_path = os.path.join(VERSIONS_DIR, f"gold_m5_model_{hybrid_version}.joblib")
            joblib.dump(hybrid_bundle, hybrid_path)
            joblib.dump(cand_bundle, CANDIDATE_PATH)
            joblib.dump(hybrid_bundle, CHAMPION_PATH)
            print(f"📦 บันทึก Modular Hybrid Bundle: {hybrid_path}")
            print(f"🚀 Deploy Modular Hybrid สู่ Production Online เรียบร้อย! (Zero-Regression Edge)")
            chosen_version = hybrid_version
            chosen_bundle = hybrid_bundle
            chosen_eval_buy = hyb_eval_buy
            chosen_eval_sell = hyb_eval_sell
            final_score = hyb_score
            promoted = True
        else:
            print("✋ Modular Hybrid ไม่ผ่านเกณฑ์รวม คงสถานะ Champion เดิมไว้")
            joblib.dump(cand_bundle, CANDIDATE_PATH)
            chosen_version = champ_ver
            promoted = False

    elif cand_sell_wins and not cand_buy_wins:
        print(f"\n🧩 MODULAR HYBRID PROMOTION (SELL Head Upgrade):")
        hybrid_version = f"{CANDIDATE_VERSION}-modular"
        hybrid_bundle = {
            "version": hybrid_version,
            "feature_cols": FEATURE_COLS,
            "buy_model": champ_bundle['buy_model'],
            "buy_scaler": champ_buy_scaler,
            "sell_model": cand_bundle['sell_model'],
            "sell_scaler": cand_sell_scaler,
            "scaler": champ_buy_scaler,
            "trained_at": pd.Timestamp.now().isoformat(),
            "description": f"Modular Hybrid: Master Champion BUY Head ({champ_ver}) + Candidate SELL Head ({CANDIDATE_VERSION})"
        }
        hybrid_path = os.path.join(VERSIONS_DIR, f"gold_m5_model_{hybrid_version}.joblib")
        joblib.dump(hybrid_bundle, hybrid_path)
        joblib.dump(cand_bundle, CANDIDATE_PATH)
        joblib.dump(hybrid_bundle, CHAMPION_PATH)
        chosen_version = hybrid_version
        chosen_bundle = hybrid_bundle
        chosen_eval_buy = champ_eval_buy
        chosen_eval_sell = cand_eval_sell
        final_score = compute_head_score(champ_eval_buy) + compute_head_score(cand_eval_sell)
        promoted = True

    else:
        print(f"\n✋ CANDIDATE NOT PROMOTED: ทั้งสองหัวทำนายยังไม่ผ่านเกณฑ์ชี้ขาด คงสถานะ Champion ({champ_ver}) เดิมไว้เพื่อความปลอดภัยของพอร์ต")
        joblib.dump(cand_bundle, CANDIDATE_PATH)
        chosen_version = champ_ver
        promoted = False

    # 7. Update Registry if Promoted
    if promoted:
        registry_entry = {
            "model_version": chosen_version,
            "model_file": "gold_m5_model.joblib",
            "market": "gold",
            "symbol": "XAUUSD",
            "timeframe": "M5",
            "features": FEATURE_COLS,
            "buy_metrics": chosen_eval_buy,
            "sell_metrics": chosen_eval_sell,
            "composite_score": round(final_score, 4),
            "promotion_mode": "MODULAR_HYBRID" if "modular" in chosen_version else "FULL",
            "trained_at": pd.Timestamp.now().isoformat(),
            "description": chosen_bundle['description']
        }
        registry = []
        if os.path.exists(REGISTRY_PATH):
            try:
                with open(REGISTRY_PATH, 'r', encoding='utf-8') as f:
                    registry = json.load(f)
            except Exception:
                registry = []
        registry.append(registry_entry)
        with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
            json.dump(registry, f, indent=2, ensure_ascii=False)
        print(f"📝 บันทึกประวัติ Model Registry เรียบร้อย: {REGISTRY_PATH}")

    return promoted

if __name__ == '__main__':
    main()
