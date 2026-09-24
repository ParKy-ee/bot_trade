"""
Comprehensive Backtest: Strict Production Guard vs Relaxed Guard + Market Pressure Engine
Simulates entry decisions across 36,000 continuous M5 bars and historical trades.
Compares:
  Mode 1: Strict Baseline Guard (ADX >= 14, CSM, Strict Rejection Veto)
  Mode 2: Relaxed Guard + Market Pressure AI Assistant (Low ADX allowed if Pressure confirms, Counter-Pressure Veto)
  Mode 3: Pure AI with Market Pressure Confluence
"""

import os
import sys
import json
import joblib
import numpy as np
import pandas as pd

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, 'python', 'models', 'forex_market_pressure_v1.0.0.joblib')
BARS_PATH = os.path.join(ROOT_DIR, 'data', 'market_pressure_bars.json')

def run_backtest():
    print("=" * 75)
    print("📊 BACKTEST: STRICT PRODUCTION GUARD vs RELAXED GUARD + MARKET PRESSURE")
    print("=" * 75)
    
    if not os.path.exists(MODEL_PATH) or not os.path.exists(BARS_PATH):
        print("Missing model or dataset.")
        return

    model = joblib.load(MODEL_PATH)
    with open(BARS_PATH, 'r', encoding='utf-8') as f:
        bars = json.load(f)
    df = pd.DataFrame(bars)
    
    for c in ['open', 'high', 'low', 'close', 'volume', 'rsi', 'atr']:
        df[c] = pd.to_numeric(df[c], errors='coerce')
        
    print(f"Loaded {len(df):,} bars across symbols.")

    # Process indicators and features
    dfs = []
    for sym, g in df.groupby('symbol'):
        g = g.sort_values('time').reset_index(drop=True).copy()
        
        atr = g['atr'].replace(0, np.nan).bfill().ffill().replace(0, 1e-5)
        c_range = (g['high'] - g['low']).replace(0, 1e-5)
        close = g['close']
        open_p = g['open']
        high = g['high']
        low = g['low']
        
        # Microstructure features
        g['bop'] = ((close - open_p) / c_range).clip(-1, 1)
        g['body_ratio'] = ((close - open_p).abs() / c_range).clip(0, 1)
        g['upper_wick'] = ((high - np.maximum(close, open_p)) / c_range).clip(0, 1)
        g['lower_wick'] = ((np.minimum(close, open_p) - low) / c_range).clip(0, 1)
        g['wick_asym'] = g['lower_wick'] - g['upper_wick']
        g['rel_range'] = (c_range / atr).clip(0, 5)
        
        step = (close - close.shift(1)).abs()
        g['ker_3'] = ((close - close.shift(3)).abs() / step.rolling(3).sum().replace(0, 1e-5)).clip(0, 1)
        g['ker_5'] = ((close - close.shift(5)).abs() / step.rolling(5).sum().replace(0, 1e-5)).clip(0, 1)
        g['ker_10'] = ((close - close.shift(10)).abs() / step.rolling(10).sum().replace(0, 1e-5)).clip(0, 1)
        g['dir_disp_3'] = ((close - close.shift(3)) / atr).clip(-5, 5)
        g['dir_disp_5'] = ((close - close.shift(5)) / atr).clip(-5, 5)
        
        mid_point = (high + low) / 2.0
        pos_in_range = ((close - mid_point) / (c_range / 2.0)).clip(-1, 1)
        vol_safe = g['volume'].replace(0, 1).clip(lower=1)
        g['vol_skew'] = pos_in_range * np.log1p(vol_safe)
        
        # Technical trend indicators
        # Fast EMA 9, 21, 50
        g['ema9'] = close.ewm(span=9, adjust=False).mean()
        g['ema21'] = close.ewm(span=21, adjust=False).mean()
        g['ema50'] = close.ewm(span=50, adjust=False).mean()
        
        # Synthetic ADX estimation (14-period directional movement)
        tr = np.maximum(high - low, np.maximum((high - close.shift(1)).abs(), (low - close.shift(1)).abs()))
        up_move = high - high.shift(1)
        down_move = low.shift(1) - low
        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
        tr_smooth = pd.Series(tr).rolling(14).sum().replace(0, 1e-5)
        plus_di = 100 * (pd.Series(plus_dm).rolling(14).sum() / tr_smooth)
        minus_di = 100 * (pd.Series(minus_dm).rolling(14).sum() / tr_smooth)
        dx = (100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, 1e-5)).fillna(0)
        g['adx14'] = dx.rolling(14).mean().fillna(15.0)

        # Pip multiplier
        mult = 100.0 if 'JPY' in str(sym) else 10000.0
        g['pip_mult'] = mult
        
        # Simulated Outcome: Dynamic Exit (MFE / MAE / 6-bar return)
        # 1.5 ATR TP, 1.0 ATR SL, or 6-bar time stop
        fwd_high_6 = high.shift(-1).rolling(6).max()
        fwd_low_6 = low.shift(-1).rolling(6).min()
        fwd_close_6 = close.shift(-6)
        
        # BUY outcomes
        tp_price_b = close + (1.5 * atr)
        sl_price_b = close - (1.0 * atr)
        hit_tp_b = fwd_high_6 >= tp_price_b
        hit_sl_b = fwd_low_6 <= sl_price_b
        
        # Net pips for BUY
        pips_buy = np.where(hit_tp_b & ~hit_sl_b, 1.5 * atr * mult,
                   np.where(hit_sl_b & ~hit_tp_b, -1.0 * atr * mult,
                   np.where(hit_tp_b & hit_sl_b, -0.5 * atr * mult, # Whipsaw SL first
                   (fwd_close_6 - close) * mult)))
        g['pips_buy'] = pips_buy
        g['is_win_buy'] = (pips_buy > 0).astype(int)

        # SELL outcomes
        tp_price_s = close - (1.5 * atr)
        sl_price_s = close + (1.0 * atr)
        hit_tp_s = fwd_low_6 <= tp_price_s
        hit_sl_s = fwd_high_6 >= sl_price_s
        
        pips_sell = np.where(hit_tp_s & ~hit_sl_s, 1.5 * atr * mult,
                    np.where(hit_sl_s & ~hit_tp_s, -1.0 * atr * mult,
                    np.where(hit_tp_s & hit_sl_s, -0.5 * atr * mult,
                    (close - fwd_close_6) * mult)))
        g['pips_sell'] = pips_sell
        g['is_win_sell'] = (pips_sell > 0).astype(int)
        
        dfs.append(g.iloc[35:-7])
        
    full = pd.concat(dfs, ignore_index=True).dropna(subset=['adx14', 'ker_5', 'pips_buy'])
    print(f"Total evaluated continuous bars: {len(full):,}\n")
    
    # Predict Market Pressure Probabilities
    feature_cols = [
        'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
        'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
    ]
    probs = model.predict_proba(full[feature_cols].values)
    full['p_indecision'] = probs[:, 0]
    full['p_buy'] = probs[:, 1]
    full['p_sell'] = probs[:, 2]
    
    # -------------------------------------------------------------
    # BASE SETUP: Trend-Following Pullback Signals
    # BUY: close > ema50 & ema9 > ema21 & pullback dip
    # SELL: close < ema50 & ema9 < ema21 & pullback dip
    # -------------------------------------------------------------
    raw_buy_signal = (full['close'] > full['ema50']) & (full['ema9'] > full['ema21']) & (full['bop'] > -0.5)
    raw_sell_signal = (full['close'] < full['ema50']) & (full['ema9'] < full['ema21']) & (full['bop'] < 0.5)
    
    # -------------------------------------------------------------
    # STRATEGY 1: STRICT PRODUCTION GUARD (Baseline)
    # Rules: ADX >= 15, Rejection wick <= 0.60, No entry in low volatility
    # -------------------------------------------------------------
    guard_pass_b = (full['adx14'] >= 15.0) & (full['upper_wick'] <= 0.55) & (full['rel_range'] >= 0.25)
    guard_pass_s = (full['adx14'] >= 15.0) & (full['lower_wick'] <= 0.55) & (full['rel_range'] >= 0.25)
    
    s1_buy_trades = full[raw_buy_signal & guard_pass_b]
    s1_sell_trades = full[raw_sell_signal & guard_pass_s]
    
    # -------------------------------------------------------------
    # STRATEGY 2: RELAXED GUARD + MARKET PRESSURE ASSISTANT (New Proposal)
    # Rules: 
    #   - Relax ADX cutoff down to 10.0 (allow early expansion)
    #   - Relax wick rejection down to 0.75
    #   - BUT REQUIRE: No Counter-Pressure! (BUY cannot have p_sell >= 0.40)
    #   - AND REQUIRE: Market Pressure Confluence: p_buy >= 0.35 OR (p_indecision >= 0.35 & ker_5 >= 0.30)
    # -------------------------------------------------------------
    pressure_pass_b = (full['adx14'] >= 10.0) & (full['p_sell'] < 0.38) & (
        (full['p_buy'] >= 0.36) | ((full['p_indecision'] >= 0.35) & (full['ker_5'] >= 0.25))
    ) & (full['upper_wick'] <= 0.70)
    
    pressure_pass_s = (full['adx14'] >= 10.0) & (full['p_buy'] < 0.38) & (
        (full['p_sell'] >= 0.36) | ((full['p_indecision'] >= 0.35) & (full['ker_5'] >= 0.25))
    ) & (full['lower_wick'] <= 0.70)
    
    s2_buy_trades = full[raw_buy_signal & pressure_pass_b]
    s2_sell_trades = full[raw_sell_signal & pressure_pass_s]

    # -------------------------------------------------------------
    # STRATEGY 3: PURE HIGH-CONVICTION PRESSURE (Aggressive Edge)
    # Direct alignment with Market Pressure (p_buy >= 0.42 for BUY, p_sell >= 0.42 for SELL)
    # -------------------------------------------------------------
    s3_buy_trades = full[raw_buy_signal & (full['p_buy'] >= 0.42)]
    s3_sell_trades = full[raw_sell_signal & (full['p_sell'] >= 0.42)]

    # Compute stats helper
    def compute_metrics(name, buy_df, sell_df):
        total_trades = len(buy_df) + len(sell_df)
        if total_trades == 0:
            return {"name": name, "trades": 0}
            
        wins = buy_df['is_win_buy'].sum() + sell_df['is_win_sell'].sum()
        wr = (wins / total_trades) * 100
        
        pips_b = buy_df['pips_buy'].values
        pips_s = sell_df['pips_sell'].values
        all_pips = np.concatenate([pips_b, pips_s])
        
        total_pips = all_pips.sum()
        avg_pips = all_pips.mean()
        
        gross_profit = all_pips[all_pips > 0].sum()
        gross_loss = abs(all_pips[all_pips < 0].sum())
        profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else 99.0
        
        # Max Drawdown in pips (cumulative curve)
        cum_pips = np.cumsum(all_pips)
        peak = np.maximum.accumulate(cum_pips)
        dd = peak - cum_pips
        max_dd = np.max(dd) if len(dd) > 0 else 0
        
        # Score = (Avg Pips * Win Rate * Profit Factor) / (Max DD + 1)
        expectancy_score = (avg_pips * (wr / 100) * profit_factor)
        
        return {
            "name": name,
            "trades": total_trades,
            "win_rate": wr,
            "total_pips": total_pips,
            "avg_pips": avg_pips,
            "profit_factor": profit_factor,
            "max_dd_pips": max_dd,
            "expectancy_score": expectancy_score
        }

    res1 = compute_metrics("1. Strict Production Guard (Baseline)", s1_buy_trades, s1_sell_trades)
    res2 = compute_metrics("2. Relaxed Guard + Market Pressure (Proposed)", s2_buy_trades, s2_sell_trades)
    res3 = compute_metrics("3. High-Conviction Pressure Only", s3_buy_trades, s3_sell_trades)

    print("┌──────────────────────────────────────────────┬──────────┬──────────┬─────────────┬──────────┬──────────────┬─────────────┬──────────────┐")
    print("│ Strategy / Mode                              │ Trades   │ Win Rate │ Total Pips  │ Avg Pips │ Profit Factor│ Max DD Pips │ Quant Score  │")
    print("├──────────────────────────────────────────────┼──────────┼──────────┼─────────────┼──────────┼──────────────┼─────────────┼──────────────┤")
    for r in [res1, res2, res3]:
        print(f"│ {r['name']:44s} │ {r['trades']:8d} │ {r['win_rate']:7.1f}% │ {r['total_pips']:10.1f}p │ {r['avg_pips']:7.2f}p │ {r['profit_factor']:12.2f} │ {r['max_dd_pips']:10.1f}p │ {r['expectancy_score']:12.2f} │")
    print("└──────────────────────────────────────────────┴──────────┴──────────┴─────────────┴──────────┴──────────────┴─────────────┴──────────────┘")

    print("\n🔍 DETAILED ANALYSIS OF RELAXED GUARD + PRESSURE:")
    print(f"  • Trade Volume Increase: +{((res2['trades'] - res1['trades']) / res1['trades']) * 100:.1f}% more trade opportunities unlocked!")
    print(f"  • Total Pips Difference:  {res2['total_pips'] - res1['total_pips']:+.1f} pips ({'PROFIT BOOST' if res2['total_pips'] > res1['total_pips'] else 'LOWER'})")
    print(f"  • Profit Factor Shift:    {res1['profit_factor']:.2f} ➔ {res2['profit_factor']:.2f}")

if __name__ == '__main__':
    run_backtest()
