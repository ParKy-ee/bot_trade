import os
import sys
import json
import warnings
import numpy as np
import pandas as pd
import joblib

# Windows UTF-8 stdout configuration
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, "python", "models", "forex_challenger_model.joblib")
DATA_PATH = os.path.join(ROOT_DIR, "data", "dataset_forex_m5.csv")

if not os.path.exists(MODEL_PATH):
    print(f"Error: Model not found at {MODEL_PATH}")
    sys.exit(1)

if not os.path.exists(DATA_PATH):
    print(f"Error: Data file not found at {DATA_PATH}")
    sys.exit(1)

print("📂 Loading Forex M5 dataset...")
df = pd.read_csv(DATA_PATH)
print(f"Loaded {len(df):,} bars across symbols: {df['symbol'].unique().tolist()}")

# Load active model
print(f"🤖 Loading current active model from {MODEL_PATH}...")
bundle = joblib.load(MODEL_PATH)
buy_model = bundle['buy_model']
sell_model = bundle['sell_model']
feature_cols = bundle['features']
model_version = bundle.get('version', 'unknown')
print(f"Active Model Version: {model_version}")

# Ensure required features exist
df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
if 'csm_spread' not in df.columns:
    df['csm_spread'] = 0.0
if 'h1_trend_slope' not in df.columns:
    df['h1_trend_slope'] = 0.0
if 'spread_to_atr' not in df.columns:
    df['spread_to_atr'] = np.where(df['is_jpy'] == 1.0, 0.02, 0.00015) / (df['atr_14'] + 1e-12)

# Time features
dt = pd.to_datetime(df['time'], errors='coerce')
hrs = dt.dt.hour + (dt.dt.minute / 60.0)
df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)

# Candle anatomy features (Wick and Body)
df['range'] = df['high'] - df['low'] + 1e-9
df['body'] = (df['close'] - df['open']).abs()
df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
df['upper_wick_pct'] = df['upper_wick'] / df['range']
df['lower_wick_pct'] = df['lower_wick'] / df['range']

# Shift previous bar wick properties
df['prev_upper_wick_pct'] = df.groupby('symbol')['upper_wick_pct'].shift(1).fillna(0.0)
df['prev_lower_wick_pct'] = df.groupby('symbol')['lower_wick_pct'].shift(1).fillna(0.0)
df['dist_ema50_atr'] = (df['close'] - df['ema_50']).abs() / (df['atr_14'] + 1e-9)

# Generate ML Probabilities
print("🧠 Generating Model Predictions...")
X = df[feature_cols].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)
prob_buy = buy_model.predict_proba(X)[:, 1]
prob_sell = sell_model.predict_proba(X)[:, 1]
tot_prob = prob_buy + prob_sell
df['rel_buy'] = np.where(tot_prob > 0, prob_buy / tot_prob, 0.5)
df['rel_sell'] = np.where(tot_prob > 0, prob_sell / tot_prob, 0.5)

# Backtest Simulation Engine
def run_simulation(df_data, use_guards=False):
    trades = []
    
    # Iterate by symbol
    for symbol, sym_df in df_data.groupby('symbol'):
        sym_df = sym_df.reset_index(drop=True)
        is_jpy = 'JPY' in str(symbol)
        pip_size = 0.01 if is_jpy else 0.0001
        spread_pips = 1.8 if is_jpy else 1.2
        min_tp_pips = 5.5 if is_jpy else 3.5
        min_sl_pips = 11.0 if is_jpy else 7.5
        pip_val = 0.07 if is_jpy else 0.10 # per 0.01 lot
        
        in_pos = False
        pos_dir = None
        entry_price = 0.0
        tp_price = 0.0
        sl_price = 0.0
        entry_idx = 0
        
        n = len(sym_df)
        for i in range(20, n - 10):
            row = sym_df.iloc[i]
            
            if in_pos:
                # Check exit on current bar
                curr_high = row['high']
                curr_low = row['low']
                curr_close = row['close']
                hold_bars = i - entry_idx
                
                exit_price = None
                exit_reason = None
                
                if pos_dir == 'BUY':
                    # Conservative sequence: SL first, then TP
                    if curr_low <= sl_price:
                        exit_price = sl_price
                        exit_reason = 'SL'
                    elif (curr_high - spread_pips * pip_size) >= tp_price:
                        exit_price = tp_price
                        exit_reason = 'TP'
                    elif hold_bars >= 9: # 45 minutes
                        exit_price = curr_close
                        exit_reason = 'TIME'
                else: # SELL
                    if (curr_high + spread_pips * pip_size) >= sl_price:
                        exit_price = sl_price
                        exit_reason = 'SL'
                    elif (curr_low + spread_pips * pip_size) <= tp_price:
                        exit_price = tp_price
                        exit_reason = 'TP'
                    elif hold_bars >= 9:
                        exit_price = curr_close
                        exit_reason = 'TIME'
                
                if exit_price is not None:
                    # Calculate net pips and net USD
                    gross_pips = (exit_price - entry_price) / pip_size if pos_dir == 'BUY' else (entry_price - exit_price) / pip_size
                    net_pips = gross_pips - spread_pips
                    net_usd = net_pips * pip_val
                    
                    trades.append({
                        'symbol': symbol,
                        'dir': pos_dir,
                        'pips': net_pips,
                        'usd': net_usd,
                        'is_win': 1 if net_usd > 0 else 0,
                        'reason': exit_reason,
                        'hold_bars': hold_bars
                    })
                    in_pos = False
                continue
            
            # Entry logic
            rel_buy = row['rel_buy']
            rel_sell = row['rel_sell']
            atr = row['atr_14']
            rsi = row['rsi_14']
            adx = row['adx_14']
            
            action = None
            if rel_buy >= 0.52 and rel_buy > rel_sell:
                action = 'BUY'
            elif rel_sell >= 0.52 and rel_sell > rel_buy:
                action = 'SELL'
                
            if not action:
                continue
                
            # If use_guards is True, evaluate the 3 Moderate Quality Guards
            if use_guards:
                # Guard 1: Opposing Wick Rejection Filter (>= 50%)
                if action == 'BUY' and (row['prev_upper_wick_pct'] >= 0.50 or row['upper_wick_pct'] >= 0.50):
                    continue
                if action == 'SELL' and (row['prev_lower_wick_pct'] >= 0.50 or row['lower_wick_pct'] >= 0.50):
                    continue
                    
                # Guard 2: Exhaustion / Overextended Guard
                if action == 'BUY' and (rsi > 72 or row['dist_ema50_atr'] > 2.2):
                    continue
                if action == 'SELL' and (rsi < 28 or row['dist_ema50_atr'] > 2.2):
                    continue
                    
                # Guard 3: Sideways Chop Guard (ADX < 18)
                if adx < 18:
                    continue
            
            # Setup dynamic SL and TP
            entry_price = row['close']
            tp_dist = max(min_tp_pips * pip_size, 1.3 * atr)
            sl_dist = max(min_sl_pips * pip_size, 1.4 * atr)
            
            if action == 'BUY':
                tp_price = entry_price + tp_dist
                sl_price = entry_price - sl_dist
            else:
                tp_price = entry_price - tp_dist
                sl_price = entry_price + sl_dist
                
            in_pos = True
            pos_dir = action
            entry_idx = i
            
    return pd.DataFrame(trades)

