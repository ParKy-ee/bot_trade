import os
import sys
import pandas as pd
import numpy as np
import joblib

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, "python", "models", "forex_challenger_model.joblib")
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_forex_m5.csv")

df = pd.read_csv(DATA_PATH)
bundle = joblib.load(MODEL_PATH)
buy_model = bundle['buy_model']
sell_model = bundle['sell_model']
feature_cols = bundle['features']

df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
if 'csm_spread' not in df.columns: df['csm_spread'] = 0.0
if 'h1_trend_slope' not in df.columns: df['h1_trend_slope'] = 0.0
if 'spread_to_atr' not in df.columns: df['spread_to_atr'] = 0.02
dt = pd.to_datetime(df['time'], errors='coerce')
hrs = dt.dt.hour + (dt.dt.minute / 60.0)
df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)

X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
df['raw_buy'] = buy_model.predict_proba(X)[:, 1]
df['raw_sell'] = sell_model.predict_proba(X)[:, 1]

for sym, g in df.groupby('symbol'):
    df.loc[g.index, 'fwd_5'] = g['close'].shift(-5) - g['close']

is_jpy = df['is_jpy'] == 1.0
pip_sz = np.where(is_jpy, 0.01, 0.0001)
spread = np.where(is_jpy, 1.6, 1.1)

buys = df[df['raw_buy'] >= 0.20].copy()
buys['pips'] = (buys['fwd_5'] / pip_sz[buys.index]) - spread[buys.index]
print("=== BUY by Symbol (raw_buy >= 0.20) ===")
for sym, g in buys.groupby('symbol'):
    wr = (g['pips'] > 0).mean() * 100
    print(f"  {sym:12}: count={len(g):4d}, win%={wr:5.1f}%, mean={g['pips'].mean():+5.2f}p, sum={g['pips'].sum():+7.1f}p")

sells = df[df['raw_sell'] >= 0.28].copy()
sells['pips'] = (-sells['fwd_5'] / pip_sz[sells.index]) - spread[sells.index]
print("\n=== SELL by Symbol (raw_sell >= 0.28) ===")
for sym, g in sells.groupby('symbol'):
    wr = (g['pips'] > 0).mean() * 100
    print(f"  {sym:12}: count={len(g):4d}, win%={wr:5.1f}%, mean={g['pips'].mean():+5.2f}p, sum={g['pips'].sum():+7.1f}p")
