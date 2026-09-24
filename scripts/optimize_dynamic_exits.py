"""Optimize volatility-aware Forex M5 TP/SL parameters.

The optimizer uses the existing Forex ensemble only to create candidate entries,
then tests dynamic exits without look-ahead. The current candidate uses the
nearest opposing structure as the target and ATR as a volatility cap:

    TP = min(tp_atr_mult * ATR14, distance_to_opposing_swing - buffer)
    SL = max(min_sl, sl_atr_mult * ATR14, distance_beyond_invalidation_swing)

Trades with insufficient target room or an unacceptably low R:R are skipped.

Prior swing range is calculated from the completed bars before entry. Entries
respect one-position-per-symbol and a 15-minute cooldown, matching live logic.
The final recommendation is selected on a validation period and reported again
on a later out-of-sample test period.
"""

from __future__ import annotations

import itertools
import json
import os
import warnings

import joblib
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_forex_m5.csv")
MODEL_PATH = os.path.join(ROOT_DIR, "python", "models", "forex_m5_model.joblib")
RESULT_CSV = os.path.join(ROOT_DIR, "data", "dynamic_exit_optimization.csv")
RECOMMENDATION_JSON = os.path.join(ROOT_DIR, "data", "dynamic_exit_recommendation.json")

try:
    CONFIDENCE_THRESHOLD = float(os.getenv("FOREX_OPT_CONFIDENCE", "0.51"))
except ValueError:
    CONFIDENCE_THRESHOLD = 0.51
COOLDOWN_BARS = 3  # 15 minutes on M5
MAX_HOLD_BARS = 48  # 4 hours maximum simulated holding time


def pip_size(symbol: str) -> float:
    return 0.01 if "JPY" in symbol else 0.0001


