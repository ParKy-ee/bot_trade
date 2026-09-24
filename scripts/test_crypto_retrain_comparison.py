import os
import sys
import json
import urllib.request
import warnings
import numpy as np
import pandas as pd
import joblib
from lightgbm import LGBMClassifier
from xgboost import XGBClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, average_precision_score

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_DATA = os.path.join(ROOT_DIR, "data", "dataset_crypto_m5.csv")
MODEL_PATH = os.path.join(ROOT_DIR, "python", "models", "crypto_m5_model.joblib")

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'ema_spread_50_200', 'macd_hist',
    'volume_ratio', 'bb_width',
    'btc_ret_5', 'btc_corr_divergence', 'is_weekend',
    'vwap_distance_pct', 'distance_to_swing_high_low', 'funding_window_proximity'
]

print("📂 [1/4] Loading base dataset and current production model...")
df_base = pd.read_csv(BASE_DATA).dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).copy()
curr_bundle = joblib.load(MODEL_PATH)
curr_version = curr_bundle.get("version", "v2.0.0")
print(f"Current Model Version: {curr_version}")

print("🌐 [2/4] Fetching latest live trade results from DB...")
url = 'http://localhost:3000/api/trade-results?market=crypto&ready_for_retrain=true&limit=5000'
try:
    req = urllib.request.Request(url, headers={'User-Agent': 'trade-bot-crypto-evaluator'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        rows = json.loads(resp.read().decode('utf-8'))
except Exception as e:
    print(f"Error loading trade results: {e}")
    rows = []

live_rows = []
for r in rows:
    try:
        meta = json.loads(r.get('prediction_meta') or '{}')
        f = meta.get('features') or {}
        if r.get('action') not in ('BUY', 'SELL') or r.get('is_win') is None:
            continue
        item = {k: float(f.get(k, 0.0) if f.get(k) is not None else 0.0) for k in FEATURE_COLS}
        item['target_buy'] = int(r['action'] == 'BUY' and int(r['is_win']) == 1)
        item['target_sell'] = int(r['action'] == 'SELL' and int(r['is_win']) == 1)
        live_rows.append(item)
    except Exception:
        continue

df_live = pd.DataFrame(live_rows)
print(f"Loaded {len(df_live)} feature-complete closed trades from live/shadow execution.")

print("🧠 [3/4] Training candidate model with combined dataset (isolated, not overwriting)...")
live_samples = pd.concat([df_live[FEATURE_COLS + ['target_buy', 'target_sell']]] * 5, ignore_index=True) if len(df_live) > 0 else pd.DataFrame()
combined = pd.concat([df_base[FEATURE_COLS + ['target_buy', 'target_sell']], live_samples], ignore_index=True)

# Train-test split for evaluation
split_idx = int(len(combined) * 0.8)
train = combined.iloc[:split_idx]
test = combined.iloc[split_idx:]

def fit_tri_ensemble(X_tr, y_tr):
    lgb = LGBMClassifier(n_estimators=130, learning_rate=0.035, max_depth=5, num_leaves=25, random_state=42, verbose=-1)
    xgb = XGBClassifier(n_estimators=120, learning_rate=0.04, max_depth=4, random_state=42, eval_metric='logloss', verbosity=0)
    rf = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42, n_jobs=1)
    lgb.fit(X_tr, y_tr)
    xgb.fit(X_tr, y_tr)
    rf.fit(X_tr, y_tr)
    return lgb, xgb, rf

def predict_ensemble(lgb, xgb, rf, X_data):
    p1 = lgb.predict_proba(X_data)[:, 1]
    p2 = xgb.predict_proba(X_data)[:, 1]
    p3 = rf.predict_proba(X_data)[:, 1]
    return 0.40 * p1 + 0.35 * p2 + 0.25 * p3

cand_lgb_b, cand_xgb_b, cand_rf_b = fit_tri_ensemble(train[FEATURE_COLS], train['target_buy'])
cand_lgb_s, cand_xgb_s, cand_rf_s = fit_tri_ensemble(train[FEATURE_COLS], train['target_sell'])

# Current model predictions
curr_prob_b = predict_ensemble(curr_bundle['lgb_buy'], curr_bundle['xgb_buy'], curr_bundle['rf_buy'], test[FEATURE_COLS])
curr_prob_s = predict_ensemble(curr_bundle['lgb_sell'], curr_bundle['xgb_sell'], curr_bundle['rf_sell'], test[FEATURE_COLS])

# Candidate model predictions
cand_prob_b = predict_ensemble(cand_lgb_b, cand_xgb_b, cand_rf_b, test[FEATURE_COLS])
cand_prob_s = predict_ensemble(cand_lgb_s, cand_xgb_s, cand_rf_s, test[FEATURE_COLS])

def calc_auc(y_true, y_prob):
    try:
        return roc_auc_score(y_true, y_prob), average_precision_score(y_true, y_prob)
    except Exception:
        return 0.5, 0.0

roc_b_curr, pr_b_curr = calc_auc(test['target_buy'], curr_prob_b)
roc_s_curr, pr_s_curr = calc_auc(test['target_sell'], curr_prob_s)
roc_b_cand, pr_b_cand = calc_auc(test['target_buy'], cand_prob_b)
roc_s_cand, pr_s_cand = calc_auc(test['target_sell'], cand_prob_s)

print("\n" + "=" * 80)
print("📊 OUT-OF-SAMPLE MODEL METRICS COMPARISON (Test Set):")
print("=" * 80)
print(f"{'Metric':30} | {'Current Model (' + curr_version + ')':>22} | {'Retrained Candidate':>20} | {'Delta':>10}")
print("-" * 88)
print(f"{'ROC-AUC (BUY)':30} | {roc_b_curr:22.4f} | {roc_b_cand:20.4f} | {roc_b_cand - roc_b_curr:+10.4f}")
print(f"{'PR-AUC (BUY)':30} | {pr_b_curr:22.4f} | {pr_b_cand:20.4f} | {pr_b_cand - pr_b_curr:+10.4f}")
print(f"{'ROC-AUC (SELL)':30} | {roc_s_curr:22.4f} | {roc_s_cand:20.4f} | {roc_s_cand - roc_s_curr:+10.4f}")
print(f"{'PR-AUC (SELL)':30} | {pr_s_curr:22.4f} | {pr_s_cand:20.4f} | {pr_s_cand - pr_s_curr:+10.4f}")
print("=" * 88)

print("\n🚀 [4/4] Running Full Side-by-Side Backtest Simulation across BTC, ETH, SOL...")

# Compute predictions across entire dataset for backtest
X_all = df_base[FEATURE_COLS].copy().replace([np.inf, -np.inf], np.nan).fillna(0.0)

df_base['curr_raw_b'] = predict_ensemble(curr_bundle['lgb_buy'], curr_bundle['xgb_buy'], curr_bundle['rf_buy'], X_all)
df_base['curr_raw_s'] = predict_ensemble(curr_bundle['lgb_sell'], curr_bundle['xgb_sell'], curr_bundle['rf_sell'], X_all)

df_base['cand_raw_b'] = predict_ensemble(cand_lgb_b, cand_xgb_b, cand_rf_b, X_all)
df_base['cand_raw_s'] = predict_ensemble(cand_lgb_s, cand_xgb_s, cand_rf_s, X_all)

# Candle anatomy
df_base['range'] = df_base['high'] - df_base['low'] + 1e-9
df_base['upper_wick'] = df_base['high'] - df_base[['open', 'close']].max(axis=1)
df_base['lower_wick'] = df_base[['open', 'close']].min(axis=1) - df_base['low']
df_base['upper_wick_pct'] = df_base['upper_wick'] / df_base['range']
df_base['lower_wick_pct'] = df_base['lower_wick'] / df_base['range']
df_base['prev_upper_wick_pct'] = df_base.groupby('symbol')['upper_wick_pct'].shift(1).fillna(0.0)
df_base['prev_lower_wick_pct'] = df_base.groupby('symbol')['lower_wick_pct'].shift(1).fillna(0.0)

CRYPTO_SPECS = {
    'BTCUSDT': {'spread': 22.0, 'val': 0.01, 'sl': 350.0},
    'ETHUSDT': {'spread': 2.0, 'val': 0.02, 'sl': 25.0},
    'SOLUSDT': {'spread': 0.22, 'val': 0.05, 'sl': 2.50}
}

def run_sim(model_col_b, model_col_s, min_th=0.22, hold_bars=6):
    trades = []
    for symbol, g in df_base.groupby('symbol'):
        g = g.reset_index(drop=True)
        spec = CRYPTO_SPECS[symbol]
        spread = spec['spread']
        val = spec['val']
        sl_dist = spec['sl']
        
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
                loss = (entry_p - curr_low) if pos_dir == 'BUY' else (curr_high - entry_p)
                if loss >= sl_dist:
                    exit_p = entry_p - sl_dist if pos_dir == 'BUY' else entry_p + sl_dist
                elif hold >= hold_bars:
                    exit_p = curr_close
                if exit_p is not None:
                    gross = (exit_p - entry_p) if pos_dir == 'BUY' else (entry_p - exit_p)
                    net = gross - spread
                    trades.append({'sym': symbol, 'usd': net * val, 'win': 1 if net > 0 else 0})
                    in_pos = False
                continue
                
            raw_b = row[model_col_b]
            raw_s = row[model_col_s]
            
            if raw_b >= min_th and raw_b > raw_s:
                if row['upper_wick_pct'] >= 0.45 or row['prev_upper_wick_pct'] >= 0.45: continue
                in_pos = True; pos_dir = 'BUY'; entry_p = row['close']; entry_i = i
            elif raw_s >= min_th and raw_s > raw_b:
                if row['lower_wick_pct'] >= 0.45 or row['prev_lower_wick_pct'] >= 0.45: continue
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
    return {
        'trades': len(res),
        'win_rate': round(wr, 2),
        'net_usd': round(net_usd, 2),
        'pf': round(pf, 2),
        'max_dd': round(max_dd, 2)
    }

res_curr = run_sim('curr_raw_b', 'curr_raw_s', min_th=0.22, hold_bars=6)
res_cand = run_sim('cand_raw_b', 'cand_raw_s', min_th=0.22, hold_bars=6)

print("\n" + "=" * 95)
print("🏆 SIMULATION COMPARISON: CURRENT MODEL vs RETRAINED CANDIDATE MODEL")
print("=" * 95)
print(f"{'Performance Metric':30} | {'Current Model (' + curr_version + ')':>22} | {'Retrained Candidate':>20} | {'Delta':>12}")
print("-" * 95)
diff_trades = res_cand['trades'] - res_curr['trades']
diff_wr = res_cand['win_rate'] - res_curr['win_rate']
diff_usd = res_cand['net_usd'] - res_curr['net_usd']
diff_pf = res_cand['pf'] - res_curr['pf']
diff_dd = res_cand['max_dd'] - res_curr['max_dd']

print(f"{'Total Trades':30} | {res_curr['trades']:22d} | {res_cand['trades']:20d} | {diff_trades:+12d}")
print(f"{'Win Rate (%)':30} | {res_curr['win_rate']:21.2f}% | {res_cand['win_rate']:19.2f}% | {diff_wr:+11.2f}%")
print(f"{'Net USD ($)':30} | ${res_curr['net_usd']:21.2f} | ${res_cand['net_usd']:19.2f} | ${diff_usd:+11.2f}")
print(f"{'Profit Factor (PF)':30} | {res_curr['pf']:22.2f} | {res_cand['pf']:20.2f} | {diff_pf:+12.2f}")
print(f"{'Max Drawdown ($)':30} | ${res_curr['max_dd']:21.2f} | ${res_cand['max_dd']:19.2f} | ${diff_dd:+11.2f}")
print("=" * 95)
