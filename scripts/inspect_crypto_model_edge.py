import os
import sys
import pandas as pd
import numpy as np
import joblib

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, "python", "models", "crypto_m5_model.joblib")
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_crypto_m5.csv")

print("📂 Loading Crypto M5 dataset...")
df = pd.read_csv(DATA_PATH)
print(f"Loaded {len(df):,} bars across symbols: {df['symbol'].unique().tolist()}")

print("🤖 Loading Crypto Tri-Ensemble Model...")
bundle = joblib.load(MODEL_PATH)
lgb_buy = bundle.get("lgb_buy")
xgb_buy = bundle.get("xgb_buy")
rf_buy = bundle.get("rf_buy")
lgb_sell = bundle.get("lgb_sell")
xgb_sell = bundle.get("xgb_sell")
rf_sell = bundle.get("rf_sell")
feature_cols = bundle.get("features")
print(f"Version: {bundle.get('version')}")
print(f"Features ({len(feature_cols)}): {feature_cols}")

def calc_ensemble(lgb, xgb, rf, X_df):
    vals = []
    wts = []
    for m, w in [(lgb, 0.40), (xgb, 0.35), (rf, 0.25)]:
        if m is not None:
            try:
                vals.append(m.predict_proba(X_df)[:, 1])
                wts.append(w)
            except Exception:
                pass
    tot_w = sum(wts)
    res = sum(v * (w / tot_w) for v, w in zip(vals, wts))
    return res

X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
print("🧠 Generating Ensemble Probabilities...")
df['raw_buy'] = calc_ensemble(lgb_buy, xgb_buy, rf_buy, X)
df['raw_sell'] = calc_ensemble(lgb_sell, xgb_sell, rf_sell, X)
tot = df['raw_buy'] + df['raw_sell']
df['rel_buy'] = np.where(tot > 0, df['raw_buy'] / tot, 0.5)
df['rel_sell'] = np.where(tot > 0, df['raw_sell'] / tot, 0.5)

print("\n📊 Raw Probability Summary:")
print(f"Raw Buy  -> min={df['raw_buy'].min():.4f}, mean={df['raw_buy'].mean():.4f}, 75%={df['raw_buy'].quantile(0.75):.4f}, max={df['raw_buy'].max():.4f}")
print(f"Raw Sell -> min={df['raw_sell'].min():.4f}, mean={df['raw_sell'].mean():.4f}, 75%={df['raw_sell'].quantile(0.75):.4f}, max={df['raw_sell'].max():.4f}")

# Calculate forward returns (5 bars ~ 25 min, 12 bars ~ 1 hour)
for sym, g in df.groupby('symbol'):
    df.loc[g.index, 'fwd_ret_5'] = (g['close'].shift(-5) - g['close']) / g['close']
    df.loc[g.index, 'fwd_ret_12'] = (g['close'].shift(-12) - g['close']) / g['close']

# Estimated XM Crypto Spreads in percentage:
# BTC: ~$20 on $60,000 = ~0.033%
# ETH: ~$1.80 on $2,500 = ~0.072%
# SOL: ~$0.20 on $140 = ~0.14%
spread_map_pct = {
    'BTCUSDT': 0.00035,
    'ETHUSDT': 0.00075,
    'SOLUSDT': 0.00140
}
df['spread_pct'] = df['symbol'].map(spread_map_pct).fillna(0.0008)

print("\n" + "=" * 90)
print("🎯 FORWARD 5-BAR RETURN BY THRESHOLD (Crypto Model):")
print("=" * 90)

print("\n--- BUY Signals ---")
for th in [0.08, 0.12, 0.16, 0.20, 0.25]:
    mask = df['raw_buy'] >= th
    subset = df[mask].copy()
    if len(subset) == 0: continue
    net_ret = subset['fwd_ret_5'] - subset['spread_pct']
    wr = (net_ret > 0).mean() * 100
    avg_ret_pct = net_ret.mean() * 100
    print(f"Raw Buy >= {th:.2f} | Count: {len(subset):5d} | Win Rate: {wr:5.2f}% | Avg Net Return: {avg_ret_pct:+6.3f}%")

print("\n--- SELL Signals ---")
for th in [0.08, 0.12, 0.16, 0.20, 0.25]:
    mask = df['raw_sell'] >= th
    subset = df[mask].copy()
    if len(subset) == 0: continue
    net_ret = -subset['fwd_ret_5'] - subset['spread_pct']
    wr = (net_ret > 0).mean() * 100
    avg_ret_pct = net_ret.mean() * 100
    print(f"Raw Sell >= {th:.2f} | Count: {len(subset):5d} | Win Rate: {wr:5.2f}% | Avg Net Return: {avg_ret_pct:+6.3f}%")

print("\n--- By Symbol (Best Threshold) ---")
for sym, g in df.groupby('symbol'):
    b_sub = g[g['raw_buy'] >= 0.15]
    s_sub = g[g['raw_sell'] >= 0.15]
    b_wr = ((b_sub['fwd_ret_5'] - b_sub['spread_pct']) > 0).mean() * 100 if len(b_sub) > 0 else 0
    s_wr = ((-s_sub['fwd_ret_5'] - s_sub['spread_pct']) > 0).mean() * 100 if len(s_sub) > 0 else 0
    print(f"  {sym:10} | BUY (>=0.15): count={len(b_sub):4d}, WR={b_wr:5.1f}% | SELL (>=0.15): count={len(s_sub):4d}, WR={s_wr:5.1f}%")
