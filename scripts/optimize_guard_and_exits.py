import os
import sys
import itertools
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
print(f"Loaded {len(df):,} bars across symbols: {df['symbol'].unique().tolist()}")

# Load model
bundle = joblib.load(MODEL_PATH)
buy_model = bundle['buy_model']
sell_model = bundle['sell_model']
feature_cols = bundle['features']
print(f"Model Version: {bundle.get('version', 'unknown')}")

# Feature calculations
df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
if 'csm_spread' not in df.columns: df['csm_spread'] = 0.0
if 'h1_trend_slope' not in df.columns: df['h1_trend_slope'] = 0.0
if 'spread_to_atr' not in df.columns:
    df['spread_to_atr'] = np.where(df['is_jpy'] == 1.0, 0.02, 0.00015) / (df['atr_14'] + 1e-12)

dt = pd.to_datetime(df['time'], errors='coerce')
hrs = dt.dt.hour + (dt.dt.minute / 60.0)
df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)

# Custom Indicators for Guards
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
df['macd_positive'] = df['macd_hist'] > 0

# Predict Model Probabilities
print("🧠 Generating ML Predictions...")
X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
prob_buy = buy_model.predict_proba(X)[:, 1]
prob_sell = sell_model.predict_proba(X)[:, 1]
tot_prob = prob_buy + prob_sell
df['rel_buy'] = np.where(tot_prob > 0, prob_buy / tot_prob, 0.5)
df['rel_sell'] = np.where(tot_prob > 0, prob_sell / tot_prob, 0.5)
df['conf_buy'] = prob_buy
df['conf_sell'] = prob_sell

print("✅ Data prep ready. Starting Strategy & Guard Optimization...")

