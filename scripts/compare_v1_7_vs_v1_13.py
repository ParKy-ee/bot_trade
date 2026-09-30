import json
import os
import sys
import joblib
import pymysql
import numpy as np
import pandas as pd

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSIONS_DIR = os.path.join(ROOT_DIR, 'python', 'models', 'versions')
V1_7_PATH = os.path.join(VERSIONS_DIR, 'forex_challenger_model_challenger-v1.7.0.joblib')
V1_13_PATH = os.path.join(VERSIONS_DIR, 'forex_challenger_model_challenger-v1.13.0.joblib')

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'macd_hist', 'csm_spread', 'h1_trend_slope',
    'is_jpy', 'time_sin_hour', 'time_cos_hour', 'spread_to_atr'
]

def load_models():
    m_1_7 = joblib.load(V1_7_PATH)
    m_1_13 = joblib.load(V1_13_PATH)
    return m_1_7, m_1_13

def test_on_recent_trades():
    print("📥 Loading recent closed trades from MySQL...")
    conn = pymysql.connect(
        host='127.0.0.1',
        user='root',
        database='ai_trading_db',
        charset='utf8mb4',
        cursorclass=pymysql.cursors.DictCursor
    )
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                symbol, action, entry_price, pips, profit_loss, is_win,
                rsi, adx, atr, ema21, ema50, macd_hist, entry_time
            FROM trade_results
            WHERE market_type IN ('forex', 'forex_shadow')
              AND exit_reason NOT IN ('OPEN', 'SYNC_PENDING')
              AND entry_price IS NOT NULL
              AND atr IS NOT NULL AND rsi IS NOT NULL
            ORDER BY id DESC
            LIMIT 500
        """)
        rows = cur.fetchall()
    conn.close()

    if not rows:
        print("No recent trades found.")
        return

    df = pd.DataFrame(rows)
    print(f"📊 Loaded {len(df)} recent closed trades.")

    # Calculate features matching train_forex_challenger_model.py
    df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
    df['ret_1'] = 0.0
    df['ret_5'] = pd.to_numeric(df['pips'], errors='coerce').fillna(0.0) * 0.0001
    df['rsi_14'] = pd.to_numeric(df['rsi'], errors='coerce')
    entry_p = pd.to_numeric(df['entry_price'], errors='coerce') + 1e-12
    df['atr_pct'] = pd.to_numeric(df['atr'], errors='coerce') / entry_p
    df['adx_14'] = pd.to_numeric(df['adx'], errors='coerce')
    df['ema_spread_20_50'] = (pd.to_numeric(df['ema21'], errors='coerce') - pd.to_numeric(df['ema50'], errors='coerce')) / entry_p
    df['macd_hist'] = pd.to_numeric(df['macd_hist'], errors='coerce')
    df['csm_spread'] = 0.0
    df['h1_trend_slope'] = 0.0

    live_dt = pd.to_datetime(df['entry_time'], errors='coerce')
    hrs = live_dt.dt.hour + (live_dt.dt.minute / 60.0)
    df['time_sin_hour'] = np.sin(2 * np.pi * hrs / 24.0).fillna(0.0)
    df['time_cos_hour'] = np.cos(2 * np.pi * hrs / 24.0).fillna(0.0)
    spread_pips = np.where(df['is_jpy'] == 1.0, 0.02, 0.00015)
    df['spread_to_atr'] = spread_pips / (pd.to_numeric(df['atr'], errors='coerce') + 1e-12)

    X = df[FEATURE_COLS].fillna(0.0).values
    pips = df['pips'].astype(float).values
    is_win = (pd.to_numeric(df['profit_loss'], errors='coerce') > 0).values
    action = df['action'].values

    m_1_7, m_1_13 = load_models()

    # Model 1.7.0 predictions
    p_buy_1_7 = m_1_7['buy_model'].predict_proba(X)[:, 1]
    p_sell_1_7 = m_1_7['sell_model'].predict_proba(X)[:, 1]
    th_buy_1_7 = m_1_7['metrics']['buy'].get('threshold', 0.35)
    th_sell_1_7 = m_1_7['metrics']['sell'].get('threshold', 0.20)

    # Model 1.13.0 predictions
    p_buy_1_13 = m_1_13['buy_model'].predict_proba(X)[:, 1]
    p_sell_1_13 = m_1_13['sell_model'].predict_proba(X)[:, 1]
    th_buy_1_13 = m_1_13['metrics']['buy'].get('threshold', 0.40)
    th_sell_1_13 = m_1_13['metrics']['sell'].get('threshold', 0.30)

    # Compare signals
    sig_1_7 = (action == 'BUY') & (p_buy_1_7 >= th_buy_1_7) | (action == 'SELL') & (p_sell_1_7 >= th_sell_1_7)
    sig_1_13 = (action == 'BUY') & (p_buy_1_13 >= th_buy_1_13) | (action == 'SELL') & (p_sell_1_13 >= th_sell_1_13)

    print("\n" + "=" * 70)
    print("🥊 SIDE-BY-SIDE BACKTEST ON ACTUAL LIVE/SHADOW TRADES (500 TRADES)")
    print("=" * 70)

    def stats(mask, name):
        n = mask.sum()
        if n == 0:
            return f"{name}: No signals fired"
        w = is_win[mask].sum()
        wr = (w / n) * 100.0
        tot_pips = pips[mask].sum()
        avg_pips = pips[mask].mean()
        return f"{name:25s} | Trades: {n:3d} | Wins: {w:3d} ({wr:5.1f}%) | Total Pips: {tot_pips:7.1f} | Avg Pips: {avg_pips:+.2f}"

    print(stats(np.ones(len(df), dtype=bool), "All Recent Trades (Market)"))
    print(stats(sig_1_7, "Active (challenger-v1.7.0)"))
    print(stats(sig_1_13, "Candidate (challenger-v1.13.0)"))

    # Specifically for SELL trades
    sell_mask = (action == 'SELL')
    print("\n--- Specifically SELL Trades ---")
    print(stats(sell_mask, "All SELL Trades"))
    print(stats(sell_mask & (p_sell_1_7 >= th_sell_1_7), "v1.7.0 SELL Signals"))
    print(stats(sell_mask & (p_sell_1_13 >= th_sell_1_13), "v1.13.0 SELL Signals"))

    # Specifically for BUY trades
    buy_mask = (action == 'BUY')
    print("\n--- Specifically BUY Trades ---")
    print(stats(buy_mask, "All BUY Trades"))
    print(stats(buy_mask & (p_buy_1_7 >= th_buy_1_7), "v1.7.0 BUY Signals"))
    print(stats(buy_mask & (p_buy_1_13 >= th_buy_1_13), "v1.13.0 BUY Signals"))

if __name__ == '__main__':
    test_on_recent_trades()
