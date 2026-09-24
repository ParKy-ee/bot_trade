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
df['trend_bullish'] = (df['close'] > df['ema_50']) & (df['ema_20'] >= df['ema_50'])
df['trend_bearish'] = (df['close'] < df['ema_50']) & (df['ema_20'] <= df['ema_50'])

X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
df['raw_buy'] = buy_model.predict_proba(X)[:, 1]
df['raw_sell'] = sell_model.predict_proba(X)[:, 1]

def run_pure_sequential(min_buy=0.20, min_sell=0.28, hold_bars=5, use_wick=False, use_trend=False):
    trades = []
    for symbol, g in df.groupby('symbol'):
        g = g.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_sz = 0.01 if is_jpy else 0.0001
        spread = 1.6 if is_jpy else 1.1
        pip_val = 0.07 if is_jpy else 0.10
        
        in_pos = False
        pos_dir = None
        entry_p = 0.0
        entry_i = 0
        
        for i in range(len(g)):
            row = g.iloc[i]
            if in_pos:
                if i - entry_i >= hold_bars:
                    exit_p = row['close']
                    gross = (exit_p - entry_p)/pip_sz if pos_dir == 'BUY' else (entry_p - exit_p)/pip_sz
                    net_p = gross - spread
                    trades.append({'sym': symbol, 'pips': net_p, 'usd': net_p * pip_val, 'win': 1 if net_p > 0 else 0})
                    in_pos = False
                else:
                    continue
                    
            if row['raw_buy'] >= min_buy and row['raw_buy'] > row['raw_sell']:
                if use_trend and not row['trend_bullish']: continue
                if use_wick and (row['upper_wick_pct'] >= 0.45 or row['prev_upper_wick_pct'] >= 0.45): continue
                in_pos = True
                pos_dir = 'BUY'
                entry_p = row['close']
                entry_i = i
            elif row['raw_sell'] >= min_sell and row['raw_sell'] > row['raw_buy']:
                if use_trend and not row['trend_bearish']: continue
                if use_wick and (row['lower_wick_pct'] >= 0.45 or row['prev_lower_wick_pct'] >= 0.45): continue
                in_pos = True
                pos_dir = 'SELL'
                entry_p = row['close']
                entry_i = i

    res = pd.DataFrame(trades)
    wins = res[res['win'] == 1]
    losses = res[res['win'] == 0]
    wr = len(wins) / len(res) * 100
    net_usd = res['usd'].sum()
    net_pips = res['pips'].sum()
    gross_win = wins['usd'].sum()
    gross_loss = abs(losses['usd'].sum()) if len(losses) > 0 else 1e-9
    pf = gross_win / gross_loss
    cum = res['usd'].cumsum()
    max_dd = (cum.cummax() - cum).max()
    return {
        'trades': len(res),
        'win_rate': round(wr, 2),
        'net_pips': round(net_pips, 1),
        'net_usd': round(net_usd, 2),
        'pf': round(pf, 2),
        'max_dd': round(max_dd, 2)
    }

print("=== Sequential 5-Bar Hold Results ===")
for name, mb, ms, hb, uw, ut in [
    ("1. Pure ML (0.20 / 0.28) 5-bar hold", 0.20, 0.28, 5, False, False),
    ("2. Pure ML (0.22 / 0.30) 5-bar hold", 0.22, 0.30, 5, False, False),
    ("3. ML (0.20 / 0.28) + Wick Guard (45%)", 0.20, 0.28, 5, True, False),
    ("4. ML (0.20 / 0.28) + Trend Guard", 0.20, 0.28, 5, False, True),
    ("5. ML (0.20 / 0.28) + Wick + Trend Guard", 0.20, 0.28, 5, True, True),
    ("6. ML (0.22 / 0.30) + Wick + Trend Guard", 0.22, 0.30, 5, True, True),
    ("7. ML (0.25 / 0.30) + Wick + Trend Guard (Hold 6 bars)", 0.25, 0.30, 6, True, True),
]:
    r = run_pure_sequential(min_buy=mb, min_sell=ms, hold_bars=hb, use_wick=uw, use_trend=ut)
    print(f"{name:50} | Trades: {r['trades']:4d} | WR: {r['win_rate']:5.2f}% | Net Pips: {r['net_pips']:+7.1f}p | Net USD: ${r['net_usd']:+7.2f} | PF: {r['pf']:4.2f} | DD: ${r['max_dd']:6.2f}")
