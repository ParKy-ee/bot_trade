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

# Indicators for Guards
df['range'] = df['high'] - df['low'] + 1e-9
df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
df['upper_wick_pct'] = df['upper_wick'] / df['range']
df['lower_wick_pct'] = df['lower_wick'] / df['range']
df['prev_upper_wick_pct'] = df.groupby('symbol')['upper_wick_pct'].shift(1).fillna(0.0)
df['prev_lower_wick_pct'] = df.groupby('symbol')['lower_wick_pct'].shift(1).fillna(0.0)

X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
df['raw_buy'] = buy_model.predict_proba(X)[:, 1]
df['raw_sell'] = sell_model.predict_proba(X)[:, 1]

# Realistic XM Standard Broker Spreads (in pips)
# Majors: 1.7 - 1.9 pips, JPY / Crosses: 2.3 - 2.8 pips
XM_STANDARD_SPREADS = {
    'EURUSD=X': 1.7,
    'GBPUSD=X': 2.0,
    'USDJPY=X': 1.9,
    'AUDUSD=X': 1.8,
    'USDCHF=X': 1.9,
    'USDCAD=X': 2.1,
    'NZDUSD=X': 2.2,
    'EURJPY=X': 2.5,
    'GBPJPY=X': 2.8,
}

def run_xm_standard_test(
    min_buy=0.22,
    min_sell=0.30,
    quick_tp_pips=8.0,
    safety_sl_pips=18.0,
    hold_bars=5,
    wick_thresh=0.45
):
    trades = []
    for symbol, g in df.groupby('symbol'):
        g = g.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_sz = 0.01 if is_jpy else 0.0001
        spread = XM_STANDARD_SPREADS.get(str(symbol), 2.4 if is_jpy else 1.8)
        pip_val = 0.07 if is_jpy else 0.10
        
        sym_tp = quick_tp_pips * (1.3 if is_jpy else 1.0)
        sym_sl = safety_sl_pips * (1.3 if is_jpy else 1.0)
        
        in_pos = False
        pos_dir = None
        entry_p = 0.0
        entry_i = 0
        
        for i in range(len(g)):
            row = g.iloc[i]
            if in_pos:
                hold = i - entry_i
                curr_high, curr_low, curr_close = row['high'], row['low'], row['close']
                exit_p = None
                exit_reason = None
                
                # TP check
                if sym_tp > 0:
                    profit_pips = (curr_high - entry_p)/pip_sz if pos_dir == 'BUY' else (entry_p - curr_low)/pip_sz
                    if profit_pips >= sym_tp:
                        exit_p = entry_p + (sym_tp * pip_sz) if pos_dir == 'BUY' else entry_p - (sym_tp * pip_sz)
                        exit_reason = 'QUICK_TP'
                        
                # SL check
                if exit_p is None and sym_sl > 0:
                    loss_pips = (entry_p - curr_low)/pip_sz if pos_dir == 'BUY' else (curr_high - entry_p)/pip_sz
                    if loss_pips >= sym_sl:
                        exit_p = entry_p - (sym_sl * pip_sz) if pos_dir == 'BUY' else entry_p + (sym_sl * pip_sz)
                        exit_reason = 'SAFETY_SL'
                        
                # Time decay
                if exit_p is None and hold >= hold_bars:
                    exit_p = curr_close
                    exit_reason = 'HORIZON_EXPIRY'
                    
                if exit_p is not None:
                    gross = (exit_p - entry_p)/pip_sz if pos_dir == 'BUY' else (entry_p - exit_p)/pip_sz
                    net_p = gross - spread
                    trades.append({
                        'sym': symbol,
                        'pips': float(net_p),
                        'usd': float(net_p * pip_val),
                        'win': 1 if net_p > 0 else 0,
                        'reason': exit_reason,
                        'hold': hold
                    })
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
    wr = float(len(wins) / len(res) * 100)
    net_usd = float(res['usd'].sum())
    net_pips = float(res['pips'].sum())
    gross_win = float(wins['usd'].sum())
    gross_loss = float(abs(losses['usd'].sum())) if len(losses) > 0 else 1e-9
    pf = float(gross_win / gross_loss)
    cum = res['usd'].cumsum()
    max_dd = float((cum.cummax() - cum).max())
    tp_c = len(res[res['reason'] == 'QUICK_TP'])
    sl_c = len(res[res['reason'] == 'SAFETY_SL'])
    exp_c = len(res[res['reason'] == 'HORIZON_EXPIRY'])
    
    return {
        'trades': len(res),
        'win_rate': round(wr, 2),
        'net_pips': round(net_pips, 1),
        'net_usd': round(net_usd, 2),
        'pf': round(pf, 2),
        'max_dd': round(max_dd, 2),
        'tp_c': tp_c, 'sl_c': sl_c, 'exp_c': exp_c
    }

print("\n" + "=" * 125)
print(f"🎯 OPTIMIZATION SPECIFICALLY FOR XM STANDARD ACCOUNT (Realistic 1.7 - 2.8 pips spread)")
print("=" * 125)
print(f"{'Configuration':55} | {'Trades':>6} | {'WR (%)':>7} | {'Net Pips':>10} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>7}")
print("-" * 125)

configs = [
    ("1. Pure Horizon 5-Bar (No Quick TP, SL 18p)", 0.22, 0.30, 0.0, 18.0, 5),
    ("2. Quick TP 7.0 pips + Horizon 5-Bar (SL 18p)", 0.22, 0.30, 7.0, 18.0, 5),
    ("3. Quick TP 8.0 pips + Horizon 5-Bar (SL 18p) [Recommended]", 0.22, 0.30, 8.0, 18.0, 5),
    ("4. Quick TP 9.0 pips + Horizon 5-Bar (SL 18p)", 0.22, 0.30, 9.0, 18.0, 5),
    ("5. Quick TP 10.0 pips + Horizon 5-Bar (SL 18p)", 0.22, 0.30, 10.0, 18.0, 5),
    ("6. Quick TP 8.0 pips + Horizon 6-Bar (SL 18p)", 0.22, 0.30, 8.0, 18.0, 6),
    ("7. High Volume (0.20/0.28) + Quick TP 8.0p (Hold 5)", 0.20, 0.28, 8.0, 18.0, 5),
    ("8. High Volume (0.20/0.28) + Pure Horizon 5-Bar", 0.20, 0.28, 0.0, 18.0, 5),
]

for label, mb, ms, tp, sl, hb in configs:
    r = run_xm_standard_test(min_buy=mb, min_sell=ms, quick_tp_pips=tp, safety_sl_pips=sl, hold_bars=hb)
    print(f"{label:55} | {r['trades']:6d} | {r['win_rate']:6.2f}% | {r['net_pips']:+9.1f}p | ${r['net_usd']:+9.2f} | {r['pf']:5.2f} | ${r['max_dd']:6.2f}")
print("=" * 125)
