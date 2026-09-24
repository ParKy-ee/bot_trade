import os
import sys
import types
import json
import warnings
import numpy as np
import pandas as pd
import joblib

# Windows UTF-8 stdout configuration
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

# Platformdirs mock for yfinance
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

from sklearn.ensemble import GradientBoostingClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import RobustScaler
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, fbeta_score, roc_auc_score, average_precision_score,
    log_loss, brier_score_loss, matthews_corrcoef
)
from lightgbm import LGBMClassifier

MODEL_DIR = os.path.join(BASE_DIR, "python", "models")
VERSIONS_DIR = os.path.join(MODEL_DIR, "versions")
os.makedirs(VERSIONS_DIR, exist_ok=True)
MODEL_PATH = os.path.join(MODEL_DIR, "gold_m5_model.joblib")
REGISTRY_PATH = os.path.join(MODEL_DIR, "gold_model_registry.json")
DATA_PATH = os.path.join(BASE_DIR, "data", "dataset_gold_m5.csv")

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_21_50', 'bb_width', 'asian_sweep',
    'session_num', 'dxy_slope_5', 'h1_trend_slope', 'fvg_bull_bear'
]


def compute_indicators(df):
    """Compute technical indicators for Gold dataset."""
    df = df.copy()
    close = df['close'].values
    high = df['high'].values
    low = df['low'].values
    n = len(df)

    # 1. Returns
    df['ret_1'] = df['close'].pct_change(1).fillna(0)
    df['ret_5'] = df['close'].pct_change(5).fillna(0)

    # 2. RSI 14
    delta = df['close'].diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=13, min_periods=14).mean()
    avg_loss = loss.ewm(com=13, min_periods=14).mean()
    rs = avg_gain / (avg_loss + 1e-12)
    df['rsi_14'] = 100 - (100 / (1 + rs))
    df['rsi_14'] = df['rsi_14'].fillna(50)

    # 3. ATR 14
    prev_close = df['close'].shift(1).fillna(df['close'])
    tr1 = df['high'] - df['low']
    tr2 = (df['high'] - prev_close).abs()
    tr3 = (df['low'] - prev_close).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    df['atr_14'] = tr.ewm(com=13, min_periods=14).mean().fillna(tr)
    df['atr_pct'] = (df['atr_14'] / (df['close'] + 1e-12)).fillna(0.001)

    # 4. ADX 14
    up_move = df['high'].diff()
    down_move = -df['low'].diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    smooth_plus_dm = pd.Series(plus_dm, index=df.index).ewm(com=13, min_periods=14).mean()
    smooth_minus_dm = pd.Series(minus_dm, index=df.index).ewm(com=13, min_periods=14).mean()
    plus_di = (smooth_plus_dm / (df['atr_14'] + 1e-12)) * 100
    minus_di = (smooth_minus_dm / (df['atr_14'] + 1e-12)) * 100
    dx = ((plus_di - minus_di).abs() / (plus_di + minus_di + 1e-12)) * 100
    df['adx_14'] = dx.ewm(com=13, min_periods=14).mean().fillna(20)

    # 5. EMA 21 & EMA 50 & Spread
    ema21 = df['close'].ewm(span=21, adjust=False).mean()
    ema50 = df['close'].ewm(span=50, adjust=False).mean()
    df['ema_spread_21_50'] = (ema21 - ema50) / (df['atr_14'] + 1e-12)

    # 6. Bollinger Bands (20, 2)
    bb_mid = df['close'].rolling(20).mean()
    bb_std = df['close'].rolling(20).std()
    bb_up = bb_mid + 2 * bb_std
    bb_low = bb_mid - 2 * bb_std
    df['bb_width'] = ((bb_up - bb_low) / (bb_mid + 1e-12)).fillna(0.005)

    # 7. H1 Trend Slope (EMA 200 proxy or 12-bar slope)
    ema200 = df['close'].ewm(span=200, adjust=False).mean()
    df['h1_trend_slope'] = ((df['close'] - ema200) / (df['atr_14'] + 1e-12)).clip(-5.0, 5.0)

    # 8. Fair Value Gap (FVG)
    # Bullish FVG: low[t] > high[t-2]
    # Bearish FVG: high[t] < low[t-2]
    fvg = np.zeros(n)
    for i in range(2, n):
        if low[i] > high[i - 2]:
            fvg[i] = 1.0
        elif high[i] < low[i - 2]:
            fvg[i] = -1.0
    df['fvg_bull_bear'] = fvg

    # 9. Session and Asian Sweep
    # Timezone conversion to Bangkok time (UTC+7)
    times = pd.to_datetime(df.index)
    bkk_hours = (times.hour + 7) % 24
    bkk_minutes = bkk_hours * 60 + times.minute

    session_num = np.zeros(n)
    asian_sweep = np.zeros(n)

    # Calculate rolling Asian Range (approx 06:00 - 13:00 BKK)
    asian_high = df['high'].rolling(40).max()
    asian_low = df['low'].rolling(40).min()

    for i in range(n):
        mins = bkk_minutes[i]
        hr = bkk_hours[i]
        if 6 <= hr < 13:
            session_num[i] = 1.0  # ASIAN
        elif 14 <= hr < 18:
            session_num[i] = 2.0  # LONDON_OPEN
            # Check Asian High / Low sweep
            if high[i] > asian_high.iloc[i - 1] and close[i] < asian_high.iloc[i - 1]:
                asian_sweep[i] = 1.0  # Bearish sweep of Asian High
            elif low[i] < asian_low.iloc[i - 1] and close[i] > asian_low.iloc[i - 1]:
                asian_sweep[i] = -1.0  # Bullish sweep of Asian Low
        elif 19 * 60 + 30 <= mins < 23 * 60 + 30:
            session_num[i] = 3.0  # LONDON_NY_OVERLAP (Golden Window)
            if high[i] > asian_high.iloc[i - 1] and close[i] < asian_high.iloc[i - 1]:
                asian_sweep[i] = 1.0
            elif low[i] < asian_low.iloc[i - 1] and close[i] > asian_low.iloc[i - 1]:
                asian_sweep[i] = -1.0
        elif 0 <= hr < 4:
            session_num[i] = 4.0  # LATE_NY
        else:
            session_num[i] = 0.0  # OTHER / ROLLOVER

    df['session_num'] = session_num
    df['asian_sweep'] = asian_sweep

    return df


