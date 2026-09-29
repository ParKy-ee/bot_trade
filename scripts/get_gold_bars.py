import yfinance as yf
import pandas as pd
from datetime import datetime

df = yf.download('GC=F', period='1d', interval='5m')
print(f"Total bars downloaded: {len(df)}")
if not df.empty:
    for idx, row in df.tail(25).iterrows():
        # idx is timestamp
        print(f"{idx} | O:{row['Open'].iloc[0] if hasattr(row['Open'], 'iloc') else row['Open']:.2f} | H:{row['High'].iloc[0] if hasattr(row['High'], 'iloc') else row['High']:.2f} | L:{row['Low'].iloc[0] if hasattr(row['Low'], 'iloc') else row['Low']:.2f} | C:{row['Close'].iloc[0] if hasattr(row['Close'], 'iloc') else row['Close']:.2f}")
