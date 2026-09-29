import joblib
import pymysql
import json
import os
import sys
import pandas as pd
import numpy as np

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
from sklearn.metrics import classification_report, f1_score, precision_score, recall_score, accuracy_score

FEATURE_COLS = [
    'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
    'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
]

print("=" * 80)
print("🎯 1. MARKET PRESSURE: F1-SCORE ON REAL LIVE OBSERVATIONS (MySQL: 1,821 Rows)")
print("=" * 80)

champ = joblib.load('python/models/forex_market_pressure_v1.0.0.joblib')
chall = joblib.load('python/models/forex_market_pressure_v1.1.0.joblib')

conn = pymysql.connect(
    host='127.0.0.1',
    user='root',
    database='ai_trading_db',
    charset='utf8mb4',
    cursorclass=pymysql.cursors.DictCursor
)
with conn.cursor() as cur:
    cur.execute("""
        SELECT bop, body_ratio, upper_wick, lower_wick, wick_asym, rel_range,
               ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew, actual_state
        FROM market_pressure_observations
        WHERE outcome_status = 'LABELED' AND actual_state IS NOT NULL
    """)
    rows = cur.fetchall()
conn.close()

df = pd.DataFrame(rows)
state_map = {'INDECISION_CHOP': 0, 'BUY_PRESSURE': 1, 'SELL_PRESSURE': 2}
y_true = df['actual_state'].map(state_map).values
X = df[FEATURE_COLS].astype(float).values

for name, m in [('Champion (v1.0.0)', champ), ('Challenger (v1.1.0)', chall)]:
    preds = m.predict(X)
    acc = accuracy_score(y_true, preds)
    macro_f1 = f1_score(y_true, preds, average='macro')
    weighted_f1 = f1_score(y_true, preds, average='weighted')
    
    print(f"\n🏷️ Model: {name}")
    print(f"  • Overall Accuracy : {acc * 100:.2f}%")
    print(f"  • Macro F1-Score   : {macro_f1 * 100:.2f}% (Average across all classes)")
    print(f"  • Weighted F1-Score: {weighted_f1 * 100:.2f}% (Weighted by class support)")
    
    rep = classification_report(
        y_true, preds,
        target_names=['INDECISION_CHOP', 'BUY_PRESSURE', 'SELL_PRESSURE'],
        output_dict=True
    )
    print("  • Class Breakdown:")
    for cls in ['INDECISION_CHOP', 'BUY_PRESSURE', 'SELL_PRESSURE']:
        p = rep[cls]['precision'] * 100
        r = rep[cls]['recall'] * 100
        f = rep[cls]['f1-score'] * 100
        sup = int(rep[cls]['support'])
        print(f"    - {cls:16s} (N={sup:4d}): Precision={p:5.1f}% | Recall={r:5.1f}% | F1-Score={f:5.1f}%")

print("\n" + "=" * 80)
print("📊 2. FOREX M5 PRODUCTION MODEL (v1.6.0) F1 & CLASSIFICATION METRICS")
print("=" * 80)
try:
    with open('python/models/model_registry.json', 'r') as f:
        mreg = json.load(f)
    v16 = [v for v in mreg['versions'] if v['version'] == 'v1.6.0'][0]
    met = v16['metrics']
    print(f"Model Version: v1.6.0 ({v16['architecture']})")
    print(f"  • BUY Signal  : Precision={met['precision_buy']*100:.1f}% | Recall={met['recall_buy']*100:.1f}% | F1-Score={met['f1_buy']*100:.2f}% | F0.5={met['f05_buy']*100:.2f}%")
    print(f"  • SELL Signal : Precision={met['precision_sell']*100:.1f}% | Recall={met['recall_sell']*100:.1f}% | F1-Score={met['f1_sell']*100:.2f}% | F0.5={met['f05_sell']*100:.2f}%")
    print(f"  • Overall ROC-AUC : BUY={met['roc_auc_buy']:.4f} | SELL={met['roc_auc_sell']:.4f}")
    print(f"  • MCC (Matthews)  : BUY={met['mcc_buy']:.4f} | SELL={met['mcc_sell']:.4f}")
except Exception as e:
    print(f"Error loading Forex registry: {e}")

print("\n" + "=" * 80)
print("🪙 3. CRYPTO M5 PRODUCTION MODEL (v2.0.0) F1 & METRICS")
print("=" * 80)
try:
    with open('python/models/crypto_model_registry.json', 'r') as f:
        creg = json.load(f)
    v20 = [v for v in creg['versions'] if v['version'] == 'v2.0.0'][0]
    cmet = v20['metrics']
    print(f"Model Version: v2.0.0 ({v20['architecture']})")
    print(f"  • BUY Signal  : Precision={cmet['precision_buy']*100:.1f}% | Recall={cmet['recall_buy']*100:.1f}% | F1-Score={cmet['f1_buy']*100:.2f}%")
    print(f"  • SELL Signal : Precision={cmet['precision_sell']*100:.1f}% | Recall={cmet['recall_sell']*100:.1f}% | F1-Score={cmet['f1_sell']*100:.2f}%")
    print(f"  • ROC-AUC     : BUY={cmet['roc_auc_buy']:.4f} | SELL={cmet['roc_auc_sell']:.4f}")
    print(f"  • Specificity : BUY={cmet['specificity_buy']*100:.1f}% | SELL={cmet['specificity_sell']*100:.1f}%")
except Exception as e:
    print(f"Error loading Crypto registry: {e}")

print("\n" + "=" * 80)
print("🟡 4. GOLD M5 MODEL (v1.0.0) METRICS")
print("=" * 80)
try:
    with open('python/models/gold_model_registry.json', 'r') as f:
        greg = json.load(f)
    g10 = greg[0]
    print(f"Model Version: {g10['model_version']}")
    print(f"  • BUY ROC-AUC : {g10['buy_metrics']['roc_auc']:.4f} | PR-AUC: {g10['buy_metrics']['pr_auc']:.4f}")
    print(f"  • SELL ROC-AUC: {g10['sell_metrics']['roc_auc']:.4f} | PR-AUC: {g10['sell_metrics']['pr_auc']:.4f}")
    print(f"  • Note: Gold is trained on high-threshold quant setups where F1 is near 0 due to extreme precision targeting.")
except Exception as e:
    print(f"Error loading Gold registry: {e}")
