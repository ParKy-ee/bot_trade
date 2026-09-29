import pymysql, os
from datetime import datetime, timedelta, timezone
import MetaTrader5 as mt5

conn = pymysql.connect(
    host='127.0.0.1', user='root', password='', database='ai_trading_db',
    cursorclass=pymysql.cursors.DictCursor
)
mt5.initialize()

with conn.cursor() as cursor:
    cursor.execute("""
        SELECT id, mt5_ticket, symbol, action, entry_price, sl_price, tp_price, exit_price, pips, profit_loss, exit_time, created_at
        FROM trade_results
        WHERE decision_mode = 'LIVE'
          AND market_type = 'forex'
          AND DATE(created_at) >= '2026-09-24'
          AND exit_reason = 'CLOSED_TIME_STOP'
          AND COALESCE(pips, 0) <= 0
        ORDER BY id ASC
    """)
    trades = cursor.fetchall()

print(f"Total Negative Forex Time-Stop trades: {len(trades)}")

# Stricter simulation: Tracking state BEFORE hitting SL
rebounded_to_be_BEFORE_sl = 0
rebounded_to_stepdown_BEFORE_sl = 0
hit_sl_without_rebound = 0
hit_tp_before_sl = 0

for t in trades:
    sym = t['symbol'].replace('=X', '')
    action = t['action'].upper()
    entry_p = float(t['entry_price'])
    sl_p = float(t['sl_price']) if t.get('sl_price') else None
    tp_p = float(t['tp_price']) if t.get('tp_price') else None
    pip_size = 0.01 if 'JPY' in sym else 0.0001
    
    exit_time = t['exit_time']
    if isinstance(exit_time, str):
        exit_time = datetime.fromisoformat(exit_time.replace('Z', '+00:00'))
    if exit_time.tzinfo is not None:
        exit_time = exit_time.astimezone(timezone.utc).replace(tzinfo=None)
        
    rates = mt5.copy_rates_range(sym, mt5.TIMEFRAME_M5, exit_time, exit_time + timedelta(hours=24))
    if rates is None or len(rates) == 0:
        rates = mt5.copy_rates_from(sym, mt5.TIMEFRAME_M5, exit_time, 288)
    if rates is None or len(rates) == 0:
        continue

    trade_rebounded_be = False
    trade_rebounded_stepdown = False
    stopped_out = False
    took_profit = False

    for bar in rates:
        high = float(bar['high'])
        low = float(bar['low'])
        
        if action == 'BUY':
            curr_fav = (high - entry_p) / pip_size
            curr_adv = (low - entry_p) / pip_size
            bar_sl = (sl_p is not None and low <= sl_p)
            bar_tp = (tp_p is not None and high >= tp_p)
        else:
            curr_fav = (entry_p - low) / pip_size
            curr_adv = (entry_p - high) / pip_size
            bar_sl = (sl_p is not None and high >= sl_p)
            bar_tp = (tp_p is not None and low <= tp_p)

        # Did it hit SL before doing anything else?
        if bar_sl and not trade_rebounded_be:
            stopped_out = True
            break
            
        if curr_fav >= 0:
            trade_rebounded_be = True
        if curr_fav >= 2.0:
            trade_rebounded_stepdown = True
            
        if bar_tp:
            took_profit = True
            break
        if bar_sl:
            stopped_out = True
            break

    if took_profit:
        hit_tp_before_sl += 1
    elif stopped_out and not trade_rebounded_be:
        hit_sl_without_rebound += 1
    elif trade_rebounded_stepdown:
        rebounded_to_stepdown_BEFORE_sl += 1
    elif trade_rebounded_be:
        rebounded_to_be_BEFORE_sl += 1

total = len(trades)
print("\n=== STRICT CHRONOLOGICAL SIMULATION (BEFORE SL IS HIT) ===")
print(f"Total Trades: {total}")
print(f"1. Directly hit SL without any rebound: {hit_sl_without_rebound} orders ({hit_sl_without_rebound/total*100:.1f}%)")
print(f"2. Rebounded to Stepdown Profit (+2.0 pips) BEFORE hitting SL: {rebounded_to_stepdown_BEFORE_sl} orders ({rebounded_to_stepdown_BEFORE_sl/total*100:.1f}%)")
print(f"3. Rebounded to Breakeven (0.0 to +1.9 pips) BEFORE hitting SL: {rebounded_to_be_BEFORE_sl} orders ({rebounded_to_be_BEFORE_sl/total*100:.1f}%)")
print(f"4. Rebounded all the way to TP: {hit_tp_before_sl} orders ({hit_tp_before_sl/total*100:.1f}%)")

mt5.shutdown()
conn.close()