def evaluate_strategy(
    df_data,
    ml_threshold=0.55,
    use_trend_filter=True,
    wick_threshold=0.45,
    use_wick_guard=True,
    use_overext_guard=True,
    min_adx=16,
    use_adx_guard=True,
    tp_pips=10.0,
    sl_pips=7.0,
    be_trigger_pips=3.5,
    be_lock_pips=0.8,
    use_trailing=False,
    trail_dist_pips=3.0,
    max_hold_bars=12
):
    trades = []
    
    for symbol, sym_df in df_data.groupby('symbol'):
        sym_df = sym_df.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_size = 0.01 if is_jpy else 0.0001
        spread_pips = 1.6 if is_jpy else 1.1
        pip_val = 0.07 if is_jpy else 0.10
        
        # Scale pips for JPY
        sym_tp_pips = tp_pips * (1.4 if is_jpy else 1.0)
        sym_sl_pips = sl_pips * (1.4 if is_jpy else 1.0)
        sym_be_trigger = be_trigger_pips * (1.3 if is_jpy else 1.0)
        sym_be_lock = be_lock_pips * (1.3 if is_jpy else 1.0)
        sym_trail_dist = trail_dist_pips * (1.3 if is_jpy else 1.0)
        
        in_pos = False
        pos_dir = None
        entry_price = 0.0
        current_sl = 0.0
        target_tp = 0.0
        peak_profit_pips = 0.0
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
                    peak_profit_pips = max(peak_profit_pips, profit_pips)
                    
                    # 1. TP hit
                    if (curr_high - spread_pips * pip_size) >= target_tp:
                        exit_price = target_tp
                        exit_reason = 'TP'
                    # 2. SL hit
                    elif curr_low <= current_sl:
                        exit_price = current_sl
                        exit_reason = 'BE_WIN' if be_locked and current_sl >= entry_price else 'SL'
                    # 3. Dynamic Trailing
                    elif use_trailing and peak_profit_pips >= sym_be_trigger:
                        trail_sl = entry_price + ((peak_profit_pips - sym_trail_dist) * pip_size)
                        if trail_sl > current_sl:
                            current_sl = trail_sl
                            be_locked = True
                    # 4. Break-Even Lock
                    elif (not be_locked) and profit_pips >= sym_be_trigger:
                        current_sl = entry_price + (sym_be_lock * pip_size)
                        be_locked = True
                    # 5. Time expiration
                    elif hold_bars >= max_hold_bars:
                        exit_price = curr_close
                        exit_reason = 'TIME'
                else: # SELL
                    profit_pips = (entry_price - curr_low) / pip_size
                    peak_profit_pips = max(peak_profit_pips, profit_pips)
                    
                    if (curr_low + spread_pips * pip_size) <= target_tp:
                        exit_price = target_tp
                        exit_reason = 'TP'
                    elif (curr_high + spread_pips * pip_size) >= current_sl:
                        exit_price = current_sl
                        exit_reason = 'BE_WIN' if be_locked and current_sl <= entry_price else 'SL'
                    elif use_trailing and peak_profit_pips >= sym_be_trigger:
                        trail_sl = entry_price - ((peak_profit_pips - sym_trail_dist) * pip_size)
                        if trail_sl < current_sl:
                            current_sl = trail_sl
                            be_locked = True
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
                
            # Signal Detection
            rel_buy, rel_sell = row['rel_buy'], row['rel_sell']
            action = None
            if rel_buy >= ml_threshold and rel_buy > rel_sell:
                action = 'BUY'
            elif rel_sell >= ml_threshold and rel_sell > rel_buy:
                action = 'SELL'
                
            if not action:
                continue
                
            # Guard 1: Trend Alignment Filter
            if use_trend_filter:
                if action == 'BUY' and not row['trend_bullish']:
                    continue
                if action == 'SELL' and not row['trend_bearish']:
                    continue
                    
            # Guard 2: Wick Rejection Filter
            if use_wick_guard:
                if action == 'BUY' and (row['upper_wick_pct'] >= wick_threshold or row['prev_upper_wick_pct'] >= wick_threshold):
                    continue
                if action == 'SELL' and (row['lower_wick_pct'] >= wick_threshold or row['prev_lower_wick_pct'] >= wick_threshold):
                    continue
                    
            # Guard 3: Overextended / Exhaustion Guard
            if use_overext_guard:
                rsi = row['rsi_14']
                dist_atr = row['dist_ema50_atr']
                bb_pct = row['bb_pct']
                if action == 'BUY' and (rsi > 70 or dist_atr > 2.0 or bb_pct > 1.05):
                    continue
                if action == 'SELL' and (rsi < 30 or dist_atr > 2.0 or bb_pct < -0.05):
                    continue
                    
            # Guard 4: ADX / Chop Filter
            if use_adx_guard:
                if row['adx_14'] < min_adx:
                    continue
                    
            # Entry setup
            entry_price = row['close']
            target_tp = entry_price + (sym_tp_pips * pip_size) if action == 'BUY' else entry_price - (sym_tp_pips * pip_size)
            current_sl = entry_price - (sym_sl_pips * pip_size) if action == 'BUY' else entry_price + (sym_sl_pips * pip_size)
            peak_profit_pips = 0.0
            be_locked = False
            in_pos = True
            pos_dir = action
            entry_idx = i
            
    res = pd.DataFrame(trades)
    if len(res) == 0:
        return {'trades': 0, 'win_rate': 0.0, 'net_usd': 0.0, 'pf': 0.0, 'net_pips': 0.0, 'max_dd': 0.0}
        
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
        'avg_win': round(wins['usd'].mean(), 2) if len(wins) > 0 else 0,
        'avg_loss': round(losses['usd'].mean(), 2) if len(losses) > 0 else 0
    }

# Run Grid Search across strategy & guard combinations
print("\n🔍 Running Systematic Search for Best Guard & Parameter Set...")

results = []

