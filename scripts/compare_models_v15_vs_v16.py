import os
import sys
import json
import joblib
import pandas as pd
import numpy as np
from sklearn.metrics import (
    roc_auc_score, average_precision_score, precision_score,
    recall_score, accuracy_score, f1_score, fbeta_score, log_loss
)

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'dataset_forex_m5.csv')
VERSIONS_DIR = os.path.join(ROOT_DIR, 'python', 'models', 'versions')

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'macd_hist', 'csm_spread', 'h1_trend_slope',
    'is_jpy', 'time_sin_hour', 'time_cos_hour', 'spread_to_atr'
]

def load_eval_data():
    df = pd.read_csv(DATA_PATH)
    atr_up = df['atr_pct'] * 1.5
    atr_dn = df['atr_pct'] * 1.0
    df['target_buy'] = np.where((df['target_ret_5'] >= atr_up) & (df['ret_1'] >= 0), 1, 0)
    df['target_sell'] = np.where((df['target_ret_5'] <= -atr_dn) & (df['ret_1'] <= 0), 1, 0)

    if 'csm_spread' not in df.columns:
        df['csm_spread'] = 0.0
    if 'h1_trend_slope' not in df.columns:
        df['h1_trend_slope'] = 0.0
    if 'is_jpy' not in df.columns:
        df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
    if 'time_sin_hour' not in df.columns or 'time_cos_hour' not in df.columns:
        dt = pd.to_datetime(df.get('time'), errors='coerce')
        hrs = dt.dt.hour + (dt.dt.minute / 60.0)
        df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
        df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)
    if 'spread_to_atr' not in df.columns:
        df['spread_to_atr'] = 0.02

    clean = df.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell', 'target_ret_5', 'atr_pct']).reset_index(drop=True)
    # Test set is the last 20%
    split = int(len(clean) * 0.8)
    return clean.iloc[split:].reset_index(drop=True)

def eval_tri_ensemble(bundle, test_df):
    X = test_df[FEATURE_COLS]
    # predict buy
    p_lgb_b = bundle['lgb_buy'].predict_proba(X)[:, 1]
    p_xgb_b = bundle['xgb_buy'].predict_proba(X)[:, 1]
    p_cat_b = bundle['cat_buy'].predict_proba(X)[:, 1]
    p_rf_b = bundle['rf_buy'].predict_proba(X)[:, 1]
    w = bundle.get('weights', {'lightgbm': 0.35, 'xgboost': 0.25, 'catboost': 0.25, 'random_forest': 0.15})
    prob_buy = w['lightgbm'] * p_lgb_b + w['xgboost'] * p_xgb_b + w['catboost'] * p_cat_b + w['random_forest'] * p_rf_b

    # predict sell
    p_lgb_s = bundle['lgb_sell'].predict_proba(X)[:, 1]
    p_xgb_s = bundle['xgb_sell'].predict_proba(X)[:, 1]
    p_cat_s = bundle['cat_sell'].predict_proba(X)[:, 1]
    p_rf_s = bundle['rf_sell'].predict_proba(X)[:, 1]
    prob_sell = w['lightgbm'] * p_lgb_s + w['xgboost'] * p_xgb_s + w['catboost'] * p_cat_s + w['random_forest'] * p_rf_s

    return prob_buy, prob_sell

def calc_metrics(y_true, y_prob, threshold=0.45):
    y_pred = (y_prob >= threshold).astype(int)
    auc = roc_auc_score(y_true, y_prob)
    pr_auc = average_precision_score(y_true, y_prob)
    prec = precision_score(y_true, y_pred, zero_division=0)
    rec = recall_score(y_true, y_pred, zero_division=0)
    acc = accuracy_score(y_true, y_pred)
    f1 = f1_score(y_true, y_pred, zero_division=0)
    f05 = fbeta_score(y_true, y_pred, beta=0.5, zero_division=0)
    loss = log_loss(y_true, y_prob)
    return {
        'auc': auc,
        'pr_auc': pr_auc,
        'precision': prec,
        'recall': rec,
        'accuracy': acc,
        'f1': f1,
        'f05': f05,
        'log_loss': loss,
        'signals_count': int(y_pred.sum())
    }

