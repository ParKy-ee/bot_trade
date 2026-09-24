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

print("📂 Loading Forex M5 dataset...")
df = pd.read_csv(DATA_PATH)

bundle = joblib.load(MODEL_PATH)
buy_model = bundle['buy_model']
sell_model = bundle['sell_model']
feature_cols = bundle['features']
print(f"Loaded Model Version: {bundle.get('version', 'unknown')}")

# Features setup
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
df['dist_ema50_atr'] = (df['close'] - df['ema_50']).abs() / (df['atr_14'] + 1e-9)

# Trend indicators
df['trend_bullish'] = (df['close'] > df['ema_50']) & (df['ema_20'] >= df['ema_50'])
df['trend_bearish'] = (df['close'] < df['ema_50']) & (df['ema_20'] <= df['ema_50'])

# Inference
print("🧠 Generating Model Predictions...")
X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
prob_buy = buy_model.predict_proba(X)[:, 1]
prob_sell = sell_model.predict_proba(X)[:, 1]
tot_prob = prob_buy + prob_sell
df['raw_buy'] = prob_buy
df['raw_sell'] = prob_sell
df['rel_buy'] = np.where(tot_prob > 0, prob_buy / tot_prob, 0.5)
df['rel_sell'] = np.where(tot_prob > 0, prob_sell / tot_prob, 0.5)

def run_simulation(
    df_data,
    use_raw_threshold=True,
    min_raw_buy=0.20,
    min_raw_sell=0.28,
    min_rel_prob=0.52,
    use_trend_guard=True,
    use_wick_guard=True,
    wick_threshold=0.45,
    use_overext_guard=True,
    use_adx_guard=True,
    min_adx=16,
    tp_pips=7.0,
    sl_pips=6.5,
    be_trigger_pips=3.2,
    be_lock_pips=1.2,
    max_hold_bars=7
):
    trades = []
    
    for symbol, sym_df in df_data.groupby('symbol'):
        sym_df = sym_df.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_size = 0.01 if is_jpy else 0.0001
        spread_pips = 1.6 if is_jpy else 1.1
        pip_val = 0.07 if is_jpy else 0.10
        
        sym_tp = tp_pips * (1.3 if is_jpy else 1.0)
        sym_sl = sl_pips * (1.3 if is_jpy else 1.0)
        sym_be_trigger = be_trigger_pips * (1.2 if is_jpy else 1.0)
        sym_be_lock = be_lock_pips * (1.2 if is_jpy else 1.0)
        
        in_pos = False
        pos_dir = None
        entry_price = 0.0
        current_sl = 0.0
        target_tp = 0.0
        be_locked = False
        entry_idx = 0
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
                    # TP Check
                    if (curr_high - spread_pips * pip_size) >= target_tp:
                        exit_price = target_tp
                        exit_reason = 'TP'
                    # SL Check
                    elif curr_low <= current_sl:
                        exit_price = current_sl
                        exit_reason = 'BE' if be_locked else 'SL'
                    # BE Lock Check
                    elif (not be_locked) and profit_pips >= sym_be_trigger:
                        current_sl = entry_price + (sym_be_lock * pip_size)
                        be_locked = True
                    # Max hold expiration
                    elif hold_bars >= max_hold_bars:
                        exit_price = curr_close
                        exit_reason = 'TIME'
                else: # SELL
                    profit_pips = (entry_price - curr_low) / pip_size
                    if (curr_low + spread_pips * pip_size) <= target_tp:
                        exit_price = target_tp
                        exit_reason = 'TP'
                    elif (curr_high + spread_pips * pip_size) >= current_sl:
                        exit_price = current_sl
                        exit_reason = 'BE' if be_locked else 'SL'
                    elif (not be_locked) and profit_pips >= sym_be_trigger:
                        current_sl = entry_price - (sym_be_lock * pip_size)
                        be_locked = True
                    elif hold_bars >= max_hold_bars:
                        exit_price = curr_close
                        exit_reason = 'TIME'
                        
                if exit_price is not None:
                    gross_pips = (exit_price - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - exit_price) / pip_size
                    net_pips = gross_pips - spread_pips
                    net_usd = net_pips * pip_val
                    trades.append({
                        'symbol': symbol,
                        'usd': net_usd,
                        'pips': net_pips,
                        'is_win': 1 if net_usd > 0 else 0,
                        'reason': exit_reason
                    })
                    in_pos = False
                continue
                
            # Signal Evaluation
            rb, rs = row['rel_buy'], row['rel_sell']
            raw_b, raw_s = row['raw_buy'], row['raw_sell']
            action = None
            
            if use_raw_threshold:
                if raw_b >= min_raw_buy and rb >= min_rel_prob and rb > rs:
                    action = 'BUY'
                elif raw_s >= min_raw_sell and rs >= min_rel_prob and rs > rb:
                    action = 'SELL'
            else:
                if rb >= min_rel_prob and rb > rs:
                    action = 'BUY'
                elif rs >= min_rel_prob and rs > rb:
                    action = 'SELL'
                    
            if not action:
                continue
                
            # Guards
            if use_trend_guard:
                if action == 'BUY' and not row['trend_bullish']:
                    continue
                if action == 'SELL' and not row['trend_bearish']:
                    continue
                    
            if use_wick_guard:
                if action == 'BUY' and (row['upper_wick_pct'] >= wick_threshold or row['prev_upper_wick_pct'] >= wick_threshold):
                    continue
                if action == 'SELL' and (row['lower_wick_pct'] >= wick_threshold or row['prev_lower_wick_pct'] >= wick_threshold):
                    continue
                    
            if use_overext_guard:
                rsi = row['rsi_14']
                dist_atr = row['dist_ema50_atr']
                bb_pct = row['bb_pct']
                if action == 'BUY' and (rsi > 70 or dist_atr > 2.0 or bb_pct > 1.05):
                    continue
                if action == 'SELL' and (rsi < 30 or dist_atr > 2.0 or bb_pct < -0.05):
                    continue
                    
            if use_adx_guard:
                if row['adx_14'] < min_adx:
                    continue
                    
            entry_price = row['close']
            target_tp = entry_price + (sym_tp * pip_size) if action == 'BUY' else entry_price - (sym_tp * pip_size)
            current_sl = entry_price - (sym_sl * pip_size) if action == 'BUY' else entry_price + (sym_sl * pip_size)
            be_locked = False
            in_pos = True
            pos_dir = action
            entry_idx = i
            
    res = pd.DataFrame(trades)
    if len(res) == 0:
        return {'trades': 0, 'win_rate': 0.0, 'net_usd': 0.0, 'pf': 0.0, 'net_pips': 0.0, 'max_dd': 0.0, 'avg_trade': 0.0}
        
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
        'max_dd': round(max_dd, 2),
        'avg_trade': round(net_usd / len(res), 3)
    }