def fetch_and_prepare_gold_dataset():
    """Fetch 60d of Gold and DXY data, compute features and Triple Barrier labels."""
    print("📥 [1/4] ดึงข้อมูลแท่งเทียน 5m สำหรับ Gold (GC=F) และ Dollar Index (DX-Y.NYB) จาก Yahoo Finance...")
    
    gold_raw = yf.download('GC=F', period='60d', interval='5m', progress=False)
    dxy_raw = yf.download('DX-Y.NYB', period='60d', interval='5m', progress=False)

    if gold_raw is None or gold_raw.empty or len(gold_raw) < 500:
        raise ValueError("Failed to fetch adequate Gold 5m data")

    # Flatten MultiIndex columns if present
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

    # Merge on Datetime Index
    merged = pd.merge_asof(
        gold_df.sort_index(),
        dxy_df.sort_index(),
        left_index=True,
        right_index=True,
        direction='backward'
    )
    merged['dxy_close'] = merged['dxy_close'].ffill().bfill()
    merged['dxy_slope_5'] = merged['dxy_close'].pct_change(5).fillna(0) * 100.0

    print(f"✅ ดึงข้อมูลสำเร็จ: {len(merged)} แท่งเทียน Gold M5")

    # Feature Engineering
    print("⚙️ [2/4] สกัด 12 Features สำหรับโมเดลทองคำ...")
    feat_df = compute_indicators(merged)

    # Triple Barrier Labeling
    # Forward Horizon = 6 bars (30 mins)
    # Target Buy: Price reaches +1.5x ATR before -1.0x ATR
    # Target Sell: Price reaches -1.5x ATR before +1.0x ATR
    print("🏷️ [3/4] คำนวณ Triple Barrier Labels (Horizon: 30m, TP: 1.5x ATR, SL: 1.0x ATR)...")
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

        # Check forward path
        fwd_highs = highs[i + 1: i + 1 + horizon]
        fwd_lows = lows[i + 1: i + 1 + horizon]

        # Buy evaluation
        hit_tp_buy = np.any(fwd_highs >= tp_buy)
        hit_sl_buy = np.any(fwd_lows <= sl_buy)
        if hit_tp_buy and not hit_sl_buy:
            target_buy[i] = 1
        elif hit_tp_buy and hit_sl_buy:
            # First touch check
            idx_tp = np.where(fwd_highs >= tp_buy)[0][0]
            idx_sl = np.where(fwd_lows <= sl_buy)[0][0]
            if idx_tp < idx_sl:
                target_buy[i] = 1

        # Sell evaluation
        hit_tp_sell = np.any(fwd_lows <= tp_sell)
        hit_sl_sell = np.any(fwd_highs >= sl_sell)
        if hit_tp_sell and not hit_sl_sell:
            target_sell[i] = 1
        elif hit_tp_sell and hit_sl_sell:
            idx_tp = np.where(fwd_lows <= tp_sell)[0][0]
            idx_sl = np.where(fwd_highs >= sl_sell)[0][0]
            if idx_tp < idx_sl:
                target_sell[i] = 1

    feat_df['target_buy'] = target_buy
    feat_df['target_sell'] = target_sell

    # Drop burn-in and forward horizon rows
    clean_df = feat_df.iloc[200: n - horizon].copy()
    clean_df.to_csv(DATA_PATH)
    print(f"💾 บันทึกชุดข้อมูลสำเร็จ: {DATA_PATH} ({len(clean_df)} แถว, Buy Signals: {clean_df['target_buy'].sum()}, Sell Signals: {clean_df['target_sell'].sum()})")

    return clean_df


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

    # Precision in high-confidence band (>= 0.60)
    high_mask = y_prob >= 0.60
    high_prec = precision_score(y_true[high_mask], np.ones(high_mask.sum()), zero_division=0) if high_mask.sum() > 0 else 0.0

    return {
        "accuracy": round(float(acc), 4),
        "precision": round(float(prec), 4),
        "recall": round(float(rec), 4),
        "f1": round(float(f1), 4),
        "f2": round(float(f2), 4),
        "mcc": round(float(mcc), 4),
        "roc_auc": round(float(roc_auc), 4),
        "pr_auc": round(float(pr_auc), 4),
        "brier_score": round(float(brier), 4),
        "log_loss": round(float(ll), 4),
        "high_conf_samples": int(high_mask.sum()),
        "high_conf_precision": round(float(high_prec), 4)
    }


