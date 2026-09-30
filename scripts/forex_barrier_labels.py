"""Executable Forex M5 labels from the first TP/SL touch in the next five bars.

MT5 OHLC is treated as bid. A fixed estimated spread is charged on the ask
side of each hypothetical order. Same-bar TP/SL collisions are ambiguous.
"""

import numpy as np
import pandas as pd

HORIZON_BARS = 5
TP_ATR = 1.5
SL_ATR = 1.0


def label_forex_bars(df):
    result = df.copy()
    result['target_buy'] = np.nan
    result['target_sell'] = np.nan
    result['market_state'] = None

    for _, group in result.groupby('symbol', sort=False):
        ordered = group.sort_values('time')
        close = pd.to_numeric(ordered['close'], errors='coerce').to_numpy()
        high = pd.to_numeric(ordered['high'], errors='coerce').to_numpy()
        low = pd.to_numeric(ordered['low'], errors='coerce').to_numpy()
        atr = pd.to_numeric(ordered['atr_14'], errors='coerce').to_numpy()
        times = pd.to_datetime(ordered['time'], errors='coerce').to_numpy()
        spread = 0.02 if 'JPY' in str(ordered['symbol'].iloc[0]).upper() else 0.00015
        indexes = ordered.index.to_numpy()

        for i in range(len(ordered) - HORIZON_BARS):
            if not np.isfinite(close[i]) or not np.isfinite(atr[i]) or atr[i] <= 0:
                continue
            if pd.isna(times[i]) or any(
                pd.isna(times[i + j]) or times[i + j] - times[i] != np.timedelta64(j * 5, 'm')
                for j in range(1, HORIZON_BARS + 1)
            ):
                result.at[indexes[i], 'market_state'] = 'AVOID'
                result.at[indexes[i], 'target_buy'] = 0
                result.at[indexes[i], 'target_sell'] = 0
                continue
            buy_outcome = sell_outcome = 'TIMEOUT'
            buy_entry = close[i] + spread
            sell_entry = close[i]
            for j in range(i + 1, i + HORIZON_BARS + 1):
                if not np.isfinite(high[j]) or not np.isfinite(low[j]):
                    buy_outcome = sell_outcome = 'AMBIGUOUS'
                    break
                if buy_outcome == 'TIMEOUT':
                    tp = high[j] >= buy_entry + TP_ATR * atr[i]
                    sl = low[j] <= buy_entry - SL_ATR * atr[i]
                    if tp or sl:
                        buy_outcome = 'AMBIGUOUS' if tp and sl else 'WIN' if tp else 'LOSS'
                if sell_outcome == 'TIMEOUT':
                    tp = low[j] + spread <= sell_entry - TP_ATR * atr[i]
                    sl = high[j] + spread >= sell_entry + SL_ATR * atr[i]
                    if tp or sl:
                        sell_outcome = 'AMBIGUOUS' if tp and sl else 'WIN' if tp else 'LOSS'
                if buy_outcome != 'TIMEOUT' and sell_outcome != 'TIMEOUT':
                    break

            if 'AMBIGUOUS' in (buy_outcome, sell_outcome) or (buy_outcome == sell_outcome == 'WIN'):
                state = 'AVOID'
            elif buy_outcome == 'WIN':
                state = 'BUY'
            elif sell_outcome == 'WIN':
                state = 'SELL'
            else:
                state = 'NO_TRADE'
            row = indexes[i]
            result.at[row, 'market_state'] = state
            result.at[row, 'target_buy'] = int(state == 'BUY')
            result.at[row, 'target_sell'] = int(state == 'SELL')

    return result
