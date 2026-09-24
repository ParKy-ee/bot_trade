"""Compare current exits and dynamic exits across confidence thresholds.

This is a diagnostic companion to optimize_dynamic_exits.py. It does not send
orders; it reuses the same candidate-entry approximation and conservative M5
simulation to identify whether the weakness is entry quality or exit sizing.
"""

from __future__ import annotations

import json
import os

import pandas as pd

from optimize_dynamic_exits import (
    DATA_PATH,
    load_candidates,
    phase_bounds,
    simulate,
)


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECOMMENDATION_PATH = os.path.join(ROOT_DIR, "data", "dynamic_exit_recommendation.json")
RESULT_PATH = os.path.join(ROOT_DIR, "data", "entry_threshold_evaluation.csv")


def config_from_json() -> dict:
    with open(RECOMMENDATION_PATH, "r", encoding="utf-8") as handle:
        recommendation = json.load(handle)
    params = recommendation["parameters"].copy()
    if "lookback_bars" not in params:
        params["lookback_bars"] = int(params.get("lookback_hours", 2) * 12)
    return params


df = load_candidates()
VALIDATION_START, TEST_START = phase_bounds(df)
DATA_END = df["time"].max() + pd.Timedelta(minutes=5)
dynamic = config_from_json()
current = {
    "exit_mode": "current_fixed",
    "lookback_bars": 60,
    "pivot_strength": 2,
    "tp_atr_mult": 3.3,
    "sl_atr_mult": 2.2,
    "buffer_atr_fraction": 0.0,
    "min_buffer_pips": 0.0,
    "min_rr": 0.0,
    "min_tp_major": 22,
    "min_sl_major": 14,
    "min_tp_jpy": 38,
    "min_sl_jpy": 24,
}

rows = []
for threshold in (0.51, 0.55, 0.60, 0.65, 0.68, 0.70, 0.75, 0.80):
    for label, params in (("current_fixed", current), ("dynamic_candidate", dynamic)):
        for phase_start, phase_end in ((VALIDATION_START, TEST_START), (TEST_START, DATA_END)):
            phase = "validation" if phase_end == TEST_START else "test"
            df["candidate"] = (df["confidence"] >= threshold) & df["bias"].isin(["BUY", "SELL"])
            metrics = simulate(df, params, phase_start, phase_end)
            rows.append({
                "exit_config": label,
                "confidence_threshold": threshold,
                "phase": phase,
                **metrics,
            })

result = pd.DataFrame(rows)
result.to_csv(RESULT_PATH, index=False)
print(result[
    ["exit_config", "confidence_threshold", "phase", "trades", "win_rate", "net_pips", "expectancy_pips", "profit_factor", "max_drawdown_pips", "tp_hits", "sl_hits", "timeouts"]
].to_string(index=False))
print(f"Saved: {RESULT_PATH}")
