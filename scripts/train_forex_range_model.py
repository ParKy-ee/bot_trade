"""Train the Forex range mean-reversion expert.

This model is intentionally different from the trend-oriented Champion and
Challenger models.  It is trained only on low-trend, compressed market states
and predicts whether a short-horizon range bounce reaches its target before a
protective stop.
"""

import json
import os
import sys
import warnings

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    f1_score,
    fbeta_score,
    matthews_corrcoef,
    precision_score,
    recall_score,
    roc_auc_score,
)

warnings.filterwarnings("ignore")
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, "python", "models")
VERSIONS_DIR = os.path.join(MODEL_DIR, "versions")
MODEL_PATH = os.path.join(MODEL_DIR, "forex_range_model.joblib")
REGISTRY_PATH = os.path.join(MODEL_DIR, "range_registry.json")
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_forex_m5.csv")

FEATURE_COLS = [
    "rsi_14", "adx_14", "atr_pct", "ema_spread_20_50", "macd_hist",
    "range_position", "distance_to_mid_atr", "bb_width", "bb_width_ratio",
    "efficiency_ratio", "upper_wick_pct", "lower_wick_pct", "is_jpy",
]

MODEL_VERSION = "range-v1.0.0"
MAX_ADX = 24.0
MAX_EMA_ATR = 0.50
MAX_BB_RATIO = 1.20
MAX_EFFICIENCY = 0.50
LOOKAHEAD_BARS = 6
TP_ATR = 0.80
SL_ATR = 0.60


def add_range_features(df):
    df = df.sort_values(["symbol", "time"]).copy()
    groups = df.groupby("symbol", sort=False)
    df["mid20"] = groups["close"].transform(lambda s: s.rolling(20).mean())
    df["std20"] = groups["close"].transform(lambda s: s.rolling(20).std())
    df["range_high20"] = groups["high"].transform(lambda s: s.rolling(20).max().shift(1))
    df["range_low20"] = groups["low"].transform(lambda s: s.rolling(20).min().shift(1))
    df["bb_width"] = 4.0 * df["std20"] / (df["mid20"] + 1e-12)
    df["bb_width_mean20"] = df.groupby("symbol", sort=False)["bb_width"].transform(lambda s: s.rolling(20).mean())
    df["bb_width_ratio"] = df["bb_width"] / (df["bb_width_mean20"] + 1e-12)
    df["range_position"] = (df["close"] - df["range_low20"]) / (
        df["range_high20"] - df["range_low20"] + 1e-12
    )
    df["distance_to_mid_atr"] = (df["close"] - df["mid20"]) / (df["atr_14"] + 1e-12)
    df["efficiency_ratio"] = groups["close"].transform(lambda s: s.diff(10).abs()) / (
        groups["close"].transform(lambda s: s.diff().abs().rolling(10).sum()) + 1e-12
    )
    candle_range = df["high"] - df["low"]
    df["upper_wick_pct"] = (
        df["high"] - df[["open", "close"]].max(axis=1)
    ) / (candle_range + 1e-12)
    df["lower_wick_pct"] = (
        df[["open", "close"]].min(axis=1) - df["low"]
    ) / (candle_range + 1e-12)
    df["is_jpy"] = df["symbol"].astype(str).str.contains("JPY").astype(float)
    return df


def barrier_label(group):
    close = group["close"].to_numpy()
    high = group["high"].to_numpy()
    low = group["low"].to_numpy()
    atr = group["atr_14"].to_numpy()
    buy = np.zeros(len(group), dtype=int)
    sell = np.zeros(len(group), dtype=int)

    for i in range(max(0, len(group) - LOOKAHEAD_BARS)):
        if not np.isfinite(atr[i]) or atr[i] <= 0:
            continue
        for side, target in (("buy", buy), ("sell", sell)):
            tp = TP_ATR * atr[i]
            sl = SL_ATR * atr[i]
            for j in range(1, LOOKAHEAD_BARS + 1):
                if side == "buy":
                    hit_tp = high[i + j] >= close[i] + tp
                    hit_sl = low[i + j] <= close[i] - sl
                else:
                    hit_tp = low[i + j] <= close[i] - tp
                    hit_sl = high[i + j] >= close[i] + sl
                if hit_tp and hit_sl:
                    break
                if hit_tp:
                    target[i] = 1
                    break
                if hit_sl:
                    break

    return pd.DataFrame({"target_buy": buy, "target_sell": sell}, index=group.index)


def regime_mask(df):
    ema_atr = df["ema_spread_20_50"].abs() / (df["atr_14"] + 1e-12)
    return (
        (df["adx_14"] < MAX_ADX)
        & (ema_atr < MAX_EMA_ATR)
        & (df["bb_width_ratio"] < MAX_BB_RATIO)
        & (df["efficiency_ratio"] < MAX_EFFICIENCY)
        & df["range_position"].between(0.0, 1.0)
    )


