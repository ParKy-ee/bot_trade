"""
Evaluate Market Pressure Engine on actual recorded trades in trade_results (1,228 trades).
Compares actual historical performance vs AI entry decisions assisted by Market Pressure.
"""

import os
import sys
import json
import joblib
import numpy as np
import pandas as pd

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, 'python', 'models', 'forex_market_pressure_v1.0.0.joblib')
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'trades_with_entry_bars.json')

def run_evaluation():
    print("=" * 80)
    print("📊 SCORECARD: AI ENTRY DECISIONS ASSISTED BY MARKET PRESSURE (1,228 TRADES)")
    print("=" * 80)

    model = joblib.load(MODEL_PATH)
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        records = json.load(f)

    print(f"Loaded {len(records):,} historical trades with entry bar history.")

    feature_matrix = []
    trade_list = []

    for item in records:
        t = item['trade']
        bars = item['bars']
        if len(bars) < 11:
            continue

        closes = np.array([float(b['close']) for b in bars])
        opens = np.array([float(b['open']) for b in bars])
        highs = np.array([float(b['high']) for b in bars])
        lows = np.array([float(b['low']) for b in bars])
        vols = np.array([float(b.get('volume', 1)) for b in bars])
        atrs = np.array([float(b.get('atr', 0.0010)) for b in bars])

        idx = -1
        c_close = closes[idx]
        c_open = opens[idx]
        c_high = highs[idx]
        c_low = lows[idx]
        c_atr = max(atrs[idx], 1e-5)
        c_range = max(c_high - c_low, 1e-5)
        c_body = abs(c_close - c_open)

        bop = float(np.clip((c_close - c_open) / c_range, -1.0, 1.0))
        body_ratio = float(np.clip(c_body / c_range, 0.0, 1.0))
        upper_wick = float(np.clip((c_high - max(c_close, c_open)) / c_range, 0.0, 1.0))
        lower_wick = float(np.clip((min(c_close, c_open) - c_low) / c_range, 0.0, 1.0))
        wick_asym = float(lower_wick - upper_wick)
        rel_range = float(np.clip(c_range / c_atr, 0.0, 5.0))

        net_3 = abs(closes[-1] - closes[-4])
        path_3 = sum(abs(closes[-i] - closes[-i-1]) for i in range(1, 4))
        ker_3 = float(np.clip(net_3 / max(path_3, 1e-5), 0.0, 1.0))

        net_5 = abs(closes[-1] - closes[-6])
        path_5 = sum(abs(closes[-i] - closes[-i-1]) for i in range(1, 6))
        ker_5 = float(np.clip(net_5 / max(path_5, 1e-5), 0.0, 1.0))

        net_10 = abs(closes[-1] - closes[-11])
        path_10 = sum(abs(closes[-i] - closes[-i-1]) for i in range(1, 11))
        ker_10 = float(np.clip(net_10 / max(path_10, 1e-5), 0.0, 1.0))

        dir_disp_3 = float(np.clip((closes[-1] - closes[-4]) / c_atr, -5.0, 5.0))
        dir_disp_5 = float(np.clip((closes[-1] - closes[-6]) / c_atr, -5.0, 5.0))

        mid_point = (c_high + c_low) / 2.0
        pos_in_range = float(np.clip((c_close - mid_point) / (c_range / 2.0), -1.0, 1.0))
        vol_skew = float(pos_in_range * np.log1p(max(vols[idx], 1.0)))

        features = [
            bop, body_ratio, upper_wick, lower_wick, wick_asym,
            rel_range, ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew
        ]

        feature_matrix.append(features)
        trade_list.append(t)

    X = np.array(feature_matrix)
    probs = model.predict_proba(X)

    df = pd.DataFrame(trade_list)
    df['p_indecision'] = probs[:, 0]
    df['p_buy'] = probs[:, 1]
    df['p_sell'] = probs[:, 2]
    df['pips'] = pd.to_numeric(df['pips'], errors='coerce').fillna(0)
    df['profit_loss'] = pd.to_numeric(df['profit_loss'], errors='coerce').fillna(0)
    df['is_win'] = pd.to_numeric(df['is_win'], errors='coerce').fillna(0)

    # Classification logic
    is_buy = df['action'] == 'BUY'
    is_sell = df['action'] == 'SELL'

    # Filter Conditions:
    # 1. Counter-Pressure (Hostile market: buying into sell push or selling into buy push)
    is_counter_pressure = (is_buy & (df['p_sell'] >= 0.38)) | (is_sell & (df['p_buy'] >= 0.38))

    # 2. Assisted Entry (Relaxed Guard + Market Pressure: Neutral/Indecision allowed, With-Pressure encouraged, Counter-Pressure blocked)
    is_pressure_approved = ~is_counter_pressure & (
        (is_buy & ((df['p_buy'] >= 0.32) | (df['p_indecision'] >= 0.35))) |
        (is_sell & ((df['p_sell'] >= 0.32) | (df['p_indecision'] >= 0.35)))
    )

    # 3. High-Conviction Pressure Only (p_align >= 0.40)
    is_high_conviction = (is_buy & (df['p_buy'] >= 0.40)) | (is_sell & (df['p_sell'] >= 0.40))

    def evaluate_group(name, subset):
        n = len(subset)
        if n == 0:
            return {"name": name, "trades": 0}
        wins = subset['is_win'].sum()
        wr = (wins / n) * 100
        total_pips = subset['pips'].sum()
        avg_pips = subset['pips'].mean()
        total_pnl = subset['profit_loss'].sum()
        
        gross_profit = subset[subset['profit_loss'] > 0]['profit_loss'].sum()
        gross_loss = abs(subset[subset['profit_loss'] < 0]['profit_loss'].sum())
        profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else 99.0
        
        # Expectancy Score (Score = WR% * Avg Pips * PF)
        score = (wr / 100.0) * avg_pips * profit_factor

        return {
            "name": name,
            "trades": n,
            "win_rate": wr,
            "total_pips": total_pips,
            "avg_pips": avg_pips,
            "total_pnl": total_pnl,
            "profit_factor": profit_factor,
            "score": score
        }

    res_actual = evaluate_group("A. Actual Bot Baseline (All 1,228 Trades)", df)
    res_counter = evaluate_group("B. Counter-Pressure Trades (Would be Vetoed)", df[is_counter_pressure])
    res_approved = evaluate_group("C. AI + Market Pressure Guard (Approved Trades)", df[is_pressure_approved])
    res_high_conv = evaluate_group("D. AI + High-Conviction Pressure Only", df[is_high_conviction])

    print("┌──────────────────────────────────────────────┬──────────┬──────────┬─────────────┬──────────┬──────────────┬──────────────┬──────────────┐")
    print("│ Evaluation Mode / Cohort                     │ Trades   │ Win Rate │ Total Pips  │ Avg Pips │ Total PnL ($)│ Profit Factor│ Quant Score  │")
    print("├──────────────────────────────────────────────┼──────────┼──────────┼─────────────┼──────────┼──────────────┼─────────────┼──────────────┤")
    for r in [res_actual, res_counter, res_approved, res_high_conv]:
        print(f"│ {r['name']:44s} │ {r['trades']:8d} │ {r['win_rate']:7.1f}% │ {r['total_pips']:10.1f}p │ {r['avg_pips']:7.2f}p │ ${r['total_pnl']:11.2f} │ {r['profit_factor']:12.2f} │ {r['score']:12.2f} │")
    print("└──────────────────────────────────────────────┴──────────┴──────────┴─────────────┴──────────┴──────────────┴──────────────┴──────────────┘")

    print("\n💡 KEY INSIGHTS & TAKEAWAYS:")
    pips_saved = abs(res_counter['total_pips']) if res_counter['total_pips'] < 0 else 0
    pnl_saved = abs(res_counter['total_pnl']) if res_counter['total_pnl'] < 0 else 0
    print(f"  1. By using Market Pressure to VETO Counter-Pressure trades:")
    print(f"     • We eliminate {res_counter['trades']} toxic trades that dragged down the system.")
    print(f"     • We save {pips_saved:+.1f} pips and +${pnl_saved:.2f} in losses!")
    print(f"     • Win Rate of the remaining approved trades jumps to {res_approved['win_rate']:.1f}% (Avg {res_approved['avg_pips']:+.2f} pips).")
    print(f"  2. In High-Conviction Pressure mode:")
    print(f"     • Win Rate reaches {res_high_conv['win_rate']:.1f}% with Profit Factor of {res_high_conv['profit_factor']:.2f} and Quant Score of {res_high_conv['score']:.2f}!")

if __name__ == '__main__':
    run_evaluation()
