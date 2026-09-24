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

# Candle Anatomy
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

def run_exit_experiment(
    df_data,
    exit_type="fixed_bars", # 'fixed_bars', 'micro_scalp', 'wide_sl_scalp', 'dynamic_trail'
    bars_hold=5,
    tp_pips=4.0,
    sl_pips=12.0,
    be_pips=2.5,
    min_buy=0.20,
    min_sell=0.28,
    use_trend=True,
    use_wick=True
):
    trades = []
    for symbol, sym_df in df_data.groupby('symbol'):
        sym_df = sym_df.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_size = 0.01 if is_jpy else 0.0001
        spread_pips = 1.6 if is_jpy else 1.1
        pip_val = 0.07 if is_jpy else 0.10
        
        in_pos = False
        pos_dir = None
        entry_price = 0.0
        entry_idx = 0
        current_sl = 0.0
        be_locked = False
        n = len(sym_df)
        
        for i in range(20, n - 10):
            row = sym_df.iloc[i]
            if in_pos:
                hold_bars = i - entry_idx
                curr_high, curr_low, curr_close = row['high'], row['low'], row['close']
                exit_price = None
                exit_reason = None
                
                profit_pips = (curr_high - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - curr_low) / pip_size
                
                if exit_type == "fixed_bars":
                    # Exit strictly at bar expiration
                    if hold_bars >= bars_hold:
                        exit_price = curr_close
                        exit_reason = 'BAR_EXPIRY'
                    # Emergency hard SL (e.g. 25 pips)
                    elif pos_dir == 'BUY' and curr_low <= entry_price - (25.0 * pip_size):
                        exit_price = entry_price - (25.0 * pip_size)
                        exit_reason = 'HARD_SL'
                    elif pos_dir == 'SELL' and (curr_high + spread_pips * pip_size) >= entry_price + (25.0 * pip_size):
                        exit_price = entry_price + (25.0 * pip_size)
                        exit_reason = 'HARD_SL'
                        
                elif exit_type == "quick_profit_or_bars":
                    # If profit hits target (e.g. 3.5 pips), harvest immediately!
                    if profit_pips >= tp_pips:
                        exit_price = entry_price + (tp_pips * pip_size) if pos_dir == 'BUY' else entry_price - (tp_pips * pip_size)
                        exit_reason = 'QUICK_TP'
                    elif hold_bars >= bars_hold:
                        exit_price = curr_close
                        exit_reason = 'TIME_EXIT'
                    elif pos_dir == 'BUY' and curr_low <= current_sl:
                        exit_price = current_sl
                        exit_reason = 'SL'
                    elif pos_dir == 'SELL' and (curr_high + spread_pips * pip_size) >= current_sl:
                        exit_price = current_sl
                        exit_reason = 'SL'
                        
                elif exit_type == "wide_sl_scalp":
                    # Standard R:R with wide room for market breathing
                    target_tp = entry_price + (tp_pips * pip_size) if pos_dir == 'BUY' else entry_price - (tp_pips * pip_size)
                    if (curr_high - spread_pips * pip_size >= target_tp) if pos_dir == 'BUY' else (curr_low + spread_pips * pip_size <= target_tp):
                        exit_price = target_tp
                        exit_reason = 'TP'
                    elif (curr_low <= current_sl) if pos_dir == 'BUY' else (curr_high + spread_pips * pip_size >= current_sl):
                        exit_price = current_sl
                        exit_reason = 'SL'
                    elif hold_bars >= 12:
                        exit_price = curr_close
                        exit_reason = 'TIME'
                        
                if exit_price is not None:
                    gross_pips = (exit_price - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - exit_price) / pip_size
                    net_pips = gross_pips - spread_pips
                    net_usd = net_pips * pip_val
                    trades.append({'usd': net_usd, 'pips': net_pips, 'is_win': 1 if net_usd > 0 else 0, 'reason': exit_reason})
                    in_pos = False
                continue
                
            action = None
            if row['raw_buy'] >= min_buy:
                action = 'BUY'
            elif row['raw_sell'] >= min_sell:
                action = 'SELL'
                
            if not action: continue
            
            if use_trend:
                if action == 'BUY' and not row['trend_bullish']: continue
                if action == 'SELL' and not row['trend_bearish']: continue
                
            if use_wick:
                if action == 'BUY' and (row['upper_wick_pct'] >= 0.45 or row['prev_upper_wick_pct'] >= 0.45): continue
                if action == 'SELL' and (row['lower_wick_pct'] >= 0.45 or row['prev_lower_wick_pct'] >= 0.45): continue
                
            entry_price = row['close']
            current_sl = entry_price - (sl_pips * pip_size) if action == 'BUY' else entry_price + (sl_pips * pip_size)
            in_pos = True
            pos_dir = action
            entry_idx = i
            
    res = pd.DataFrame(trades)
    if len(res) == 0: return {'trades': 0, 'win_rate': 0.0, 'net_usd': 0.0, 'pf': 0.0, 'max_dd': 0.0}
    wins = res[res['is_win'] == 1]
    losses = res[res['is_win'] == 0]
    wr = len(wins) / len(res) * 100.0
    net_usd = res['usd'].sum()
    gross_win = wins['usd'].sum()
    gross_loss = abs(losses['usd'].sum()) if len(losses) > 0 else 1e-9
    pf = gross_win / gross_loss
    cum = res['usd'].cumsum()
    max_dd = (cum.cummax() - cum).max()
    return {'trades': len(res), 'win_rate': round(wr, 2), 'net_usd': round(net_usd, 2), 'pf': round(pf, 2), 'max_dd': round(max_dd, 2)}

