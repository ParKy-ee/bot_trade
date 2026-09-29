import pymysql
import json

conn = pymysql.connect(host='127.0.0.1', user='root', database='ai_trading_db', charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor)
with conn.cursor() as cur:
    cur.execute("""
        SELECT * FROM trade_results 
        WHERE mt5_ticket = 2328846997
    """)
    t = cur.fetchone()
    print("Trade Result:", t)

    cur.execute("""
        SELECT * FROM active_positions 
        WHERE mt5_ticket = 2328846997
    """)
    pos = cur.fetchone()
    print("\nActive Position record:", pos)

    cur.execute("""
        SELECT * FROM market_pressure_observations
        WHERE symbol = 'GOLD' OR symbol = 'XAUUSD'
        ORDER BY id DESC LIMIT 20
    """)
    pressures = cur.fetchall()
    print(f"\nRecent market_pressure_observations: {len(pressures)}")
    for p in pressures:
        print(f"[{p['observed_at']}] State: {p['predicted_state']} | P(Buy): {p['prob_buy']} | P(Sell): {p['prob_sell']} | P(Indecision): {p['prob_indecision']} | Label: {p['labeled_outcome']}")

conn.close()
