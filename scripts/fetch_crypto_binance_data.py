import sys
import os
import json
import time
import urllib.request
import urllib.error
import warnings
import pandas as pd
import numpy as np

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

warnings.filterwarnings("ignore")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "dataset_crypto_m5.csv")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
INTERVAL = "5m"
LIMIT = 1000  # Binance maximum per request

FEATURE_COLS = [
    'ret_1', 'ret_5', 'rsi_14', 'atr_pct', 'adx_14',
    'ema_spread_20_50', 'ema_spread_50_200', 'macd_hist',
    'volume_ratio', 'bb_width',
    'btc_ret_5', 'btc_corr_divergence', 'is_weekend',
    'vwap_distance_pct', 'distance_to_swing_high_low', 'funding_window_proximity'
]

def fetch_binance_klines(symbol, interval="5m", limit=1000, end_time=None):
    """
    Fetches candlestick data from Binance Public REST API (no API key required).
    Fallback endpoints supported.
    """
    endpoints = [
        "https://api.binance.com/api/v3/klines",
        "https://data-api.binance.vision/api/v3/klines",
        "https://api1.binance.com/api/v3/klines",
        "https://api2.binance.com/api/v3/klines"
    ]
    
    params = f"symbol={symbol}&interval={interval}&limit={limit}"
    if end_time:
        params += f"&endTime={end_time}"
        
    for ep in endpoints:
        test_url = f"{ep}?{params}"
        try:
            req = urllib.request.Request(
                test_url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if isinstance(data, list) and len(data) > 0:
                    return data
        except Exception:
            continue
            
    print(f"⚠️ ไม่สามารถดึงข้อมูลจาก Binance สำหรับ {symbol}")
    return []

def fetch_raw_symbol_history(symbol, total_candles=3500):
    """
    Fetches consecutive historical chunks from Binance.
    """
    all_rows = []
    end_time = None
    
    print(f"[*] กำลังดึงแท่งเทียน M5 ย้อนหลังของ {symbol} ({total_candles:,} แท่ง)...")
    
    chunks = total_candles // LIMIT
    for _ in range(chunks):
        raw = fetch_binance_klines(symbol, interval=INTERVAL, limit=LIMIT, end_time=end_time)
        if not raw:
            break
        all_rows = raw + all_rows
        end_time = raw[0][0] - 1  # Move back to previous candle
        time.sleep(0.2)
        
    if not all_rows:
        return pd.DataFrame()
        
    # Deduplicate by open time
    seen = set()
    deduped = []
    for r in all_rows:
        if r[0] not in seen:
            seen.add(r[0])
            deduped.append(r)
    deduped.sort(key=lambda x: x[0])
    
    df = pd.DataFrame(deduped, columns=[
        "open_time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades", "taker_base_vol", "taker_quote_vol", "ignore"
    ])
    
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
        
    df["time"] = pd.to_datetime(df["open_time"], unit="ms")
    df["symbol"] = symbol
    return df

def calculate_16_features_and_targets(df_dict):
    """
    Computes 16 quantitative & microstructure features for all symbols,
    including BTC cross-correlation and temporal regimes.
    """
    processed_dfs = []
    
    # 1. First extract BTC returns for cross-alignment
    btc_df = df_dict.get("BTCUSDT")
    if btc_df is None or btc_df.empty:
        raise ValueError("BTCUSDT data is required to compute BTC Beta & lead momentum features")
        
    btc_df = btc_df.sort_values("open_time").copy()
    btc_df["btc_ret_5"] = btc_df["close"].pct_change(5)
    btc_ref = btc_df[["open_time", "btc_ret_5"]].dropna()

    for symbol, df in df_dict.items():
        if df.empty:
            continue
        df = df.sort_values("open_time").copy()
        
        # Merge with BTC lead return
        df = pd.merge(df, btc_ref, on="open_time", how="left")
        df["btc_ret_5"] = df["btc_ret_5"].fillna(0.0)
        
        closes = df["close"]
        highs = df["high"]
        lows = df["low"]
        vols = df["volume"]
        times = df["time"]
        
        # 1. Base Returns
        df["ret_1"] = closes.pct_change(1)
        df["ret_5"] = closes.pct_change(5)
        
        # Target Return (Forward 5 bars for scalp horizon)
        df["target_ret_5"] = (closes.shift(-5) - closes) / closes
        
        # 2. EMAs & Spreads
        ema_20 = closes.ewm(span=20, adjust=False).mean()
        ema_50 = closes.ewm(span=50, adjust=False).mean()
        ema_200 = closes.ewm(span=200, adjust=False).mean()
        df["ema_spread_20_50"] = (ema_20 - ema_50) / closes
        df["ema_spread_50_200"] = (ema_50 - ema_200) / closes
        
        # 3. RSI (14)
        delta = closes.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
        rs = gain / (loss + 1e-9)
        df["rsi_14"] = 100 - (100 / (1 + rs))
        
        # 4. ATR (14)
        tr1 = highs - lows
        tr2 = (highs - closes.shift(1)).abs()
        tr3 = (lows - closes.shift(1)).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        df["atr_14"] = tr.rolling(window=14).mean()
        df["atr_pct"] = df["atr_14"] / closes
        
        # 5. ADX (14)
        up_move = highs - highs.shift(1)
        down_move = lows.shift(1) - lows
        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
        tr_smooth = tr.rolling(14).sum()
        plus_di = 100 * pd.Series(plus_dm, index=df.index).rolling(14).sum() / (tr_smooth + 1e-9)
        minus_di = 100 * pd.Series(minus_dm, index=df.index).rolling(14).sum() / (tr_smooth + 1e-9)
        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di + 1e-9)
        df["adx_14"] = dx.rolling(14).mean()
        
        # 6. Bollinger Bands & Bandwidth (20, 2)
        bb_mid = closes.rolling(window=20).mean()
        bb_std = closes.rolling(window=20).std()
        bb_up = bb_mid + (2 * bb_std)
        bb_low = bb_mid - (2 * bb_std)
        df["bb_width"] = (bb_up - bb_low) / (bb_mid + 1e-9)
        
        # 7. MACD Histogram (12, 26, 9)
        ema_12 = closes.ewm(span=12, adjust=False).mean()
        ema_26 = closes.ewm(span=26, adjust=False).mean()
        macd = ema_12 - ema_26
        signal = macd.ewm(span=9, adjust=False).mean()
        df["macd_hist"] = (macd - signal) / closes
        
        # 8. Volume Ratio (relative to 20-period moving average)
        vol_sma20 = vols.rolling(window=20).mean()
        df["volume_ratio"] = vols / (vol_sma20 + 1e-9)
        
        # 9. BTC Cross-Divergence
        df["btc_corr_divergence"] = df["ret_5"] - df["btc_ret_5"]
        
        # 10. Temporal Regime: Weekend Illiquidity Flag (UTC Sat=5, Sun=6 in pandas dt.dayofweek)
        df["is_weekend"] = times.dt.dayofweek.isin([5, 6]).astype(float)
        
        # 11. Rolling VWAP (24 bars ~ 2 hours session anchor)
        typical_price = (highs + lows + closes) / 3.0
        pv = typical_price * vols
        rolling_pv = pv.rolling(window=24).sum()
        rolling_vol = vols.rolling(window=24).sum()
        rolling_vwap = rolling_pv / (rolling_vol + 1e-9)
        df["vwap_distance_pct"] = (closes - rolling_vwap) / (rolling_vwap + 1e-9)
        
        # 12. Distance to Swing High/Low (24-bar window)
        swing_high = highs.rolling(window=24).max()
        swing_low = lows.rolling(window=24).min()
        swing_range = swing_high - swing_low + 1e-9
        df["distance_to_swing_high_low"] = (closes - swing_low) / swing_range  # 0.0 at low, 1.0 at high
        
        # 13. Funding Window Proximity (00:00, 08:00, 16:00 UTC)
        # Total minutes in UTC day = 1440. Funding at minute 0, 480, 960
        minute_of_day = times.dt.hour * 60 + times.dt.minute
        # Distance to closest funding minute modulo 480
        dist_funding = (minute_of_day % 480).apply(lambda m: min(m, 480 - m))
        df["funding_window_proximity"] = 1.0 - (dist_funding / 240.0)  # 1.0 at funding time, 0.0 at 4h away
        
        # 14. Target Labeling (Triple Barrier: 1.2x ATR profit vs 1.0x ATR adverse)
        atr_up = df["atr_pct"] * 1.2
        atr_dn = df["atr_pct"] * 1.0
        df["target_buy"] = np.where((df["target_ret_5"] >= atr_up) & (df["ret_1"] >= 0), 1, 0)
        df["target_sell"] = np.where((df["target_ret_5"] <= -atr_dn) & (df["ret_1"] <= 0), 1, 0)
        
        clean = df.dropna(subset=FEATURE_COLS + ['target_buy', 'target_sell']).copy()
        print(f"   ✓ {symbol}: ประมวลผลสำเร็จ {len(clean):,} แท่ง (Target Buy: {clean['target_buy'].mean():.1%}, Target Sell: {clean['target_sell'].mean():.1%})")
        processed_dfs.append(clean)
        
    return pd.concat(processed_dfs, ignore_index=True)