def train_gold_model():
    print("🚀 [4/4] เริ่มต้นกระบวนการเทรน AI Model สำหรับทองคำ (XAUUSD M5)...")

    df = fetch_and_prepare_gold_dataset()
    X = df[FEATURE_COLS].values
    y_buy = df['target_buy'].values
    y_sell = df['target_sell'].values

    # Chronological Out-of-Sample Train/Test Split (80% Train, 20% Test)
    split_idx = int(len(df) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_buy_train, y_buy_test = y_buy[:split_idx], y_buy[split_idx:]
    y_sell_train, y_sell_test = y_sell[:split_idx], y_sell[split_idx:]

    print(f"📊 ขนาดชุดข้อมูล: Train={len(X_train)} แถว | Test={len(X_test)} แถว")

    # Scaler
    scaler = RobustScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Train BUY Model Head (LightGBM + Calibrated Probability)
    print("🤖 กำลังเทรน Head 1: BUY Predictor (LightGBM)...")
    base_buy = LGBMClassifier(
        n_estimators=160,
        learning_rate=0.035,
        max_depth=5,
        num_leaves=24,
        subsample=0.85,
        colsample_bytree=0.85,
        random_state=42,
        verbosity=-1
    )
    buy_model = CalibratedClassifierCV(estimator=base_buy, method='sigmoid', cv=3)
    buy_model.fit(X_train_scaled, y_buy_train)

    buy_probs_test = buy_model.predict_proba(X_test_scaled)[:, 1]
    buy_metrics = calc_metrics(y_buy_test, buy_probs_test, thresh=0.45)

    # Train SELL Model Head (LightGBM + Calibrated Probability)
    print("🤖 กำลังเทรน Head 2: SELL Predictor (LightGBM)...")
    base_sell = LGBMClassifier(
        n_estimators=160,
        learning_rate=0.035,
        max_depth=5,
        num_leaves=24,
        subsample=0.85,
        colsample_bytree=0.85,
        random_state=42,
        verbosity=-1
    )
    sell_model = CalibratedClassifierCV(estimator=base_sell, method='sigmoid', cv=3)
    sell_model.fit(X_train_scaled, y_sell_train)

    sell_probs_test = sell_model.predict_proba(X_test_scaled)[:, 1]
    sell_metrics = calc_metrics(y_sell_test, sell_probs_test, thresh=0.45)

    print("\n=======================================================")
    print("🏆 [GOLD MODEL EVALUATION RESULTS ON OUT-OF-SAMPLE TEST]")
    print("=======================================================")
    print(f"📈 BUY Head  | F1: {buy_metrics['f1']} | ROC-AUC: {buy_metrics['roc_auc']} | Brier: {buy_metrics['brier_score']} | High Conf Prec (>=60%): {buy_metrics['high_conf_precision'] * 100}% ({buy_metrics['high_conf_samples']} samples)")
    print(f"📉 SELL Head | F1: {sell_metrics['f1']} | ROC-AUC: {sell_metrics['roc_auc']} | Brier: {sell_metrics['brier_score']} | High Conf Prec (>=60%): {sell_metrics['high_conf_precision'] * 100}% ({sell_metrics['high_conf_samples']} samples)")
    print("=======================================================\n")

    # Feature Importance (from base estimators)
    try:
        base_buy.fit(X_train_scaled, y_buy_train)
        importances = base_buy.feature_importances_
        sorted_idx = np.argsort(importances)[::-1]
        print("🔍 อันดับความสำคัญของฟีเจอร์ (Feature Importances):")
        for rank, idx in enumerate(sorted_idx, 1):
            print(f"   {rank}. {FEATURE_COLS[idx]}: {importances[idx]}")
    except Exception:
        pass

    # Model Versioning & Bundle
    version = "gold-v1.0.0"
    model_bundle = {
        "version": version,
        "feature_cols": FEATURE_COLS,
        "scaler": scaler,
        "buy_model": buy_model,
        "sell_model": sell_model,
        "buy_metrics": buy_metrics,
        "sell_metrics": sell_metrics,
        "trained_at": pd.Timestamp.now().isoformat()
    }

    # Save to primary path and version archive
    joblib.dump(model_bundle, MODEL_PATH)
    archive_path = os.path.join(VERSIONS_DIR, f"gold_m5_model_{version}.joblib")
    joblib.dump(model_bundle, archive_path)
    print(f"💾 บันทึกโมเดลสำเร็จ: {MODEL_PATH}")
    print(f"📦 บันทึกคลังประวัติโมเดล: {archive_path}")

    # Update Registry
    registry_entry = {
        "model_version": version,
        "model_file": "gold_m5_model.joblib",
        "market": "gold",
        "symbol": "XAUUSD",
        "timeframe": "M5",
        "features": FEATURE_COLS,
        "buy_metrics": buy_metrics,
        "sell_metrics": sell_metrics,
        "trained_at": pd.Timestamp.now().isoformat()
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

    print(f"📝 อัปเดต Model Registry เรียบร้อย: {REGISTRY_PATH}")
    print("\n✅ การสร้างและเทรน Dedicated Gold Model v1.0.0 เสร็จสมบูรณ์ 100%!")


if __name__ == "__main__":
    train_gold_model()