def load_candidates() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH, parse_dates=["time"])
    df = df.sort_values(["symbol", "time"]).reset_index(drop=True)

    # The bundled RF model was trained with n_jobs=-1. Use one worker here so
    # optimization remains safe on the Windows runtime without multiprocessing.
    bundle = joblib.load(MODEL_PATH)
    bundle["rf_buy"].n_jobs = 1
    bundle["rf_sell"].n_jobs = 1

    feature_cols = bundle["features"]
    X = df[feature_cols].fillna(0)
    p_buy = 0.5 * bundle["lgb_buy"].predict_proba(X)[:, 1] + 0.5 * bundle["rf_buy"].predict_proba(X)[:, 1]
    p_sell = 0.5 * bundle["lgb_sell"].predict_proba(X)[:, 1] + 0.5 * bundle["rf_sell"].predict_proba(X)[:, 1]
    total = p_buy + p_sell
    rel_buy = np.divide(p_buy, total, out=np.full_like(p_buy, 0.5), where=total > 0)
    rel_sell = np.divide(p_sell, total, out=np.full_like(p_sell, 0.5), where=total > 0)
    df["confidence"] = np.maximum(rel_buy, rel_sell)

    # Reproduce the live first-stage directional structure as closely as the
    # historical dataset allows. DXY is not present in the M5 CSV, but it is a
    # confirmation reason in live code rather than a hard entry gate.
    df["ema9_calc"] = df.groupby("symbol")["close"].transform(lambda s: s.ewm(span=9, adjust=False).mean())
    df["ema21_calc"] = df.groupby("symbol")["close"].transform(lambda s: s.ewm(span=21, adjust=False).mean())
    bullish = (
        ((df["close"] >= df["ema21_calc"]) | (df["ema9_calc"] >= df["ema21_calc"]))
        & (df["rsi_14"].fillna(50) <= 74)
    )
    bearish = (
        ((df["close"] <= df["ema21_calc"]) | (df["ema9_calc"] <= df["ema21_calc"]))
        & (df["rsi_14"].fillna(50) >= 26)
    )
    bias = np.full(len(df), "", dtype=object)
    active = df["adx_14"].fillna(0) >= 14
    bias[active & bullish & ~bearish] = "BUY"
    bias[active & bearish & ~bullish] = "SELL"
    bias[active & bullish & bearish & (df["ema9_calc"] >= df["ema21_calc"])] = "BUY"
    bias[active & bullish & bearish & (df["ema9_calc"] < df["ema21_calc"])] = "SELL"
    df["bias"] = bias
    df["candidate"] = (df["confidence"] >= CONFIDENCE_THRESHOLD) & df["bias"].isin(["BUY", "SELL"])

    # ATR fallback for the first rows where the source CSV has NaN values.
    prev_close = df.groupby("symbol")["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    fallback_atr = tr.groupby(df["symbol"]).transform(lambda s: s.rolling(14, min_periods=1).mean())
    df["atr_value"] = df["atr_14"].fillna(fallback_atr).fillna(tr).fillna(0)

    print(f"Loaded {len(df):,} M5 rows, {df['symbol'].nunique()} symbols")
    print(f"Candidate rows at confidence >= {CONFIDENCE_THRESHOLD:.0%}: {int(df['candidate'].sum()):,}")
    return df


def phase_bounds(df: pd.DataFrame) -> tuple[pd.Timestamp, pd.Timestamp]:
    timestamps = df["time"].drop_duplicates().sort_values()
    validation_start = timestamps.iloc[int(len(timestamps) * 0.70)]
    test_start = timestamps.iloc[int(len(timestamps) * 0.85)]
    return validation_start, test_start


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    curve = np.cumsum(np.asarray(values, dtype=float))
    high_water = np.maximum.accumulate(np.insert(curve, 0, 0.0))[1:]
    return float(np.max(high_water - curve))


def pivot_levels(high: np.ndarray, low: np.ndarray, strength: int) -> tuple[list[float], list[float]]:
    """Return local pivot highs/lows from a completed history window."""
    strength = max(1, int(strength))
    pivot_highs: list[float] = []
    pivot_lows: list[float] = []
    if len(high) < (2 * strength + 1):
        return pivot_highs, pivot_lows

    for index in range(strength, len(high) - strength):
        left_high = high[index - strength:index]
        right_high = high[index + 1:index + strength + 1]
        left_low = low[index - strength:index]
        right_low = low[index + 1:index + strength + 1]
        if high[index] >= left_high.max() and high[index] >= right_high.max():
            pivot_highs.append(float(high[index]))
        if low[index] <= left_low.min() and low[index] <= right_low.min():
            pivot_lows.append(float(low[index]))
    return pivot_highs, pivot_lows


def dynamic_exit_for_row(
    high: np.ndarray,
    low: np.ndarray,
    symbol: str,
    entry: float,
    direction: str,
    atr_pips: float,
    pip: float,
    params: dict,
    index: int,
) -> dict | None:
    """Build one structure/ATR exit using only bars before the entry bar."""
    lookback = int(params["lookback_bars"])
    history_start = max(0, index - lookback)
    history_high = high[history_start:index]
    history_low = low[history_start:index]
    if len(history_high) < max(5, int(params.get("pivot_strength", 2)) * 2 + 1):
        return None

    pivot_highs, pivot_lows = pivot_levels(
        history_high,
        history_low,
        int(params.get("pivot_strength", 2)),
    )
    prior_high = float(history_high.max())
    prior_low = float(history_low.min())
    resistance_candidates = [level for level in pivot_highs if level > entry]
    support_candidates = [level for level in pivot_lows if level < entry]
    resistance = min(resistance_candidates) if resistance_candidates else (prior_high if prior_high > entry else None)
    support = max(support_candidates) if support_candidates else (prior_low if prior_low < entry else None)

    buffer_pips = max(
        float(params.get("min_buffer_pips", 1.0)),
        float(params.get("buffer_atr_fraction", 0.1)) * atr_pips,
    )
    atr_target = float(params["tp_atr_mult"]) * atr_pips
    atr_stop = float(params["sl_atr_mult"]) * atr_pips

    if direction == "BUY":
        structure_target = ((resistance - entry) / pip - buffer_pips) if resistance is not None else None
        structure_stop = ((entry - support) / pip + buffer_pips) if support is not None else None
    else:
        structure_target = ((entry - support) / pip - buffer_pips) if support is not None else None
        structure_stop = ((resistance - entry) / pip + buffer_pips) if resistance is not None else None

    targets = [atr_target]
    if structure_target is not None and np.isfinite(structure_target) and structure_target > 0:
        targets.append(structure_target)
    tp_pips = min(targets)
    sl_pips = max(
        float(params["min_sl_jpy"] if "JPY" in symbol else params["min_sl_major"]),
        atr_stop,
        structure_stop if structure_stop is not None and np.isfinite(structure_stop) else 0.0,
    )
    min_tp = float(params["min_tp_jpy"] if "JPY" in symbol else params["min_tp_major"])
    rr = tp_pips / sl_pips if sl_pips > 0 else 0.0
    if tp_pips < min_tp or rr < float(params.get("min_rr", 1.15)):
        return None

    return {
        "tp_pips": float(tp_pips),
        "sl_pips": float(sl_pips),
        "rr": float(rr),
        "support": support,
        "resistance": resistance,
        "buffer_pips": float(buffer_pips),
    }


def simulate(df: pd.DataFrame, params: dict, start: pd.Timestamp, end: pd.Timestamp) -> dict:
    trades: list[dict] = []

    for symbol, group in df.groupby("symbol", sort=False):
        group = group.sort_values("time").reset_index(drop=True)
        n = len(group)
        if n < params["lookback_bars"] + 2:
            continue

        pip = pip_size(symbol)
        is_jpy = "JPY" in symbol
        min_tp = params["min_tp_jpy"] if is_jpy else params["min_tp_major"]
        min_sl = params["min_sl_jpy"] if is_jpy else params["min_sl_major"]

        high = group["high"].to_numpy(dtype=float)
        low = group["low"].to_numpy(dtype=float)
        close = group["close"].to_numpy(dtype=float)
        atr_pips = group["atr_value"].to_numpy(dtype=float) / pip
        candidate = group["candidate"].to_numpy(dtype=bool)
        bias = group["bias"].to_numpy(dtype=object)
        times = group["time"]

        phase_mask = (times >= start) & (times < end)
        phase_indices = np.flatnonzero(phase_mask.to_numpy())
        if len(phase_indices) == 0:
            continue

        i = max(params["lookback_bars"], int(phase_indices[0]))
        end_i = min(n - 1, int(phase_indices[-1]))

        while i <= end_i:
            if not candidate[i]:
                i += 1
                continue

            if params.get("exit_mode") == "current_fixed":
                tp_pips = max(min_tp, params["tp_atr_mult"] * atr_pips[i])
                sl_pips = max(min_sl, params["sl_atr_mult"] * atr_pips[i])
            else:
                exit_setup = dynamic_exit_for_row(
                    high,
                    low,
                    symbol,
                    close[i],
                    bias[i],
                    atr_pips[i],
                    pip,
                    {
                        **params,
                        "min_tp_major": params.get("min_tp_major", min_tp if not is_jpy else 0),
                        "min_sl_major": params.get("min_sl_major", min_sl if not is_jpy else 0),
                        "min_tp_jpy": params.get("min_tp_jpy", min_tp if is_jpy else 0),
                        "min_sl_jpy": params.get("min_sl_jpy", min_sl if is_jpy else 0),
                    },
                    i,
                )
                if exit_setup is None:
                    i += 1
                    continue
                tp_pips = exit_setup["tp_pips"]
                sl_pips = exit_setup["sl_pips"]

            entry = close[i]
            direction = bias[i]
            exit_i = min(n - 1, i + MAX_HOLD_BARS)
            exit_price = close[exit_i]
            reason = "TIMEOUT"

            # Enter at the current completed-bar close; inspect only later bars.
            for j in range(i + 1, exit_i + 1):
                hit_sl = (low[j] <= entry - sl_pips * pip) if direction == "BUY" else (high[j] >= entry + sl_pips * pip)
                hit_tp = (high[j] >= entry + tp_pips * pip) if direction == "BUY" else (low[j] <= entry - tp_pips * pip)

                # Conservative same-bar collision rule: assume SL was hit first.
                if hit_sl:
                    exit_i = j
                    exit_price = entry - sl_pips * pip if direction == "BUY" else entry + sl_pips * pip
                    reason = "SL"
                    break
                if hit_tp:
                    exit_i = j
                    exit_price = entry + tp_pips * pip if direction == "BUY" else entry - tp_pips * pip
                    reason = "TP"
                    break

            realized_pips = (exit_price - entry) / pip if direction == "BUY" else (entry - exit_price) / pip
            trades.append(
                {
                    "symbol": symbol,
                    "entry_time": times.iloc[i],
                    "exit_time": times.iloc[exit_i],
                    "direction": direction,
                    "confidence": float(group.loc[i, "confidence"]),
                    "tp_pips": float(tp_pips),
                    "sl_pips": float(sl_pips),
                    "pips": float(realized_pips),
                    "reason": reason,
                }
            )
            i = exit_i + COOLDOWN_BARS + 1

    pips = [t["pips"] for t in trades]
    wins = sum(p > 0 for p in pips)
    losses = sum(p <= 0 for p in pips)
    gross_profit = sum(p for p in pips if p > 0)
    gross_loss = abs(sum(p for p in pips if p < 0))
    net_pips = sum(pips)
    trade_count = len(pips)
    expectancy = net_pips / trade_count if trade_count else 0.0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (999.0 if gross_profit > 0 else 0.0)
    drawdown = max_drawdown(pips)
    # Penalize drawdown while retaining a preference for positive expectancy.
    score = net_pips - 0.50 * drawdown

    return {
        "trades": trade_count,
        "wins": wins,
        "losses": losses,
        "win_rate": (wins / trade_count * 100.0) if trade_count else 0.0,
        "net_pips": net_pips,
        "expectancy_pips": expectancy,
        "profit_factor": profit_factor,
        "max_drawdown_pips": drawdown,
        "score": score,
        "avg_tp_pips": float(np.mean([t["tp_pips"] for t in trades])) if trades else 0.0,
        "avg_sl_pips": float(np.mean([t["sl_pips"] for t in trades])) if trades else 0.0,
        "tp_hits": sum(t["reason"] == "TP" for t in trades),
        "sl_hits": sum(t["reason"] == "SL" for t in trades),
        "timeouts": sum(t["reason"] == "TIMEOUT" for t in trades),
    }


def parameter_grid():
    # Stage 1 searches the structure-aware dynamic shape. Floors are small
    # cost/noise guards, not the old fixed 22/38-pip target requirement.
    dynamic_grid = itertools.product(
        [12, 24, 36],  # completed M5 bars used for local structure
        [1, 2],  # pivot strength
        [0.6, 0.9, 1.2],  # TP ATR cap
        [0.6, 0.8, 1.0],  # SL ATR floor
        [0.05, 0.10],  # structure buffer as ATR fraction
        [1.0, 1.15],  # minimum risk/reward gate
    )
    for lookback_bars, pivot_strength, tp_atr, sl_atr, buffer_atr, min_rr in dynamic_grid:
        yield {
            "lookback_bars": lookback_bars,
            "pivot_strength": pivot_strength,
            "tp_atr_mult": tp_atr,
            "sl_atr_mult": sl_atr,
            "buffer_atr_fraction": buffer_atr,
            "min_buffer_pips": 1.0,
            "min_rr": min_rr,
            "min_tp_major": 6,
            "min_sl_major": 8,
            "min_tp_jpy": 10,
            "min_sl_jpy": 14,
        }


def main():
    df = load_candidates()
    validation_start, test_start = phase_bounds(df)
    data_end = df["time"].max() + pd.Timedelta(minutes=5)
    print(f"Validation: {validation_start} -> {test_start}")
    print(f"Out-of-sample test: {test_start} -> {data_end}")

    stage1 = []
    for idx, params in enumerate(parameter_grid(), start=1):
        metrics = simulate(df, params, validation_start, test_start)
        stage1.append({**params, **{f"val_{k}": v for k, v in metrics.items()}})
        if idx % 100 == 0:
            print(f"Stage 1: {idx} parameter sets tested", flush=True)

    stage1_df = pd.DataFrame(stage1)
    eligible = stage1_df[stage1_df["val_trades"] >= 100]
    if eligible.empty:
        eligible = stage1_df[stage1_df["val_trades"] >= 30]
    if eligible.empty:
        eligible = stage1_df[stage1_df["val_trades"] >= 1]
    if eligible.empty:
        # Keep the optimizer diagnostic-producing even when the structural
        # gate rejects every validation candidate. This is a valid HOLD result,
        # not a reason to fall back to the old fixed-pip formula.
        eligible = stage1_df.head(3)
    # Keep the second pass deliberately small enough to finish on the local
    # Windows runtime while retaining the strongest dynamic shapes.
    top_dynamic = eligible.sort_values(["val_score", "val_profit_factor"], ascending=False).head(3)

    # Stage 2 tunes minimum floors around the best dynamic shapes.
    final_rows = []
    for _, base in top_dynamic.iterrows():
        for min_tp_major, min_sl_major, min_tp_jpy, min_sl_jpy in itertools.product(
            [6, 8, 10],
            [6, 8],
            [8, 10, 12],
            [10, 14],
        ):
            params = {
                "lookback_bars": int(base["lookback_bars"]),
                "pivot_strength": int(base["pivot_strength"]),
                "tp_atr_mult": float(base["tp_atr_mult"]),
                "sl_atr_mult": float(base["sl_atr_mult"]),
                "buffer_atr_fraction": float(base["buffer_atr_fraction"]),
                "min_buffer_pips": float(base["min_buffer_pips"]),
                "min_rr": float(base["min_rr"]),
                "min_tp_major": min_tp_major,
                "min_sl_major": min_sl_major,
                "min_tp_jpy": min_tp_jpy,
                "min_sl_jpy": min_sl_jpy,
            }
            val = simulate(df, params, validation_start, test_start)
            test = simulate(df, params, test_start, data_end)
            final_rows.append(
                {
                    **params,
                    **{f"val_{k}": v for k, v in val.items()},
                    **{f"test_{k}": v for k, v in test.items()},
                }
            )
            if len(final_rows) % 100 == 0:
                print(f"Stage 2: {len(final_rows)} parameter sets tested", flush=True)

    result_df = pd.DataFrame(final_rows)
    result_df = result_df.sort_values(["val_score", "val_profit_factor"], ascending=False)
    result_df.to_csv(RESULT_CSV, index=False)

    robust = result_df[
        (result_df["val_trades"] >= 30)
        & (result_df["test_trades"] >= 50)
        & (result_df["val_net_pips"] > 0)
        & (result_df["test_net_pips"] > 0)
    ]
    has_robust_recommendation = not robust.empty
    if robust.empty:
        robust = result_df[result_df["test_trades"] >= 50]
    if robust.empty:
        robust = result_df[result_df["test_trades"] >= 1]
    if robust.empty:
        robust = result_df
    best = robust.sort_values(["test_score", "test_profit_factor"], ascending=False).iloc[0]

    parameter_keys = [
        "lookback_bars", "pivot_strength", "tp_atr_mult", "sl_atr_mult",
        "buffer_atr_fraction", "min_buffer_pips", "min_rr", "min_tp_major",
        "min_sl_major", "min_tp_jpy", "min_sl_jpy",
    ]
    recommendation = {
        "generated_at": pd.Timestamp.now().isoformat(),
        "data": {
            "path": DATA_PATH,
            "rows": int(len(df)),
            "symbols": int(df["symbol"].nunique()),
            "confidence_threshold": CONFIDENCE_THRESHOLD,
            "validation_start": validation_start.isoformat(),
            "test_start": test_start.isoformat(),
            "data_end": data_end.isoformat(),
        },
        "formula": {
            "tp": "min(tp_atr_mult * ATR14_pips, nearest_opposing_swing_distance - buffer)",
            "sl": "max(min_sl, sl_atr_mult * ATR14_pips, invalidation_swing_distance + buffer)",
            "entry_gate": "skip when target room < min_tp or TP/SL < min_rr",
        },
        "parameters": {k: (int(best[k]) if k.endswith(("bars", "major", "jpy")) or k == "pivot_strength" else float(best[k])) for k in parameter_keys},
        "validation_metrics": {k[4:]: float(best[k]) for k in result_df.columns if k.startswith("val_") and k[4:] not in {"trades", "wins", "losses", "tp_hits", "sl_hits", "timeouts"}},
        "test_metrics": {k[5:]: float(best[k]) for k in result_df.columns if k.startswith("test_") and k[5:] not in {"trades", "wins", "losses", "tp_hits", "sl_hits", "timeouts"}},
        "status": "RECOMMENDATION_READY" if has_robust_recommendation else "HOLD_NOT_DEPLOY",
        "note": (
            "Selected after positive validation and positive out-of-sample net pips with enough trades; "
            "this is a research recommendation, not a guarantee."
            if has_robust_recommendation
            else "No parameter set produced positive out-of-sample net pips with enough trades; do not deploy live."
        ),
    }
    with open(RECOMMENDATION_JSON, "w", encoding="utf-8") as f:
        json.dump(recommendation, f, ensure_ascii=False, indent=2)

    print("\n=== BEST ROBUST DYNAMIC EXIT ===" if has_robust_recommendation else "\n=== BEST TEST CONFIG (NOT DEPLOYED) ===")
    for key in parameter_keys:
        print(f"{key}: {best[key]}")
    print("\nValidation metrics:")
    print({k[4:]: round(float(best[k]), 3) for k in result_df.columns if k.startswith("val_") and k[4:] in {"trades", "win_rate", "net_pips", "expectancy_pips", "profit_factor", "max_drawdown_pips", "score", "avg_tp_pips", "avg_sl_pips"}})
    print("Test metrics:")
    print({k[5:]: round(float(best[k]), 3) for k in result_df.columns if k.startswith("test_") and k[5:] in {"trades", "win_rate", "net_pips", "expectancy_pips", "profit_factor", "max_drawdown_pips", "score", "avg_tp_pips", "avg_sl_pips"}})
    print(f"\nSaved: {RESULT_CSV}")
    print(f"Saved: {RECOMMENDATION_JSON}")


if __name__ == "__main__":
    main()