print("\n🧪 [1/2] Running Baseline Backtest (Current Model WITHOUT Guards)...")
res_base = run_simulation(df, use_guards=False)

print("🧪 [2/2] Running Variant Backtest (Current Model WITH Moderate Guards)...")
res_guard = run_simulation(df, use_guards=True)

def calc_summary(res):
    if len(res) == 0:
        return {}
    n = len(res)
    wins = res[res['is_win'] == 1]
    losses = res[res['is_win'] == 0]
    win_rate = (len(wins) / n) * 100.0
    net_usd = res['usd'].sum()
    net_pips = res['pips'].sum()
    gross_win = wins['usd'].sum()
    gross_loss = abs(losses['usd'].sum()) if len(losses) > 0 else 1e-9
    pf = gross_win / gross_loss if gross_loss > 0 else 99.0
    avg_win = wins['usd'].mean() if len(wins) > 0 else 0.0
    avg_loss = losses['usd'].mean() if len(losses) > 0 else 0.0
    
    # Drawdown
    cum = res['usd'].cumsum()
    peak = cum.cummax()
    dd = peak - cum
    max_dd = dd.max()
    
    return {
        'total_trades': n,
        'wins': len(wins),
        'losses': len(losses),
        'win_rate': round(win_rate, 2),
        'net_usd': round(net_usd, 2),
        'net_pips': round(net_pips, 2),
        'profit_factor': round(pf, 2),
        'avg_win_usd': round(avg_win, 2),
        'avg_loss_usd': round(avg_loss, 2),
        'max_dd_usd': round(max_dd, 2)
    }

base_stats = calc_summary(res_base)
guard_stats = calc_summary(res_guard)

print("\n" + "=" * 70)
print("📊 BACKTEST COMPARISON RESULTS (Current Model vs Model + Guards)")
print("=" * 70)

diff_trades = guard_stats['total_trades'] - base_stats['total_trades']
pct_trade_reduction = ((base_stats['total_trades'] - guard_stats['total_trades']) / base_stats['total_trades']) * 100.0
diff_net_usd = guard_stats['net_usd'] - base_stats['net_usd']
diff_win_rate = guard_stats['win_rate'] - base_stats['win_rate']
diff_pf = guard_stats['profit_factor'] - base_stats['profit_factor']

comparison = [
    {"Metric": "Total Trades", "Baseline (No Guards)": base_stats['total_trades'], "With Guards": guard_stats['total_trades'], "Change": f"-{pct_trade_reduction:.1f}% ({diff_trades:+d})"},
    {"Metric": "Win Rate (%)", "Baseline (No Guards)": f"{base_stats['win_rate']}%", "With Guards": f"{guard_stats['win_rate']}%", "Change": f"{diff_win_rate:+.2f}%"},
    {"Metric": "Profit Factor (PF)", "Baseline (No Guards)": base_stats['profit_factor'], "With Guards": guard_stats['profit_factor'], "Change": f"{diff_pf:+.2f}"},
    {"Metric": "Net USD ($)", "Baseline (No Guards)": f"${base_stats['net_usd']}", "With Guards": f"${guard_stats['net_usd']}", "Change": f"${diff_net_usd:+.2f}"},
    {"Metric": "Net Pips", "Baseline (No Guards)": base_stats['net_pips'], "With Guards": guard_stats['net_pips'], "Change": f"{guard_stats['net_pips'] - base_stats['net_pips']:+.1f}"},
    {"Metric": "Avg Win / Avg Loss", "Baseline (No Guards)": f"${base_stats['avg_win_usd']} / ${base_stats['avg_loss_usd']}", "With Guards": f"${guard_stats['avg_win_usd']} / ${guard_stats['avg_loss_usd']}", "Change": "Better Expectancy"},
    {"Metric": "Max Drawdown ($)", "Baseline (No Guards)": f"${base_stats['max_dd_usd']}", "With Guards": f"${guard_stats['max_dd_usd']}", "Change": f"${guard_stats['max_dd_usd'] - base_stats['max_dd_usd']:+.2f}"}
]

print(json.dumps(comparison, indent=2))
print("=" * 70)
