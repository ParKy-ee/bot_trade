import MetaTrader5 as mt5
import pandas as pd
from datetime import datetime

if mt5.initialize():
    print("MT5 initialized successfully")
    rates = mt5.copy_rates_from_pos('GOLD', mt5.TIMEFRAME_M5, 0, 30)
    if rates is not None:
        df = pd.DataFrame(rates)
        df['time'] = pd.to_datetime(df['time'], unit='s')
        for idx, row in df.iterrows():
            print(f"{row['time']} | O:{row['open']:.2f} | H:{row['high']:.2f} | L:{row['low']:.2f} | C:{row['close']:.2f}")
    else:
        print("Rates is None for GOLD, trying XAUUSD...")
        rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 30)
        if rates is not None:
            df = pd.DataFrame(rates)
            df['time'] = pd.to_datetime(df['time'], unit='s')
            for idx, row in df.iterrows():
                print(f"{row['time']} | O:{row['open']:.2f} | H:{row['high']:.2f} | L:{row['low']:.2f} | C:{row['close']:.2f}")
    
    # Also check closed orders history in MT5!
    deals = mt5.history_deals_get(datetime(2026, 9, 28, 0, 0), datetime.now())
    if deals:
        print(f"\nDeals today: {len(deals)}")
        for d in deals:
            if d.position_id == 2328846997 or 'GOLD' in d.symbol:
                print(f"Deal: ticket={d.ticket} pos={d.position_id} sym={d.symbol} type={d.type} vol={d.volume} price={d.price} profit={d.profit} comment={d.comment}")

    mt5.shutdown()
else:
    print("Failed to init MT5")