print("\n🚀 Running Multi-Scenario Tests...")

scenarios = [
    {
        "name": "0. Baseline Live Config (No Raw Threshold, No Guards)",
        "raw_th": False, "raw_b": 0.0, "raw_s": 0.0, "rel": 0.50,
        "trend": False, "wick": False, "w_th": 0.5, "over": False, "adx_g": False, "adx": 10,
        "tp": 5.0, "sl": 8.0, "be_trig": 99.0, "be_lock": 0.0, "hold": 9
    },
    {
        "name": "1. Raw Score Calibration Only (Buy>=0.20, Sell>=0.28)",
        "raw_th": True, "raw_b": 0.20, "raw_s": 0.28, "rel": 0.52,
        "trend": False, "wick": False, "w_th": 0.5, "over": False, "adx_g": False, "adx": 10,
        "tp": 6.5, "sl": 6.5, "be_trig": 3.0, "be_lock": 1.2, "hold": 6
    },
    {
        "name": "2. Raw Score + Trend Guard",
        "raw_th": True, "raw_b": 0.20, "raw_s": 0.28, "rel": 0.52,
        "trend": True, "wick": False, "w_th": 0.5, "over": False, "adx_g": False, "adx": 10,
        "tp": 6.5, "sl": 6.5, "be_trig": 3.0, "be_lock": 1.2, "hold": 6
    },
    {
        "name": "3. Raw Score + Trend + Wick Guard (>=45%)",
        "raw_th": True, "raw_b": 0.20, "raw_s": 0.28, "rel": 0.52,
        "trend": True, "wick": True, "w_th": 0.45, "over": False, "adx_g": False, "adx": 10,
        "tp": 6.5, "sl": 6.5, "be_trig": 3.0, "be_lock": 1.2, "hold": 6
    },
    {
        "name": "4. Raw Score + All 4 Guards (Balanced)",
        "raw_th": True, "raw_b": 0.20, "raw_s": 0.28, "rel": 0.52,
        "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16,
        "tp": 6.5, "sl": 6.5, "be_trig": 3.0, "be_lock": 1.2, "hold": 6
    },
    {
        "name": "5. High Edge Precision (Buy>=0.22, Sell>=0.30, All Guards)",
        "raw_th": True, "raw_b": 0.22, "raw_s": 0.30, "rel": 0.54,
        "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16,
        "tp": 7.0, "sl": 6.0, "be_trig": 3.2, "be_lock": 1.2, "hold": 6
    },
    {
        "name": "6. Profit Maximizer (TP 8.5 / SL 5.5 / BE 3.0 / All Guards)",
        "raw_th": True, "raw_b": 0.20, "raw_s": 0.28, "rel": 0.52,
        "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16,
        "tp": 8.5, "sl": 5.5, "be_trig": 3.0, "be_lock": 1.2, "hold": 7
    },
    {
        "name": "7. Ultra Precision Sniper (Buy>=0.25, Sell>=0.32, All Guards)",
        "raw_th": True, "raw_b": 0.25, "raw_s": 0.32, "rel": 0.55,
        "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16,
        "tp": 8.0, "sl": 5.5, "be_trig": 3.0, "be_lock": 1.2, "hold": 6
    },
]

summary_rows = []
for sc in scenarios:
    res = run_simulation(
        df,
        use_raw_threshold=sc['raw_th'],
        min_raw_buy=sc['raw_b'],
        min_raw_sell=sc['raw_s'],
        min_rel_prob=sc['rel'],
        use_trend_guard=sc['trend'],
        use_wick_guard=sc['wick'],
        wick_threshold=sc['w_th'],
        use_overext_guard=sc['over'],
        use_adx_guard=sc['adx_g'],
        min_adx=sc['adx'],
        tp_pips=sc['tp'],
        sl_pips=sc['sl'],
        be_trigger_pips=sc['be_trig'],
        be_lock_pips=sc['be_lock'],
        max_hold_bars=sc['hold']
    )
    summary_rows.append({**sc, **res})

out_df = pd.DataFrame(summary_rows)

print("\n" + "=" * 120)
print(f"{'Strategy Name':55} | {'Trades':>6} | {'Win Rate':>8} | {'Net USD':>10} | {'PF':>5} | {'Avg/Trade':>9} | {'Max DD':>8}")
print("=" * 120)
for _, r in out_df.iterrows():
    print(f"{r['name']:55} | {r['trades']:6d} | {r['win_rate']:7.2f}% | ${r['net_usd']:9.2f} | {r['pf']:5.2f} | ${r['avg_trade']:8.3f} | ${r['max_dd']:7.2f}")
print("=" * 120)
