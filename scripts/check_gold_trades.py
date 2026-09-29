import pymysql

conn = pymysql.connect(host='127.0.0.1', user='root', database='ai_trading_db', charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor)
with conn.cursor() as cur:
    cur.execute("SELECT * FROM trade_results WHERE market_type = 'gold' OR symbol IN ('GOLD', 'XAUUSD') ORDER BY id DESC")
    rows = cur.fetchall()
conn.close()

print(f"Total Gold Trades in DB: {len(rows)}")
today_trades = [r for r in rows if '2026-09-28' in str(r.get('entry_time', ''))]
print(f"Gold Trades Today (2026-09-28): {len(today_trades)}")
for t in today_trades:
    pnl = float(t['profit_loss']) if t['profit_loss'] is not None else 0.0
    print(f"  #{t['mt5_ticket']} {t['action']} Entry: {t['entry_price']} Exit: {t['exit_price']} PnL: ${pnl:.2f} | {t['exit_reason']} | Model: {t['model_version']}")
