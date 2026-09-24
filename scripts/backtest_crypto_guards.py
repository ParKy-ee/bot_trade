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
MODEL_PATH = os.path.join(ROOT_DIR, "python", "models", "crypto_m5_model.joblib")
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_crypto_m5.csv")

print("📂 Loading Crypto M5 dataset...")
df = pd.read_csv(DATA_PATH)

print("🤖 Loading Crypto Model...")
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
print("🧠 Generating Predictions...")
df['raw_buy'] = calc_ensemble(lgb_buy, xgb_buy, rf_buy, X)
df['raw_sell'] = calc_ensemble(lgb_sell, xgb_sell, rf_sell, X)
tot = df['raw_buy'] + df['raw_sell']
df['rel_buy'] = np.where(tot > 0, df['raw_buy'] / tot, 0.5)
df['rel_sell'] = np.where(tot > 0, df['raw_sell'] / tot, 0.5)

# Candle Anatomy
df['range'] = df['high'] - df['low'] + 1e-9
df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
df['upper_wick_pct'] = df['upper_wick'] / df['range']
df['lower_wick_pct'] = df['lower_wick'] / df['range']
df['prev_upper_wick_pct'] = df.groupby('symbol')['upper_wick_pct'].shift(1).fillna(0.0)
df['prev_lower_wick_pct'] = df.groupby('symbol')['lower_wick_pct'].shift(1).fillna(0.0)

# Typical XM Lot sizes, Spreads, and Pip/Point Values for Crypto:
# BTCUSD: lot 0.01, spread $20, val per $1 move = $0.01
# ETHUSD: lot 0.02, spread $1.80, val per $1 move = $0.02
# SOLUSD: lot 0.05, spread $0.20, val per $1 move = $0.05
CRYPTO_SPECS = {
    'BTCUSDT': {'lot': 0.01, 'spread': 22.0, 'val_per_point': 0.01, 'tp_usd': 200.0, 'sl_usd': 350.0},
    'ETHUSDT': {'lot': 0.02, 'spread': 2.0, 'val_per_point': 0.02, 'tp_usd': 12.0, 'sl_usd': 25.0},
    'SOLUSDT': {'lot': 0.05, 'spread': 0.22, 'val_per_point': 0.05, 'tp_usd': 1.20, 'sl_usd': 2.50}
}

def run_crypto_simulation(
    df_data,
    use_raw_filter=True,
    min_raw_buy=0.20,
    min_raw_sell=0.20,
    min_rel_prob=0.50,
    use_wick_guard=True,
    wick_thresh=0.45,
    use_overext_guard=True,
    hold_bars=6, # 6 bars M5 = 30 minutes
    use_quick_tp=True,
    tp_mult=1.0, # Multiplier for default TP
    sl_mult=1.0
):
    trades = []
    
    for symbol, g in df_data.groupby('symbol'):
        g = g.reset_index(drop=True)
        spec = CRYPTO_SPECS.get(symbol, {'lot': 0.01, 'spread': 20.0, 'val_per_point': 0.01, 'tp_usd': 100.0, 'sl_usd': 200.0})
        spread = spec['spread']
        val = spec['val_per_point']
        target_tp_dist = spec['tp_usd'] * tp_mult
        target_sl_dist = spec['sl_usd'] * sl_mult
        
        in_pos = False
        pos_dir = None
        entry_p = 0.0
        entry_i = 0
        n = len(g)
        
        for i in range(20, n - 10):
            row = g.iloc[i]
            
            if in_pos:
                hold = i - entry_i
                curr_high, curr_low, curr_close = row['high'], row['low'], row['close']
                exit_p = None
                exit_reason = None
                
                # Check Quick TP
                if use_quick_tp:
                    profit_dist = (curr_high - entry_p) if pos_dir == 'BUY' else (entry_p - curr_low)
                    if profit_dist >= target_tp_dist:
                        exit_p = entry_p + target_tp_dist if pos_dir == 'BUY' else entry_p - target_tp_dist
                        exit_reason = 'QUICK_TP'
                        
                # Check Safety SL
                if exit_p is None:
                    loss_dist = (entry_p - curr_low) if pos_dir == 'BUY' else (curr_high - entry_p)
                    if loss_dist >= target_sl_dist:
                        exit_p = entry_p - target_sl_dist if pos_dir == 'BUY' else entry_p + target_sl_dist
                        exit_reason = 'SAFETY_SL'
                        
                # Check Time Decay Expiration (Horizon)
                if exit_p is None and hold >= hold_bars:
                    exit_p = curr_close
                    exit_reason = 'HORIZON_EXPIRY'
                    
                if exit_p is not None:
                    gross_diff = (exit_p - entry_p) if pos_dir == 'BUY' else (entry_p - exit_p)
                    net_diff = gross_diff - spread
                    net_usd = net_diff * val
                    trades.append({
                        'sym': symbol,
                        'gross_diff': gross_diff,
                        'net_diff': net_diff,
                        'usd': net_usd,
                        'win': 1 if net_usd > 0 else 0,
                        'reason': exit_reason,
                        'hold': hold
                    })
                    in_pos = False
                continue
                
            # Signal Detection
            action = None
            rb, rs = row['rel_buy'], row['rel_sell']
            raw_b, raw_s = row['raw_buy'], row['raw_sell']
            
            if use_raw_filter:
                if raw_b >= min_raw_buy and rb >= min_rel_prob and rb > rs:
                    action = 'BUY'
                elif raw_s >= min_raw_sell and rs >= min_rel_prob and rs > rb:
                    action = 'SELL'
            else:
                if rb >= min_rel_prob and rb > rs:
                    action = 'BUY'
                elif rs >= min_rel_prob and rs > rb:
                    action = 'SELL'
                    
            if not action: continue
            
            # Guard 1: Wick Rejection Filter
            if use_wick_guard:
                if action == 'BUY' and (row['upper_wick_pct'] >= wick_thresh or row['prev_upper_wick_pct'] >= wick_thresh):
                    continue
                if action == 'SELL' and (row['lower_wick_pct'] >= wick_thresh or row['prev_lower_wick_pct'] >= wick_thresh):
                    continue
                    
            # Guard 2: Overextension Guard
            if use_overext_guard:
                rsi = row['rsi_14']
                if action == 'BUY' and rsi > 74: continue
                if action == 'SELL' and rsi < 26: continue
                
            in_pos = True
            pos_dir = action
            entry_p = row['close']
            entry_i = i
            
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
    tp_c = len(res[res['reason'] == 'QUICK_TP'])
    sl_c = len(res[res['reason'] == 'SAFETY_SL'])
    exp_c = len(res[res['reason'] == 'HORIZON_EXPIRY'])
    
    return {
        'trades': len(res),
        'win_rate': round(wr, 2),
        'net_usd': round(net_usd, 2),
        'pf': round(pf, 2),
        'max_dd': round(max_dd, 2),
        'tp_c': tp_c, 'sl_c': sl_c, 'exp_c': exp_c
    }

