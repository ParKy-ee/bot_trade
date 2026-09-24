import os
import sys
import warnings
import numpy as np
import pandas as pd
import joblib

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

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
if 'spread_to_atr' not in df.columns:
    df['spread_to_atr'] = np.where(df['is_jpy'] == 1.0, 0.02, 0.00015) / (df['atr_14'] + 1e-12)

dt = pd.to_datetime(df['time'], errors='coerce')
hrs = dt.dt.hour + (dt.dt.minute / 60.0)
df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)

# Indicators
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

def run_true_test(
    min_buy=0.25,
    min_sell=0.30,
    hold_bars=5,
    tp_pips=0.0, # 0 = purely hold to hold_bars
    sl_pips=15.0,
    use_trend=True,
    use_wick=True
):
    trades = []
    for symbol, sym_df in df.groupby('symbol'):
        sym_df = sym_df.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_size = 0.01 if is_jpy else 0.0001
        spread_pips = 1.6 if is_jpy else 1.1
        pip_val = 0.07 if is_jpy else 0.10
        
        in_pos = False
        pos_dir = None
        entry_price = 0.0
        entry_idx = 0
        n = len(sym_df)
        
        for i in range(20, n - 10):
            row = sym_df.iloc[i]
            if in_pos:
                hold = i - entry_idx
                curr_high, curr_low, curr_close = row['high'], row['low'], row['close']
                exit_price = None
                exit_reason = None
                
                # Check TP
                if tp_pips > 0:
                    profit_pips = (curr_high - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - curr_low) / pip_size
                    if profit_pips >= tp_pips:
                        exit_price = entry_price + (tp_pips * pip_size) if pos_dir == 'BUY' else entry_price - (tp_pips * pip_size)
                        exit_reason = 'TP'
                
                # Check SL
                if exit_price is None and sl_pips > 0:
                    loss_pips = (entry_price - curr_low) / pip_size if pos_dir == 'BUY' else (curr_high - entry_price) / pip_size
                    if loss_pips >= sl_pips:
                        exit_price = entry_price - (sl_pips * pip_size) if pos_dir == 'BUY' else entry_price + (sl_pips * pip_size)
                        exit_reason = 'SL'
                        
                # Check Bar Expiration
                if exit_price is None and hold >= hold_bars:
                    exit_price = curr_close
                    exit_reason = 'EXPIRY'
                    
                if exit_price is not None:
                    gross_pips = (exit_price - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - exit_price) / pip_size
                    net_pips = gross_pips - spread_pips
                    net_usd = net_pips * pip_val
                    trades.append({'usd': net_usd, 'pips': net_pips, 'is_win': 1 if net_usd > 0 else 0, 'reason': exit_reason})
                    in_pos = False
                continue
                
            action = None
            if row['raw_buy'] >= min_buy and row['raw_buy'] > row['raw_sell']:
                action = 'BUY'
            elif row['raw_sell'] >= min_sell and row['raw_sell'] > row['raw_buy']:
                action = 'SELL'
                
            if not action: continue
            
            if use_trend:
                if action == 'BUY' and not row['trend_bullish']: continue
                if action == 'SELL' and not row['trend_bearish']: continue
                
            if use_wick:
                if action == 'BUY' and (row['upper_wick_pct'] >= 0.45 or row['prev_upper_wick_pct'] >= 0.45): continue
                if action == 'SELL' and (row['lower_wick_pct'] >= 0.45 or row['prev_lower_wick_pct'] >= 0.45): continue
                
            entry_price = row['close']
            in_pos = True
            pos_dir = action
            entry_idx = i
            
    res = pd.DataFrame(trades)
    if len(res) == 0: return {'trades': 0, 'win_rate': 0.0, 'net_usd': 0.0, 'net_pips': 0.0, 'pf': 0.0, 'max_dd': 0.0}
    wins = res[res['is_win'] == 1]
    losses = res[res['is_win'] == 0]
    wr = len(wins) / len(res) * 100.0
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
        'net_usd': round(net_usd, 2),
        'net_pips': round(net_pips, 1),
        'pf': round(pf, 2),
        'max_dd': round(max_dd, 2)
    }

experiments = [
    # Fixed Hold 5 bars
    ("1. Pure ML (Buy>=0.20, Sell>=0.28) 5-bar hold", 0.20, 0.28, 5, 0.0, 20.0, False, False),
    ("2. Pure ML (Buy>=0.25, Sell>=0.30) 5-bar hold", 0.25, 0.30, 5, 0.0, 20.0, False, False),
    ("3. Pure ML (Buy>=0.30, Sell>=0.35) 5-bar hold", 0.30, 0.35, 5, 0.0, 20.0, False, False),
    
    # Adding Trend Guard
    ("4. ML (0.25/0.30) + Trend Guard 5-bar hold", 0.25, 0.30, 5, 0.0, 20.0, True, False),
    
    # Adding Trend + Wick Guard
    ("5. ML (0.25/0.30) + Trend + Wick Guard 5-bar hold", 0.25, 0.30, 5, 0.0, 20.0, True, True),
    
    # Combining with Early Take-Profit (Harvest profit early if it hits 4.0 or 5.0 pips)
    ("6. ML (0.25/0.30) + All Guards + Quick TP 4.0 pips (Hold 5)", 0.25, 0.30, 5, 4.0, 15.0, True, True),
    ("7. ML (0.25/0.30) + All Guards + Quick TP 5.0 pips (Hold 6)", 0.25, 0.30, 6, 5.0, 15.0, True, True),
    ("8. ML (0.25/0.30) + All Guards + Quick TP 6.0 pips (Hold 6)", 0.25, 0.30, 6, 6.0, 15.0, True, True),
    
    # Tuned Sweet Spot
    ("9. Tuned Sniper (Buy>=0.28, Sell>=0.32) + Trend + Quick TP 5.0", 0.28, 0.32, 6, 5.0, 15.0, True, True),
]

print(f"{'Experiment Name':62} | {'Trades':>6} | {'Win Rate':>8} | {'Net Pips':>10} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>8}")
print("-" * 125)
for name, mb, ms, hb, tp, sl, ut, uw in experiments:
    r = run_true_test(min_buy=mb, min_sell=ms, hold_bars=hb, tp_pips=tp, sl_pips=sl, use_trend=ut, use_wick=uw)
    print(f"{name:62} | {r['trades']:6d} | {r['win_rate']:7.2f}% | {r['net_pips']:9.1f}p | ${r['net_usd']:9.2f} | {r['pf']:5.2f} | ${r['max_dd']:7.2f}")