test_matrix = [
    # Baseline comparison
    {"label": "1. Baseline (Raw Model, No Guards, 1:1 RR)", "ml": 0.52, "trend": False, "wick": False, "w_th": 0.5, "over": False, "adx_g": False, "adx": 14, "tp": 7.0, "sl": 7.0, "be": 99.0, "trail": False},
    
    # Testing Trend Guard Impact
    {"label": "2. Trend Alignment Guard Only", "ml": 0.52, "trend": True, "wick": False, "w_th": 0.5, "over": False, "adx_g": False, "adx": 14, "tp": 7.0, "sl": 7.0, "be": 99.0, "trail": False},
    
    # Testing Dynamic BE with Trend Guard
    {"label": "3. Trend + Dynamic BE (+3.0 BE Lock)", "ml": 0.52, "trend": True, "wick": False, "w_th": 0.5, "over": False, "adx_g": False, "adx": 14, "tp": 8.0, "sl": 6.5, "be": 3.0, "trail": False},
    
    # Testing Full Guards with Positive R:R (TP 10, SL 6)
    {"label": "4. All Guards + Positive R:R (TP 10 / SL 6)", "ml": 0.53, "trend": True, "wick": True, "w_th": 0.50, "over": True, "adx_g": True, "adx": 16, "tp": 10.0, "sl": 6.0, "be": 3.5, "trail": False},
    
    # Testing Higher ML Confidence Thresholds (0.55, 0.57, 0.60)
    {"label": "5. High Edge ML (>=0.56) + Full Guards", "ml": 0.56, "trend": True, "wick": True, "w_th": 0.50, "over": True, "adx_g": True, "adx": 16, "tp": 10.0, "sl": 6.0, "be": 3.5, "trail": False},
    {"label": "6. High Edge ML (>=0.58) + Full Guards", "ml": 0.58, "trend": True, "wick": True, "w_th": 0.50, "over": True, "adx_g": True, "adx": 16, "tp": 10.0, "sl": 6.0, "be": 3.5, "trail": False},
    
    # Testing Trailing Stop (Let Winners Run)
    {"label": "7. Trailing Stop (TP 14, SL 6, Trail 3 pips)", "ml": 0.54, "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16, "tp": 14.0, "sl": 6.0, "be": 3.0, "trail": True},
    {"label": "8. Trailing Stop (TP 18, SL 7, Trail 4 pips)", "ml": 0.55, "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 18, "tp": 18.0, "sl": 7.0, "be": 3.5, "trail": True},

    # Testing Scalper Sweet Spot (TP 6.5, SL 5.5, BE 2.5)
    {"label": "9. Scalper Pro (TP 6.5 / SL 5.0 / BE 2.2 / ML>=0.55)", "ml": 0.55, "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16, "tp": 6.5, "sl": 5.0, "be": 2.2, "trail": False},
    {"label": "10. Scalper Pro (TP 7.5 / SL 5.5 / BE 2.5 / ML>=0.56)", "ml": 0.56, "trend": True, "wick": True, "w_th": 0.45, "over": True, "adx_g": True, "adx": 16, "tp": 7.5, "sl": 5.5, "be": 2.5, "trail": False},
]

for t in test_matrix:
    s = evaluate_strategy(
        df,
        ml_threshold=t['ml'],
        use_trend_filter=t['trend'],
        wick_threshold=t['w_th'],
        use_wick_guard=t['wick'],
        use_overext_guard=t['over'],
        min_adx=t['adx'],
        use_adx_guard=t['adx_g'],
        tp_pips=t['tp'],
        sl_pips=t['sl'],
        be_trigger_pips=t['be'],
        be_lock_pips=0.6,
        use_trailing=t['trail'],
        trail_dist_pips=3.5 if 'trail_dist' not in t else t['trail_dist'],
        max_hold_bars=12
    )
    results.append({**t, **s})

res_df = pd.DataFrame(results)

print("\n" + "=" * 115)
print(f"{'Strategy Configuration':50} | {'Trades':>6} | {'WR (%)':>7} | {'Net USD':>10} | {'PF':>5} | {'Max DD':>8}")
print("=" * 115)
for idx, r in res_df.iterrows():
    print(f"{r['label']:50} | {r['trades']:6d} | {r['win_rate']:6.2f}% | ${r['net_usd']:9.2f} | {r['pf']:5.2f} | ${r['max_dd']:7.2f}")
print("=" * 115)