def main():
    print("=" * 80)
    print("🪙 เริ่มดึงข้อมูล Binance & สร้างชุดข้อมูล Crypto Dataset 16 Features (v2.0)")
    print("=" * 80)
    
    os.makedirs(DATA_DIR, exist_ok=True)
    raw_dict = {}
    
    for sym in SYMBOLS:
        df_sym = fetch_raw_symbol_history(sym, total_candles=3500)
        if not df_sym.empty:
            raw_dict[sym] = df_sym
            
    if len(raw_dict) < len(SYMBOLS):
        print(f"❌ ดึงข้อมูลเหรียญไม่ครบ: พบ {len(raw_dict)}/{len(SYMBOLS)} เหรียญ")
        sys.exit(1)
        
    final_df = calculate_16_features_and_targets(raw_dict)
    
    meta_cols = ['time', 'symbol', 'open', 'high', 'low', 'close', 'volume', 'target_ret_5', 'target_buy', 'target_sell']
    output_cols = meta_cols + FEATURE_COLS
    final_df = final_df[output_cols]
    
    final_df.to_csv(OUTPUT_PATH, index=False)
    print("=" * 80)
    print(f"✅ บันทึกชุดข้อมูล Crypto Dataset 16-Factor สำเร็จ: {OUTPUT_PATH}")
    print(f"   • จำนวนแถวทั้งหมด: {len(final_df):,} แถว")
    print(f"   • เหรียญในชุดข้อมูล: {', '.join(final_df['symbol'].unique())}")
    print(f"   • จำนวนฟีเจอร์: {len(FEATURE_COLS)} ตัวแปร")
    print("=" * 80)

if __name__ == "__main__":
    main()