print("\n" + "=" * 125)
print("🚀 RUNNING SYSTEMATIC CRYPTO M5 BACKTEST & GUARD SIMULATION:")
print("=" * 125)

configs = [
    # 0. Baseline (Live settings: relative prob >= 0.50, no guards, standard TP/SL)
    {"name": "0. Baseline Live Config (No Raw Threshold, No Guards)", "raw_f": False, "mb": 0.0, "ms": 0.0, "rel": 0.50, "wick": False, "w_th": 0.5, "over": False, "hold": 12, "q_tp": False, "tp_m": 1.0, "sl_m": 1.0},
    
    # 1. Calibrated Probability Floor Only
    {"name": "1. Raw Score Floor Only (Buy>=0.18, Sell>=0.18)", "raw_f": True, "mb": 0.18, "ms": 0.18, "rel": 0.50, "wick": False, "w_th": 0.5, "over": False, "hold": 6, "q_tp": False, "tp_m": 1.0, "sl_m": 1.0},
    
    # 2. Raw Score Floor + Wick Rejection Guard (>= 45%)
    {"name": "2. Raw Score + Wick Rejection Guard (>=45%)", "raw_f": True, "mb": 0.18, "ms": 0.18, "rel": 0.50, "wick": True, "w_th": 0.45, "over": False, "hold": 6, "q_tp": False, "tp_m": 1.0, "sl_m": 1.0},
    
    # 3. Raw Score + Wick + Overextended Guard
    {"name": "3. Raw Score + Wick + Overextended Guard", "raw_f": True, "mb": 0.18, "ms": 0.18, "rel": 0.50, "wick": True, "w_th": 0.45, "over": True, "hold": 6, "q_tp": False, "tp_m": 1.0, "sl_m": 1.0},
    
    # 4. Adding Quick TP (Snatch profits when expansion hits target)
    {"name": "4. All Guards + Quick TP (Hold 6 bars / 30m)", "raw_f": True, "mb": 0.18, "ms": 0.18, "rel": 0.50, "wick": True, "w_th": 0.45, "over": True, "hold": 6, "q_tp": True, "tp_m": 1.0, "sl_m": 1.0},
    
    # 5. Higher Conviction Floor (Buy>=0.20, Sell>=0.20)
    {"name": "5. High Edge Conviction (Buy>=0.20, Sell>=0.20)", "raw_f": True, "mb": 0.20, "ms": 0.20, "rel": 0.52, "wick": True, "w_th": 0.45, "over": True, "hold": 6, "q_tp": True, "tp_m": 1.0, "sl_m": 1.0},
    
    # 6. High Edge Conviction + Wider TP (1.3x)
    {"name": "6. High Edge Conviction + Expanded TP (1.3x)", "raw_f": True, "mb": 0.20, "ms": 0.20, "rel": 0.52, "wick": True, "w_th": 0.45, "over": True, "hold": 6, "q_tp": True, "tp_m": 1.3, "sl_m": 1.0},
    
    # 7. Sniper Mode (Buy>=0.22, Sell>=0.22)
    {"name": "7. Sniper Mode (Buy>=0.22, Sell>=0.22, Hold 6)", "raw_f": True, "mb": 0.22, "ms": 0.22, "rel": 0.52, "wick": True, "w_th": 0.45, "over": True, "hold": 6, "q_tp": True, "tp_m": 1.2, "sl_m": 1.0},
]

print(f"{'Strategy Name':55} | {'Trades':>6} | {'Win Rate':>8} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>7} | {'Exits (TP/SL/Exp)':>17}")
print("-" * 125)

for c in configs:
    r = run_crypto_simulation(
        df,
        use_raw_filter=c['raw_f'],
        min_raw_buy=c['mb'],
        min_raw_sell=c['ms'],
        min_rel_prob=c['rel'],
        use_wick_guard=c['wick'],
        wick_thresh=c['w_th'],
        use_overext_guard=c['over'],
        hold_bars=c['hold'],
        use_quick_tp=c['q_tp'],
        tp_mult=c['tp_m'],
        sl_mult=c['sl_m']
    )
    exits_str = f"{r['tp_c']} / {r['sl_c']} / {r['exp_c']}"
    print(f"{c['name']:55} | {r['trades']:6d} | {r['win_rate']:7.2f}% | ${r['net_usd']:+9.2f} | {r['pf']:5.2f} | ${r['max_dd']:6.2f} | {exits_str:>17}")

print("=" * 125)
