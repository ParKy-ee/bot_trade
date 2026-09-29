import MetaTrader5 as mt5
from datetime import datetime, timedelta

if mt5.initialize():
    deals = mt5.history_deals_get(datetime.now() - timedelta(days=2), datetime.now() + timedelta(days=1))
    print(f"Total deals in window: {len(deals) if deals else 0}")
    if deals:
        for d in deals:
            if d.position_id == 2328846997 or '2328846997' in str(d.comment) or (d.symbol == 'GOLD' and d.time > 1790600000):
                print(f"Ticket:{d.ticket} Pos:{d.position_id} Type:{d.type} Vol:{d.volume} Price:{d.price} Profit:{d.profit} Comment:{d.comment} Time:{datetime.fromtimestamp(d.time)}")
            # Also let's print the last 10 gold deals
        print("\n--- LAST 10 GOLD DEALS ---")
        gold_deals = [d for d in deals if d.symbol == 'GOLD']
        for d in gold_deals[-10:]:
            print(f"Ticket:{d.ticket} Pos:{d.position_id} Type:{d.type} Vol:{d.volume} Price:{d.price} Profit:{d.profit} Comment:{d.comment} Time:{datetime.fromtimestamp(d.time)}")
    mt5.shutdown()
