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

df['range'] = df['high'] - df['low'] + 1e-9
df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
df['upper_wick_pct'] = df['upper_wick'] / df['range']
df['lower_wick_pct'] = df['lower_wick'] / df['range']
df['prev_upper_wick_pct'] = df.groupby('symbol')['upper_wick_pct'].shift(1).fillna(0.0)
df['prev_lower_wick_pct'] = df.groupby('symbol')['lower_wick_pct'].shift(1).fillna(0.0)
df['dist_ema50_atr'] = (df['close'] - df['ema_50']).abs() / (df['atr_14'] + 1e-9)

X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
prob_buy = buy_model.predict_proba(X)[:, 1]
prob_sell = sell_model.predict_proba(X)[:, 1]
tot_prob = prob_buy + prob_sell
df['rel_buy'] = np.where(tot_prob > 0, prob_buy / tot_prob, 0.5)
df['rel_sell'] = np.where(tot_prob > 0, prob_sell / tot_prob, 0.5)

def run_live_sim(df_data, guard_wick=False, wick_thresh=0.50, guard_overext=False, guard_adx=False, min_adx=18):
    trades = []
    for symbol, sym_df in df_data.groupby('symbol'):
        sym_df = sym_df.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_size = 0.01 if is_jpy else 0.0001
        spread_pips = 1.8 if is_jpy else 1.2
        micro_harvest_pips = 6.0 if is_jpy else 4.0
        be_trigger_pips = 2.5
        min_sl_pips = 11.0 if is_jpy else 7.5
        pip_val = 0.07 if is_jpy else 0.10
        
        in_pos = False
        pos_dir = None
        entry_price = 0.0
        sl_price = 0.0
        entry_idx = 0
        be_locked = False
        n = len(sym_df)
        
        for i in range(20, n - 10):
            row = sym_df.iloc[i]
            if in_pos:
                curr_high, curr_low, curr_close = row['high'], row['low'], row['close']
                hold_bars = i - entry_idx
                exit_price = None
                exit_reason = None
                
                if pos_dir == 'BUY':
                    profit_pips = (curr_high - entry_price) / pip_size
                    # 1. Micro harvest
                    if profit_pips >= micro_harvest_pips:
                        exit_price = entry_price + (micro_harvest_pips * pip_size)
                        exit_reason = 'MICRO_HARVEST'
                    # 2. Check SL / BE
                    elif curr_low <= sl_price:
                        exit_price = sl_price
                        exit_reason = 'BE_SL' if be_locked else 'SL'
                    # 3. Dynamic BE Lock
                    elif profit_pips >= be_trigger_pips and not be_locked:
                        sl_price = entry_price + (0.5 * pip_size) # Lock +0.5 pips
                        be_locked = True
                    # 4. Max hold timeout (45 mins = 9 bars)
                    elif hold_bars >= 9:
                        exit_price = curr_close
                        exit_reason = 'TIME_EXIT'
                else: # SELL
                    profit_pips = (entry_price - curr_low) / pip_size
                    if profit_pips >= micro_harvest_pips:
                        exit_price = entry_price - (micro_harvest_pips * pip_size)
                        exit_reason = 'MICRO_HARVEST'
                    elif (curr_high + spread_pips * pip_size) >= sl_price:
                        exit_price = sl_price
                        exit_reason = 'BE_SL' if be_locked else 'SL'
                    elif profit_pips >= be_trigger_pips and not be_locked:
                        sl_price = entry_price - (0.5 * pip_size)
                        be_locked = True
                    elif hold_bars >= 9:
                        exit_price = curr_close
                        exit_reason = 'TIME_EXIT'
                
                if exit_price is not None:
                    gross_pips = (exit_price - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - exit_price) / pip_size
                    net_pips = gross_pips - spread_pips
                    net_usd = net_pips * pip_val
                    trades.append({'usd': net_usd, 'pips': net_pips, 'is_win': 1 if net_usd > 0 else 0, 'reason': exit_reason})
                    in_pos = False
                continue
            
            rel_buy, rel_sell = row['rel_buy'], row['rel_sell']
            atr, rsi, adx = row['atr_14'], row['rsi_14'], row['adx_14']
            
            action = None
            if rel_buy >= 0.52 and rel_buy > rel_sell: action = 'BUY'
            elif rel_sell >= 0.52 and rel_sell > rel_buy: action = 'SELL'
            if not action: continue
            
            if guard_wick:
                if action == 'BUY' and (row['prev_upper_wick_pct'] >= wick_thresh or row['upper_wick_pct'] >= wick_thresh): continue
                if action == 'SELL' and (row['prev_lower_wick_pct'] >= wick_thresh or row['lower_wick_pct'] >= wick_thresh): continue
            if guard_overext:
                if action == 'BUY' and (rsi > 72 or row['dist_ema50_atr'] > 2.2): continue
                if action == 'SELL' and (rsi < 28 or row['dist_ema50_atr'] > 2.2): continue
            if guard_adx:
                if adx < min_adx: continue
                
            entry_price = row['close']
            sl_dist = max(min_sl_pips * pip_size, 1.4 * atr)
            sl_price = entry_price - sl_dist if action == 'BUY' else entry_price + sl_dist
            be_locked = False
            in_pos = True
            pos_dir = action
            entry_idx = i
            
    res = pd.DataFrame(trades)
    if len(res) == 0: return {}
    wins = res[res['is_win'] == 1]
    losses = res[res['is_win'] == 0]
    wr = len(wins) / len(res) * 100
    net_usd = res['usd'].sum()
    gross_win = wins['usd'].sum()
    gross_loss = abs(losses['usd'].sum()) if len(losses) > 0 else 1e-9
    pf = gross_win / gross_loss
    cum = res['usd'].cumsum()
    max_dd = (cum.cummax() - cum).max()
    return {
        'trades': len(res),
        'win_rate': round(wr, 2),
        'net_usd': round(net_usd, 2),
        'pf': round(pf, 2),
        'max_dd': round(max_dd, 2)
    }

base = run_live_sim(df, False, 0.50, False, False, 18)
base_trades = base['trades']

configs = [
    ("Baseline (No Guards)", False, 0.50, False, False, 18),
    ("Guard 1: Wick Filter (>=50%)", True, 0.50, False, False, 18),
    ("Guard 1 Light: Wick Filter (>=60%)", True, 0.60, False, False, 18),
    ("Guard 2: Overextended (RSI/ATR)", False, 0.50, True, False, 18),
    ("Guard 3: ADX Chop (<18)", False, 0.50, False, True, 18),
    ("Combined Moderate (Wick>=50%, Overext, ADX<18)", True, 0.50, True, True, 18),
    ("Combined Balanced (Wick>=60%, Overext, ADX<14)", True, 0.60, True, True, 14),
]

print("\n📈 [Live Micro-Harvest & Dynamic BE Simulation]")
print(f"{'Config Name':48} | {'Trades':>6} | {'Order Drop':>10} | {'Win Rate':>8} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>8}")
print("-" * 105)

for name, gw, wt, go, ga, ma in configs:
    s = run_live_sim(df, gw, wt, go, ga, ma)
    drop_pct = ((base_trades - s['trades']) / base_trades) * 100.0
    print(f"{name:48} | {s['trades']:6d} | {drop_pct:9.1f}% | {s['win_rate']:7.2f}% | ${s['net_usd']:9.2f} | {s['pf']:5.2f} | ${s['max_dd']:7.2f}")
