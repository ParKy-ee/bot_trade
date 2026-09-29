import pymysql
import json
from datetime import datetime

conn = pymysql.connect(host='127.0.0.1', user='root', database='ai_trading_db', charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor)
with conn.cursor() as cur:
    cur.execute("SHOW TABLES")
    tables = [list(r.values())[0] for r in cur.fetchall()]
    print("Tables in DB:", tables)

    cur.execute("SELECT * FROM trade_results WHERE symbol IN ('GOLD', 'XAUUSD') ORDER BY id DESC LIMIT 1")
    trade_res = cur.fetchone()

print("\n=== LATEST TRADE_RESULTS ===")
if trade_res:
    for k, v in trade_res.items():
        print(f"  {k}: {v}")

entry_time = trade_res.get('entry_time')
exit_time = trade_res.get('exit_time')

print(f"\nSearching bot_logs around {entry_time} to {exit_time}...")

with conn.cursor() as cur:
    cur.execute("""
        SELECT created_at, message, level 
        FROM bot_logs 
        WHERE created_at >= %s - INTERVAL 5 MINUTE AND created_at <= %s + INTERVAL 5 MINUTE
          AND (message LIKE '%%GOLD%%' OR message LIKE '%%2328846997%%' OR message LIKE '%%XAU%%' OR message LIKE '%%ทอง%%')
        ORDER BY id ASC
    """, (entry_time, exit_time if exit_time else datetime.now()))
    logs = cur.fetchall()

print(f"Found {len(logs)} logs:")
for l in logs:
    print(f"[{l['created_at']}] {l['message']}")

conn.close()