configs = [
    # Fixed Bars Exit (Model Horizon)
    ("Fixed 5-Bar Horizon Exit (Buy>=0.20, Sell>=0.28)", "fixed_bars", 5, 0, 25, 0.20, 0.28, True, True),
    ("Fixed 5-Bar Horizon Exit (Buy>=0.25, Sell>=0.30)", "fixed_bars", 5, 0, 25, 0.25, 0.30, True, True),
    ("Fixed 5-Bar Horizon Exit (Buy>=0.30, Sell>=0.35)", "fixed_bars", 5, 0, 25, 0.30, 0.35, True, True),
    ("Fixed 4-Bar Horizon Exit (Buy>=0.25, Sell>=0.30)", "fixed_bars", 4, 0, 25, 0.25, 0.30, True, True),
    ("Fixed 6-Bar Horizon Exit (Buy>=0.25, Sell>=0.30)", "fixed_bars", 6, 0, 25, 0.25, 0.30, True, True),
    
    # Quick TP (Harvest before 5 bars if target met)
    ("Quick Profit TP 3.5 / Hold 5 bars (Buy>=0.25, Sell>=0.30)", "quick_profit_or_bars", 5, 3.5, 12, 0.25, 0.30, True, True),
    ("Quick Profit TP 4.5 / Hold 5 bars (Buy>=0.25, Sell>=0.30)", "quick_profit_or_bars", 5, 4.5, 12, 0.25, 0.30, True, True),
    ("Quick Profit TP 5.0 / Hold 6 bars (Buy>=0.25, Sell>=0.30)", "quick_profit_or_bars", 6, 5.0, 12, 0.25, 0.30, True, True),
    
    # No Trend/Wick restriction on ultra-high ML conviction (ML knows best)
    ("Pure ML Conviction 5-Bar (Buy>=0.25, Sell>=0.30, No Extra Guards)", "fixed_bars", 5, 0, 25, 0.25, 0.30, False, False),
    ("Pure ML Conviction 5-Bar (Buy>=0.30, Sell>=0.35, No Extra Guards)", "fixed_bars", 5, 0, 25, 0.30, 0.35, False, False),
]

print(f"{'Experiment Name':65} | {'Trades':>6} | {'Win Rate':>8} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>8}")
print("-" * 115)

for label, etype, bhold, tp, sl, mb, ms, ut, uw in configs:
    r = run_exit_experiment(df, exit_type=etype, bars_hold=bhold, tp_pips=tp, sl_pips=sl, min_buy=mb, min_sell=ms, use_trend=ut, use_wick=uw)
    print(f"{label:65} | {r['trades']:6d} | {r['win_rate']:7.2f}% | ${r['net_usd']:9.2f} | {r['pf']:5.2f} | ${r['max_dd']:7.2f}")
