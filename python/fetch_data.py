import os
import sys
import json
import warnings

warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, ".yfinance_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# yfinance only needs platformdirs here to choose a cache directory. Keep the
# data fetch usable in the bot's existing Python environment when that small
# optional dependency is missing; the bot already supplies an explicit cache
# location immediately after import.
try:
    import platformdirs  # noqa: F401
except ModuleNotFoundError:
    import types
    platformdirs = types.ModuleType('platformdirs')
    platformdirs.user_cache_dir = lambda appname=None, *args, **kwargs: os.path.join(
        CACHE_DIR, str(appname or 'platformdirs-cache')
    )
    sys.modules['platformdirs'] = platformdirs

import yfinance as yf
yf.set_tz_cache_location(CACHE_DIR)

DEFAULT_UNIVERSE = ["NVDA", "AMD", "TSLA", "MSFT", "AVGO", "NFLX", "AMZN", "META", "GOOGL", "SPY"]

def fetch_tickers(tickers, period="1y", interval="1d"):
    try:
        # Guarantee at least 2 tickers so group_by='ticker' is always consistent
        req_tickers = list(tickers)
        dummy_added = False
        if len(req_tickers) == 1 and "SPY" not in req_tickers:
            req_tickers.append("SPY")
            dummy_added = True
        elif len(req_tickers) == 1 and "SPY" in req_tickers:
            req_tickers.append("QQQ")
            dummy_added = True

        data = yf.download(
            tickers=req_tickers,
            period=period,
            interval=interval,
            group_by="ticker",
            auto_adjust=False,
            progress=False,
            threads=True,
            timeout=30
        )
    except Exception as e:
        return {"error": str(e)}

    if data is None or data.empty:
        return {"error": "No data returned from Yahoo Finance"}

    results = {}
    for symbol in tickers:
        try:
            if symbol in data.columns.levels[0]:
                df = data[symbol].dropna(how="all").reset_index()
            else:
                continue

            if df.empty or len(df) < 5:
                continue

            # Standardize column names
            col_map = {}
            for c in df.columns:
                lc = str(c).lower()
                if "date" in lc or "time" in lc:
                    col_map[c] = "time"
                elif lc == "open":
                    col_map[c] = "open"
                elif lc == "high":
                    col_map[c] = "high"
                elif lc == "low":
                    col_map[c] = "low"
                elif lc == "close":
                    col_map[c] = "close"
                elif lc == "volume":
                    col_map[c] = "volume"

            df = df.rename(columns=col_map)
            bars = []
            for _, row in df.iterrows():
                time_val = str(row["time"]).replace("T", " ").split("+")[0]
                bars.append({
                    "time": time_val,
                    "open": round(float(row["open"]), 5) if not str(row["open"]).lower() == "nan" else None,
                    "high": round(float(row["high"]), 5) if not str(row["high"]).lower() == "nan" else None,
                    "low": round(float(row["low"]), 5) if not str(row["low"]).lower() == "nan" else None,
                    "close": round(float(row["close"]), 5) if not str(row["close"]).lower() == "nan" else None,
                    "volume": int(row["volume"]) if not str(row["volume"]).lower() == "nan" else 0
                })
            results[symbol] = bars
        except Exception:
            continue

    return results

if __name__ == "__main__":
    period = "1y"
    interval = "1d"
    tickers = DEFAULT_UNIVERSE

    for arg in sys.argv[1:]:
        if arg.startswith("--tickers="):
            tickers = [t.strip() for t in arg.replace("--tickers=", "").split(",")]
        elif arg.startswith("--period="):
            period = arg.replace("--period=", "")
        elif arg.startswith("--interval="):
            interval = arg.replace("--interval=", "")
        elif arg == "--all":
            tickers = DEFAULT_UNIVERSE
        elif not arg.startswith("--"):
            tickers = [t.strip() for t in arg.split(",")]

    res = fetch_tickers(tickers, period, interval)
    print(json.dumps(res))