def main():
    print("=" * 80)
    print("📊 HEAD-TO-HEAD MODEL EVALUATION: Champion v1.5.0 vs v1.6.0")
    print("=" * 80)

    test_df = load_eval_data()
    print(f"Loaded {len(test_df):,} test samples for out-of-sample benchmarking.\n")

    v15_path = os.path.join(VERSIONS_DIR, 'forex_m5_model_v1.5.0.joblib')
    v16_path = os.path.join(VERSIONS_DIR, 'forex_m5_model_v1.6.0.joblib')

    if not os.path.exists(v15_path) or not os.path.exists(v16_path):
        print("Missing model joblib files.")
        return

    b15 = joblib.load(v15_path)
    b16 = joblib.load(v16_path)

    p_buy_15, p_sell_15 = eval_tri_ensemble(b15, test_df)
    p_buy_16, p_sell_16 = eval_tri_ensemble(b16, test_df)

    # Calculate metrics at threshold = 0.45
    m_buy_15 = calc_metrics(test_df['target_buy'], p_buy_15, 0.45)
    m_buy_16 = calc_metrics(test_df['target_buy'], p_buy_16, 0.45)

    m_sell_15 = calc_metrics(test_df['target_sell'], p_sell_15, 0.45)
    m_sell_16 = calc_metrics(test_df['target_sell'], p_sell_16, 0.45)

    # Simulated trading performance on test set
    # When signal >= 0.45: BUY -> profit = target_ret_5 / atr_pct; SELL -> profit = -target_ret_5 / atr_pct
    def sim_trades(p_buy, p_sell, threshold=0.45):
        trades = []
        for i in range(len(test_df)):
            pb = p_buy[i]
            ps = p_sell[i]
            ret = test_df['target_ret_5'].iloc[i]
            atr_pct = test_df['atr_pct'].iloc[i]
            
            if pb >= threshold and pb > ps:
                pnl_r = ret / (atr_pct + 1e-9)
                win = 1 if pnl_r >= 0.8 else (0 if pnl_r <= -0.8 else (1 if pnl_r > 0 else 0))
                trades.append({'action': 'BUY', 'pnl_r': pnl_r, 'win': win})
            elif ps >= threshold and ps > pb:
                pnl_r = -ret / (atr_pct + 1e-9)
                win = 1 if pnl_r >= 0.8 else (0 if pnl_r <= -0.8 else (1 if pnl_r > 0 else 0))
                trades.append({'action': 'SELL', 'pnl_r': pnl_r, 'win': win})
        
        tdf = pd.DataFrame(trades)
        if len(tdf) == 0:
            return {'total_trades': 0, 'win_rate': 0, 'total_r': 0, 'profit_factor': 0}
        
        wins = tdf[tdf['pnl_r'] > 0]['pnl_r'].sum()
        losses = abs(tdf[tdf['pnl_r'] < 0]['pnl_r'].sum())
        pf = wins / (losses + 1e-9)
        return {
            'total_trades': len(tdf),
            'win_rate': (tdf['win'] == 1).mean() * 100,
            'total_r': tdf['pnl_r'].sum(),
            'avg_r': tdf['pnl_r'].mean(),
            'profit_factor': pf
        }

    sim15 = sim_trades(p_buy_15, p_sell_15, 0.45)
    sim16 = sim_trades(p_buy_16, p_sell_16, 0.45)

    res = {
        'comparison': {
            'buy_metrics': {
                'v1.5.0': m_buy_15,
                'v1.6.0': m_buy_16,
                'roc_auc_diff': m_buy_16['auc'] - m_buy_15['auc'],
                'precision_diff': m_buy_16['precision'] - m_buy_15['precision'],
                'f05_diff': m_buy_16['f05'] - m_buy_15['f05']
            },
            'sell_metrics': {
                'v1.5.0': m_sell_15,
                'v1.6.0': m_sell_16,
                'roc_auc_diff': m_sell_16['auc'] - m_sell_15['auc'],
                'precision_diff': m_sell_16['precision'] - m_sell_15['precision'],
                'f05_diff': m_sell_16['f05'] - m_sell_15['f05']
            },
            'simulated_trading': {
                'v1.5.0': sim15,
                'v1.6.0': sim16
            }
        }
    }

    print(json.dumps(res, indent=2))

if __name__ == '__main__':
    main()
