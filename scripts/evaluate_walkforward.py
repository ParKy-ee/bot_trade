"""Walk-forward check for the dynamic exit candidate.

The confidence threshold is selected only by looking at repeated chronological
folds, not by placing orders. This provides a sanity check against choosing a
single lucky holdout window.
"""

from __future__ import annotations

import json
import os

import pandas as pd

from optimize_dynamic_exits import load_candidates, simulate


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECOMMENDATION_PATH = os.path.join(ROOT_DIR, "data", "dynamic_exit_recommendation.json")
RESULT_PATH = os.path.join(ROOT_DIR, "data", "walkforward_evaluation.csv")


with open(RECOMMENDATION_PATH, "r", encoding="utf-8") as handle:
    dynamic = json.load(handle)["parameters"]
if "lookback_bars" not in dynamic:
    dynamic["lookback_bars"] = int(dynamic.get("lookback_hours", 2) * 12)

df = load_candidates()
timestamps = df["time"].drop_duplicates().sort_values().reset_index(drop=True)
folds = []
for fold in range(5):
    start_idx = int(len(timestamps) * fold / 5)
    end_idx = int(len(timestamps) * (fold + 1) / 5)
    start = timestamps.iloc[start_idx]
    end = timestamps.iloc[end_idx] if end_idx < len(timestamps) else timestamps.iloc[-1] + pd.Timedelta(minutes=5)
    folds.append((fold + 1, start, end))

rows = []
for threshold in (0.60, 0.65, 0.68, 0.70, 0.75):
    df["candidate"] = (df["confidence"] >= threshold) & df["bias"].isin(["BUY", "SELL"])
    for fold, start, end in folds:
        metrics = simulate(df, dynamic, start, end)
        rows.append({
            "threshold": threshold,
            "fold": fold,
            "start": start,
            "end": end,
            **metrics,
        })

result = pd.DataFrame(rows)
result.to_csv(RESULT_PATH, index=False)
summary = result.groupby("threshold", as_index=False).agg(
    folds=("fold", "count"),
    trades=("trades", "sum"),
    wins=("wins", "sum"),
    losses=("losses", "sum"),
    net_pips=("net_pips", "sum"),
    avg_expectancy=("expectancy_pips", "mean"),
    worst_fold_net=("net_pips", "min"),
    best_fold_net=("net_pips", "max"),
)
summary["win_rate"] = summary["wins"] / summary["trades"] * 100
print(summary.to_string(index=False))
print("\nFold detail:")
print(result[["threshold", "fold", "trades", "win_rate", "net_pips", "expectancy_pips", "profit_factor"]].to_string(index=False))
print(f"\nSaved: {RESULT_PATH}")
