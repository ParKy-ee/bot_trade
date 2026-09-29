import joblib, os, json
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, fbeta_score, roc_auc_score, average_precision_score, brier_score_loss

BASE_DIR = 'C:/xampp/htdocs/trade_bot'
CHAMPION_PATH = os.path.join(BASE_DIR, 'python', 'models', 'gold_m5_model.joblib')
DATA_PATH = os.path.join(BASE_DIR, 'data', 'dataset_gold_m5.csv')
VERSIONS_DIR = os.path.join(BASE_DIR, 'python', 'models', 'versions')
REGISTRY_PATH = os.path.join(BASE_DIR, 'python', 'models', 'gold_model_registry.json')

champ = joblib.load(CHAMPION_PATH)
cand = joblib.load(os.path.join(VERSIONS_DIR, 'gold_m5_model_gold-v1.2.0.joblib'))

df = pd.read_csv(DATA_PATH)
FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_21_50', 'bb_width', 'asian_sweep',
    'session_num', 'dxy_slope_5', 'h1_trend_slope', 'fvg_bull_bear'
]

X = df[FEATURE_COLS].values
y_buy = df['target_buy'].values
y_sell = df['target_sell'].values

split_idx = int(len(df) * 0.8)
X_test = X[split_idx:]
y_buy_test = y_buy[split_idx:]
y_sell_test = y_sell[split_idx:]

# Scalers
X_test_scaled_cand = cand['scaler'].transform(X_test)
X_test_scaled_champ = champ['scaler'].transform(X_test)

# Candidate Buy
p_buy_cand = cand['buy_model'].predict_proba(X_test_scaled_cand)[:, 1]
# Champion Sell
p_sell_champ = champ['sell_model'].predict_proba(X_test_scaled_champ)[:, 1]

# Relative probabilities
tot_hybrid = p_buy_cand + p_sell_champ + 1e-12
rel_buy = p_buy_cand / tot_hybrid
rel_sell = p_sell_champ / tot_hybrid

def eval_head(y_true, probs):
    top15 = np.percentile(probs, 85)
    top_pred = (probs >= top15).astype(int)
    top_prec = precision_score(y_true, top_pred, zero_division=0)
    pr_auc = average_precision_score(y_true, probs)
    roc_auc = roc_auc_score(y_true, probs)
    f05 = fbeta_score(y_true, top_pred, beta=0.5, zero_division=0)
    brier = brier_score_loss(y_true, probs)
    return {
        "roc_auc": round(roc_auc, 4),
        "pr_auc": round(pr_auc, 4),
        "top_prec": round(top_prec, 4),
        "f05": round(f05, 4),
        "brier": round(brier, 4)
    }

hybrid_buy = eval_head(y_buy_test, rel_buy)
hybrid_sell = eval_head(y_sell_test, rel_sell)

print("HYBRID MODEL EVALUATION:")
print("Buy Head:", hybrid_buy)
print("Sell Head:", hybrid_sell)

# Score
score = (hybrid_buy['pr_auc']*0.3 + hybrid_buy['top_prec']*0.35 + hybrid_buy['f05']*0.25 - hybrid_buy['brier']*0.1) + \
        (hybrid_sell['pr_auc']*0.3 + hybrid_sell['top_prec']*0.35 + hybrid_sell['f05']*0.25 - hybrid_sell['brier']*0.1)

print(f"Hybrid Score: {score:.4f} (Champion was 0.4480)")
