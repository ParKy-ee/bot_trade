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

df = pd.read_csv(DATA_PATH)
bundle = joblib.load(MODEL_PATH)
lgb_buy = bundle.get("lgb_buy")
xgb_buy = bundle.get("xgb_buy")
rf_buy = bundle.get("rf_buy")
lgb_sell = bundle.get("lgb_sell")
xgb_sell = bundle.get("xgb_sell")
rf_sell = bundle.get("rf_sell")
feature_cols = bundle.get("features")

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
df['raw_buy'] = calc_ensemble(lgb_buy, xgb_buy, rf_buy, X)
df['raw_sell'] = calc_ensemble(lgb_sell, xgb_sell, rf_sell, X)

df['range'] = df['high'] - df['low'] + 1e-9
df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
df['upper_wick_pct'] = df['upper_wick'] / df['range']
df['lower_wick_pct'] = df['lower_wick'] / df['range']
df['prev_upper_wick_pct'] = df.groupby('symbol')['upper_wick_pct'].shift(1).fillna(0.0)
df['prev_lower_wick_pct'] = df.groupby('symbol')['lower_wick_pct'].shift(1).fillna(0.0)

CRYPTO_SPECS = {
    'BTCUSDT': {'lot': 0.01, 'spread': 22.0, 'val_per_point': 0.01, 'tp_usd': 250.0, 'sl_usd': 350.0},
    'ETHUSDT': {'lot': 0.02, 'spread': 2.0, 'val_per_point': 0.02, 'tp_usd': 15.0, 'sl_usd': 25.0},
    'SOLUSDT': {'lot': 0.05, 'spread': 0.22, 'val_per_point': 0.05, 'tp_usd': 1.50, 'sl_usd': 2.50}
}

def simulate_crypto(min_buy=0.18, min_sell=0.18, hold_bars=6, tp_mult=0.0, sl_mult=1.0, wick_thresh=0.45):
    trades = []
    for symbol, g in df.groupby('symbol'):
        g = g.reset_index(drop=True)
        spec = CRYPTO_SPECS[symbol]
        spread = spec['spread']
        val = spec['val_per_point']
        target_tp = spec['tp_usd'] * tp_mult if tp_mult > 0 else 0
        target_sl = spec['sl_usd'] * sl_mult
        
        in_pos = False
        pos_dir = None
        entry_p = 0.0
        entry_i = 0
        
        for i in range(20, len(g) - 10):
            row = g.iloc[i]
            if in_pos:
                hold = i - entry_i
                curr_high, curr_low, curr_close = row['high'], row['low'], row['close']
                exit_p = None
                exit_reason = None
                
                # TP
                if target_tp > 0:
                    profit = (curr_high - entry_p) if pos_dir == 'BUY' else (entry_p - curr_low)
                    if profit >= target_tp:
                        exit_p = entry_p + target_tp if pos_dir == 'BUY' else entry_p - target_tp
                        exit_reason = 'TP'
                
                # SL
                if exit_p is None:
                    loss = (entry_p - curr_low) if pos_dir == 'BUY' else (curr_high - entry_p)
                    if loss >= target_sl:
                        exit_p = entry_p - target_sl if pos_dir == 'BUY' else entry_p + target_sl
                        exit_reason = 'SL'
                        
                # Time Expiry
                if exit_p is None and hold >= hold_bars:
                    exit_p = curr_close
                    exit_reason = 'EXPIRY'
                    
                if exit_p is not None:
                    gross = (exit_p - entry_p) if pos_dir == 'BUY' else (entry_p - exit_p)
                    net = gross - spread
                    trades.append({'sym': symbol, 'usd': net * val, 'win': 1 if net > 0 else 0, 'reason': exit_reason})
                    in_pos = False
                continue
                
            if row['raw_buy'] >= min_buy and row['raw_buy'] > row['raw_sell']:
                if row['upper_wick_pct'] >= wick_thresh or row['prev_upper_wick_pct'] >= wick_thresh: continue
                in_pos = True; pos_dir = 'BUY'; entry_p = row['close']; entry_i = i
            elif row['raw_sell'] >= min_sell and row['raw_sell'] > row['raw_buy']:
                if row['lower_wick_pct'] >= wick_thresh or row['prev_lower_wick_pct'] >= wick_thresh: continue
                in_pos = True; pos_dir = 'SELL'; entry_p = row['close']; entry_i = i

    res = pd.DataFrame(trades)
    if len(res) == 0: return {}
    wins = res[res['win'] == 1]
    losses = res[res['win'] == 0]
    wr = len(wins) / len(res) * 100
    net_usd = res['usd'].sum()
    gross_win = wins['usd'].sum()
    gross_loss = abs(losses['usd'].sum()) if len(losses) > 0 else 1e-9
    pf = gross_win / gross_loss
    cum = res['usd'].cumsum()
    max_dd = (cum.cummax() - cum).max()
    return {'trades': len(res), 'win_rate': round(wr, 2), 'net_usd': round(net_usd, 2), 'pf': round(pf, 2), 'max_dd': round(max_dd, 2)}

tests = [
    # Varying hold bars (pure horizon + wick guard)
    ("A. Hold 4 Bars (20 min) + Wick Guard (0.18/0.18)", 0.18, 0.18, 4, 0.0),
    ("B. Hold 5 Bars (25 min) + Wick Guard (0.18/0.18)", 0.18, 0.18, 5, 0.0),
    ("C. Hold 6 Bars (30 min) + Wick Guard (0.18/0.18) [Top PnL]", 0.18, 0.18, 6, 0.0),
    ("D. Hold 8 Bars (40 min) + Wick Guard (0.18/0.18)", 0.18, 0.18, 8, 0.0),
    ("E. Hold 10 Bars (50 min) + Wick Guard (0.18/0.18)", 0.18, 0.18, 10, 0.0),
    
    # Adding High TP (Let runners run, take profit at $300 BTC / $18 ETH / $1.8 SOL)
    ("F. Hold 6 Bars + High TP (1.2x) (0.18/0.18)", 0.18, 0.18, 6, 1.2),
    ("G. Hold 6 Bars + High TP (1.5x) (0.18/0.18)", 0.18, 0.18, 6, 1.5),
    
    # Higher conviction threshold 0.20
    ("H. Hold 6 Bars + Conviction 0.20/0.20 (High WR)", 0.20, 0.20, 6, 0.0),
    ("I. Hold 6 Bars + Conviction 0.20/0.20 + High TP (1.2x)", 0.20, 0.20, 6, 1.2),
    ("J. Hold 6 Bars + Conviction 0.22/0.22 (Sniper 57% WR)", 0.22, 0.22, 6, 0.0),
]

print(f"{'Configuration':55} | {'Trades':>6} | {'WR (%)':>7} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>7}")
print("-" * 105)
for label, mb, ms, hb, tp in tests:
    r = simulate_crypto(min_buy=mb, min_sell=ms, hold_bars=hb, tp_mult=tp)
    print(f"{label:55} | {r['trades']:6d} | {r['win_rate']:6.2f}% | ${r['net_usd']:+9.2f} | {r['pf']:5.2f} | ${r['max_dd']:6.2f}")
