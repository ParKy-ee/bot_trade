import os
import pymysql
import pandas as pd
import numpy as np

# Connect to DB
conn = pymysql.connect(
    host='127.0.0.1', user='root', password='', database='ai_trading_db',
    cursorclass=pymysql.cursors.DictCursor
)

FEATURE_COLUMNS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'macd_hist', 'csm_spread',
    'h1_trend_slope', 'is_jpy', 'time_sin_hour', 'time_cos_hour',
    'spread_to_atr'
]

print("=== VERIFYING ML DATASET INTEGRITY ===")

with conn.cursor() as cursor:
    cursor.execute("""
        SELECT 
            ret_1, ret_5, rsi_14, atr_pct, adx_14, ema_spread_20_50, macd_hist,
            csm_spread, h1_trend_slope, is_jpy, time_sin_hour, time_cos_hour,
            spread_to_atr, target_buy, target_sell, outcome_status, sample_kind
        FROM forex_ml_observations
        WHERE outcome_status = 'LABELED'
    """)
    rows = cursor.fetchall()

df = pd.DataFrame(rows)
conn.close()

print(f"Total Labeled Observations: {len(df)}")

# Check for Null / NaN / Inf in features
null_counts = df[FEATURE_COLUMNS].isnull().sum()
print("\n--- Feature Null / NaN Counts ---")
print(null_counts)

# Check distribution statistics
print("\n--- Feature Summary Statistics ---")
stats = df[FEATURE_COLUMNS].describe().T[['mean', 'std', 'min', 'max']]
print(stats)

# Check Target Distribution
buy_cnt = (df['target_buy'] == 1).sum()
sell_cnt = (df['target_sell'] == 1).sum()
neutral_cnt = ((df['target_buy'] == 0) & (df['target_sell'] == 0)).sum()
conflict_cnt = ((df['target_buy'] == 1) & (df['target_sell'] == 1)).sum()

print("\n--- Target Label Distribution ---")
print(f"Target BUY = 1: {buy_cnt} ({buy_cnt/len(df)*100:.2f}%)")
print(f"Target SELL = 1: {sell_cnt} ({sell_cnt/len(df)*100:.2f}%)")
print(f"Neutral (0/0): {neutral_cnt} ({neutral_cnt/len(df)*100:.2f}%)")
print(f"Conflict (1/1): {conflict_cnt} ({conflict_cnt/len(df)*100:.2f}%)")

# Check for feature poisoning (constant 0s or infinite)
poisoned_ret1 = (df['ret_1'] == 0).sum()
poisoned_ret5 = (df['ret_5'] == 0).sum()
print(f"\nret_1 == 0 exactly: {poisoned_ret1} ({poisoned_ret1/len(df)*100:.2f}%)")
print(f"ret_5 == 0 exactly: {poisoned_ret5} ({poisoned_ret5/len(df)*100:.2f}%)")

if conflict_cnt == 0 and null_counts.sum() == 0 and poisoned_ret5 < len(df) * 0.05:
    print("\n[RESULT] Dataset is 100% CLEAN, HEALTHY, and FREE OF BUGS!")
else:
    print("\n[WARNING] Dataset might have anomalies!")