def metrics(y_true, prob, threshold=0.58):
    pred = (prob >= threshold).astype(int)
    return {
        "threshold": threshold,
        "accuracy": round(float(accuracy_score(y_true, pred)), 4),
        "precision": round(float(precision_score(y_true, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, pred, zero_division=0)), 4),
        "f05": round(float(fbeta_score(y_true, pred, beta=0.5, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(y_true, prob)), 4),
        "pr_auc": round(float(average_precision_score(y_true, prob)), 4),
        "brier": round(float(brier_score_loss(y_true, prob)), 4),
        "mcc": round(float(matthews_corrcoef(y_true, pred)), 4),
    }


def main():
    if not os.path.exists(DATA_PATH):
        print(json.dumps({"success": False, "error": f"Missing dataset: {DATA_PATH}"}))
        return 1

    df = pd.read_csv(DATA_PATH)
    df = add_range_features(df)
    labels = df.groupby("symbol", sort=False, group_keys=False).apply(
        barrier_label, include_groups=False
    )
    labels = labels.reset_index(level=0, drop=True)
    df = df.join(labels)
    clean = df[regime_mask(df)].dropna(subset=FEATURE_COLS + ["target_buy", "target_sell"]).copy()

    train_parts = []
    test_parts = []
    for _, group in clean.groupby("symbol", sort=False):
        split = int(len(group) * 0.80)
        train_parts.append(group.iloc[:split])
        test_parts.append(group.iloc[split:])
    train = pd.concat(train_parts, ignore_index=True)
    test = pd.concat(test_parts, ignore_index=True)

    params = {
        "n_estimators": 240,
        "max_depth": 8,
        "min_samples_leaf": 20,
        "class_weight": "balanced_subsample",
        "random_state": 42,
        "n_jobs": 1,
    }
    buy_model = RandomForestClassifier(**params)
    sell_model = RandomForestClassifier(**params)
    buy_model.fit(train[FEATURE_COLS], train["target_buy"])
    sell_model.fit(train[FEATURE_COLS], train["target_sell"])

    buy_prob = buy_model.predict_proba(test[FEATURE_COLS])[:, 1]
    sell_prob = sell_model.predict_proba(test[FEATURE_COLS])[:, 1]
    metric_data = {
        "buy": metrics(test["target_buy"].to_numpy(), buy_prob),
        "sell": metrics(test["target_sell"].to_numpy(), sell_prob),
    }

    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    trained_at = pd.Timestamp.now().isoformat()
    bundle = {
        "version": MODEL_VERSION,
        "model_source": "forex_range",
        "architecture": "Dual Random Forest Range Mean-Reversion Expert",
        "buy_model": buy_model,
        "sell_model": sell_model,
        "features": FEATURE_COLS,
        "parameters": params,
        "regime": {
            "max_adx": MAX_ADX,
            "max_ema_atr": MAX_EMA_ATR,
            "max_bb_width_ratio": MAX_BB_RATIO,
            "max_efficiency": MAX_EFFICIENCY,
            "lookahead_bars": LOOKAHEAD_BARS,
            "tp_atr": TP_ATR,
            "sl_atr": SL_ATR,
        },
        "metrics": metric_data,
        "dataset": {
            "eligible_samples": int(len(clean)),
            "train_samples": int(len(train)),
            "test_samples": int(len(test)),
            "positive_rate_buy": round(float(test["target_buy"].mean()), 4),
            "positive_rate_sell": round(float(test["target_sell"].mean()), 4),
        },
        "trained_at": trained_at,
    }
    archive_name = f"forex_range_model_{MODEL_VERSION}.joblib"
    joblib.dump(bundle, MODEL_PATH)
    joblib.dump(bundle, os.path.join(VERSIONS_DIR, archive_name))
    registry = {
        "active_version": MODEL_VERSION,
        "model_source": "forex_range",
        "created_at": trained_at,
        "artifact": "forex_range_model.joblib",
        "archive_artifact": f"versions/{archive_name}",
        "architecture": bundle["architecture"],
        "features": FEATURE_COLS,
        "regime": bundle["regime"],
        "dataset": bundle["dataset"],
        "metrics": metric_data,
    }
    with open(REGISTRY_PATH, "w", encoding="utf-8") as handle:
        json.dump(registry, handle, ensure_ascii=False, indent=2)

    print("=" * 75)
    print("Forex Range Mean-Reversion Expert trained")
    print(f"Version: {MODEL_VERSION} | eligible={len(clean)} train={len(train)} test={len(test)}")
    print(f"BUY  AUC={metric_data['buy']['roc_auc']:.4f} PR-AUC={metric_data['buy']['pr_auc']:.4f}")
    print(f"SELL AUC={metric_data['sell']['roc_auc']:.4f} PR-AUC={metric_data['sell']['pr_auc']:.4f}")
    print(f"Active artifact: {MODEL_PATH}")
    print(json.dumps({"success": True, "version": MODEL_VERSION, "metrics": metric_data}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
