"""
Test Market Pressure & Indecision Model on Real Historical Trades
Checks the Win Rate and Average PnL when trades aligned with Pressure vs Counter-Pressure vs Indecision.
"""

import os
import sys
import json
import joblib
import numpy as np
import pandas as pd
from datetime import datetime

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, 'python', 'models', 'forex_market_pressure_v1.0.0.joblib')
BARS_PATH = os.path.join(ROOT_DIR, 'data', 'market_pressure_bars.json')

def run_test():
    print("=== BACKTESTING MARKET PRESSURE MODEL ON REAL HISTORICAL BARS ===")
    model = joblib.load(MODEL_PATH)
    
    with open(BARS_PATH, 'r', encoding='utf-8') as f:
        bars = json.load(f)
    df = pd.DataFrame(bars)
    
    for c in ['open', 'high', 'low', 'close', 'volume', 'rsi', 'atr']:
        df[c] = pd.to_numeric(df[c], errors='coerce')
        
    dfs = []
    for sym, g in df.groupby('symbol'):
        g = g.sort_values('time').reset_index(drop=True).copy()
        
        atr = g['atr'].replace(0, np.nan).bfill().ffill().replace(0, 1e-5)
        c_range = (g['high'] - g['low']).replace(0, 1e-5)
        close = g['close']
        open_p = g['open']
        
        g['bop'] = ((close - open_p) / c_range).clip(-1, 1)
        g['body_ratio'] = ((close - open_p).abs() / c_range).clip(0, 1)
        g['upper_wick'] = ((g['high'] - np.maximum(close, open_p)) / c_range).clip(0, 1)
        g['lower_wick'] = ((np.minimum(close, open_p) - g['low']) / c_range).clip(0, 1)
        g['wick_asym'] = g['lower_wick'] - g['upper_wick']
        g['rel_range'] = (c_range / atr).clip(0, 5)
        
        step = (close - close.shift(1)).abs()
        g['ker_3'] = ((close - close.shift(3)).abs() / step.rolling(3).sum().replace(0, 1e-5)).clip(0, 1)
        g['ker_5'] = ((close - close.shift(5)).abs() / step.rolling(5).sum().replace(0, 1e-5)).clip(0, 1)
        g['ker_10'] = ((close - close.shift(10)).abs() / step.rolling(10).sum().replace(0, 1e-5)).clip(0, 1)
        
        g['dir_disp_3'] = ((close - close.shift(3)) / atr).clip(-5, 5)
        g['dir_disp_5'] = ((close - close.shift(5)) / atr).clip(-5, 5)
        
        mid_point = (g['high'] + g['low']) / 2.0
        pos_in_range = ((close - mid_point) / (c_range / 2.0)).clip(-1, 1)
        vol_safe = g['volume'].replace(0, 1).clip(lower=1)
        g['vol_skew'] = pos_in_range * np.log1p(vol_safe)
        
        # Future 3-bar and 6-bar return in pips (Major=10000, JPY=100)
        mult = 100.0 if 'JPY' in str(sym) else 10000.0
        g['fwd_pips_3'] = (close.shift(-3) - close) * mult
        g['fwd_pips_6'] = (close.shift(-6) - close) * mult
        
        dfs.append(g.iloc[10:-6])
        
    full = pd.concat(dfs, ignore_index=True).dropna()
    
    feature_cols = [
        'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
        'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
    ]
    
    X = full[feature_cols].values
    probs = model.predict_proba(X)
    
    full['p_indecision'] = probs[:, 0]
    full['p_buy'] = probs[:, 1]
    full['p_sell'] = probs[:, 2]
    
    # Analyze simulated BUY entries
    print("\n--- SIMULATION 1: BUY TRADES FORWARD PERFORMANCE ---")
    buy_conviction = full[full['p_buy'] >= 0.42]
    buy_indecision = full[(full['p_indecision'] >= 0.40) & (full['p_buy'] < 0.42) & (full['p_sell'] < 0.42)]
    buy_counter = full[full['p_sell'] >= 0.42]
    
    print(f"1. Entering BUY during High BUY_PRESSURE (Count: {len(buy_conviction):,}):")
    print(f"   • Avg 3-Bar Pips: {buy_conviction['fwd_pips_3'].mean():+.2f} pips | Win Rate (>0 pips): {(buy_conviction['fwd_pips_3'] > 0).mean()*100:.1f}%")
    print(f"   • Avg 6-Bar Pips: {buy_conviction['fwd_pips_6'].mean():+.2f} pips | Win Rate (>0 pips): {(buy_conviction['fwd_pips_6'] > 0).mean()*100:.1f}%")
    
    print(f"\n2. Entering BUY during INDECISION / CHOP (Count: {len(buy_indecision):,}):")
    print(f"   • Avg 3-Bar Pips: {buy_indecision['fwd_pips_3'].mean():+.2f} pips | Win Rate (>0 pips): {(buy_indecision['fwd_pips_3'] > 0).mean()*100:.1f}%")
    print(f"   • Avg 6-Bar Pips: {buy_indecision['fwd_pips_6'].mean():+.2f} pips | Win Rate (>0 pips): {(buy_indecision['fwd_pips_6'] > 0).mean()*100:.1f}%")

    print(f"\n3. Entering BUY during Counter SELL_PRESSURE (Count: {len(buy_counter):,}):")
    print(f"   • Avg 3-Bar Pips: {buy_counter['fwd_pips_3'].mean():+.2f} pips | Win Rate (>0 pips): {(buy_counter['fwd_pips_3'] > 0).mean()*100:.1f}%")
    print(f"   • Avg 6-Bar Pips: {buy_counter['fwd_pips_6'].mean():+.2f} pips | Win Rate (>0 pips): {(buy_counter['fwd_pips_6'] > 0).mean()*100:.1f}%")

    # Analyze simulated SELL entries
    print("\n--- SIMULATION 2: SELL TRADES FORWARD PERFORMANCE ---")
    sell_conviction = full[full['p_sell'] >= 0.42]
    sell_fwd_3 = -sell_conviction['fwd_pips_3']
    sell_fwd_6 = -sell_conviction['fwd_pips_6']
    
    counter_fwd_3 = -buy_conviction['fwd_pips_3']
    counter_fwd_6 = -buy_conviction['fwd_pips_6']

    print(f"1. Entering SELL during High SELL_PRESSURE (Count: {len(sell_conviction):,}):")
    print(f"   • Avg 3-Bar Pips: {sell_fwd_3.mean():+.2f} pips | Win Rate: {(sell_fwd_3 > 0).mean()*100:.1f}%")
    print(f"   • Avg 6-Bar Pips: {sell_fwd_6.mean():+.2f} pips | Win Rate: {(sell_fwd_6 > 0).mean()*100:.1f}%")

    print(f"\n2. Entering SELL during Counter BUY_PRESSURE (Count: {len(buy_conviction):,}):")
    print(f"   • Avg 3-Bar Pips: {counter_fwd_3.mean():+.2f} pips | Win Rate: {(counter_fwd_3 > 0).mean()*100:.1f}%")
    print(f"   • Avg 6-Bar Pips: {counter_fwd_6.mean():+.2f} pips | Win Rate: {(counter_fwd_6 > 0).mean()*100:.1f}%")

if __name__ == '__main__':
    run_test()
