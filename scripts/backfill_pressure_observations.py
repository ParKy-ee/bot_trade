import os
import sys
import json
import warnings
import joblib
import pymysql
import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')
warnings.filterwarnings('ignore')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, 'python', 'models', 'forex_market_pressure_v1.0.0.joblib')

def main():
    print("🔄 กำลังเตรียม Backfill ข้อมูลแท่งเทียนย้อนหลัง 24 ชม. เข้า market_pressure_observations...")
    if not os.path.exists(MODEL_PATH):
        print(f"❌ ไม่พบโมเดลที่ {MODEL_PATH}")
        return

    model = joblib.load(MODEL_PATH)
    
    conn = pymysql.connect(
        host='127.0.0.1',
        user='root',
        password='',
        database='ai_trading_db',
        charset='utf8mb4',
        cursorclass=pymysql.cursors.DictCursor
    )

    symbols = [
        'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X',
        'USDCAD=X', 'USDCHF=X', 'NZDUSD=X', 'EURJPY=X', 'GBPJPY=X'
    ]

    total_inserted = 0

    with conn.cursor() as cur:
        for sym in symbols:
            cur.execute("""
                SELECT time, open, high, low, close, volume, rsi, atr
                FROM market_bars
                WHERE symbol = %s AND market_type = 'forex'
                ORDER BY time DESC
                LIMIT 80
            """, (sym,))
            rows = cur.fetchall()
            if len(rows) < 20:
                continue

            rows.reverse()
            df = pd.DataFrame(rows)
            for c in ['open', 'high', 'low', 'close', 'volume', 'rsi', 'atr']:
                df[c] = pd.to_numeric(df[c], errors='coerce')

            tr1 = df['high'] - df['low']
            tr2 = (df['high'] - df['close'].shift(1)).abs()
            tr3 = (df['low'] - df['close'].shift(1)).abs()
            tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
            rolling_atr = tr.rolling(14, min_periods=1).mean()
            atr = df['atr'].fillna(rolling_atr)
            atr = atr.where(atr > 0.0001, rolling_atr).replace(0, 1e-5)
            df['atr'] = atr
            c_range = (df['high'] - df['low']).replace(0, 1e-5)
            close = df['close']
            open_p = df['open']

            # Features
            df['bop'] = ((close - open_p) / c_range).clip(-1, 1)
            df['body_ratio'] = ((close - open_p).abs() / c_range).clip(0, 1)
            df['upper_wick'] = ((df['high'] - np.maximum(close, open_p)) / c_range).clip(0, 1)
            df['lower_wick'] = ((np.minimum(close, open_p) - df['low']) / c_range).clip(0, 1)
            df['wick_asym'] = df['lower_wick'] - df['upper_wick']
            df['rel_range'] = (c_range / atr).clip(0, 5)

            step = (close - close.shift(1)).abs()
            df['ker_3'] = ((close - close.shift(3)).abs() / step.rolling(3).sum().replace(0, 1e-5)).clip(0, 1)
            df['ker_5'] = ((close - close.shift(5)).abs() / step.rolling(5).sum().replace(0, 1e-5)).clip(0, 1)
            df['ker_10'] = ((close - close.shift(10)).abs() / step.rolling(10).sum().replace(0, 1e-5)).clip(0, 1)

            df['dir_disp_3'] = ((close - close.shift(3)) / atr).clip(-5, 5)
            df['dir_disp_5'] = ((close - close.shift(5)) / atr).clip(-5, 5)

            mid_point = (df['high'] + df['low']) / 2.0
            pos_in_range = ((close - mid_point) / (c_range / 2.0)).clip(-1, 1)
            vol_safe = df['volume'].replace(0, 1).clip(lower=1)
            df['vol_skew'] = pos_in_range * np.log1p(vol_safe)

            feature_cols = [
                'bop', 'body_ratio', 'upper_wick', 'lower_wick', 'wick_asym',
                'rel_range', 'ker_3', 'ker_5', 'ker_10', 'dir_disp_3', 'dir_disp_5', 'vol_skew'
            ]

            # Forward Target (Look ahead 3 bars)
            fwd_3 = (close.shift(-3) - close) / atr
            fwd_low = df['low'].shift(-1).rolling(3).min()
            fwd_high = df['high'].shift(-1).rolling(3).max()
            mae = (close - fwd_low) / atr
            mfe = (fwd_high - close) / atr

            # Predict and insert
            for i in range(12, len(df) - 3):
                row = df.iloc[i]
                X = row[feature_cols].values.reshape(1, -1)
                probs = model.predict_proba(X)[0]
                p_indecision, p_buy, p_sell = float(probs[0]), float(probs[1]), float(probs[2])

                if p_buy >= 0.42 and p_buy > p_sell:
                    pred_state = "BUY_PRESSURE"
                elif p_sell >= 0.42 and p_sell > p_buy:
                    pred_state = "SELL_PRESSURE"
                else:
                    pred_state = "INDECISION_CHOP"

                fwd_ret = float(fwd_3.iloc[i])
                fwd_mae = float(mae.iloc[i])
                fwd_mfe = float(mfe.iloc[i])

                actual_state = "INDECISION_CHOP"
                if fwd_ret >= 0.40 and fwd_ret >= fwd_mae * 0.8:
                    actual_state = "BUY_PRESSURE"
                elif fwd_ret <= -0.40 and abs(fwd_ret) >= fwd_mfe * 0.8:
                    actual_state = "SELL_PRESSURE"

                is_correct = 1 if pred_state == actual_state else 0
                exp_pips = (p_buy - p_sell) * float(row['ker_5']) * (float(row['atr']) / (0.01 if 'JPY' in sym else 0.0001)) * 2.2

                cur.execute("""
                    INSERT INTO market_pressure_observations (
                        symbol, bar_time, observed_at,
                        close_price, atr, bop, body_ratio, upper_wick, lower_wick,
                        wick_asym, rel_range, ker_3, ker_5, ker_10, dir_disp_3, dir_disp_5, vol_skew,
                        predicted_state, prob_buy, prob_sell, prob_indecision, expected_net_pips,
                        forward_close_3, forward_high_3, forward_low_3, actual_mfe_atr, actual_mae_atr,
                        actual_return_atr, actual_state, is_correct, outcome_status, labeled_at
                    ) VALUES (
                        %s, %s, %s,
                        %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, 'LABELED', NOW()
                    )
                    ON DUPLICATE KEY UPDATE
                        forward_close_3 = VALUES(forward_close_3),
                        actual_state = VALUES(actual_state),
                        is_correct = VALUES(is_correct),
                        outcome_status = 'LABELED'
                """, (
                    sym, row['time'], row['time'],
                    float(row['close']), float(row['atr']), float(row['bop']), float(row['body_ratio']),
                    float(row['upper_wick']), float(row['lower_wick']), float(row['wick_asym']), float(row['rel_range']),
                    float(row['ker_3']), float(row['ker_5']), float(row['ker_10']), float(row['dir_disp_3']),
                    float(row['dir_disp_5']), float(row['vol_skew']),
                    pred_state, p_buy, p_sell, p_indecision, round(exp_pips, 2),
                    float(df['close'].iloc[i+3]), float(df['high'].iloc[i+1:i+4].max()), float(df['low'].iloc[i+1:i+4].min()),
                    round(fwd_mfe, 4), round(fwd_mae, 4), round(fwd_ret, 4), actual_state, is_correct
                ))
                total_inserted += 1

        conn.commit()
    conn.close()
    print(f"✅ Backfill สำเร็จ! บันทึกและติดป้าย Ground Truth เรียบร้อย {total_inserted} แถว")

if __name__ == '__main__':
    main()
