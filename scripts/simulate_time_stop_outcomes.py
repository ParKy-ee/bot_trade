import os
import pymysql
from datetime import datetime, timedelta, timezone
import MetaTrader5 as mt5

# Connect to MySQL
conn = pymysql.connect(
    host=os.getenv('DB_HOST', '127.0.0.1'),
    user=os.getenv('DB_USER', 'root'),
    password=os.getenv('DB_PASSWORD', ''),
    database=os.getenv('DB_NAME', 'ai_trading_db'),
    cursorclass=pymysql.cursors.DictCursor
)

# Connect to MT5
if not mt5.initialize():
    print("MT5 initialization failed:", mt5.last_error())
    exit(1)

print("MT5 initialized successfully!")

with conn.cursor() as cursor:
    cursor.execute("""
        SELECT id, mt5_ticket, symbol, action, entry_price, sl_price, tp_price, exit_price, pips, profit_loss, exit_time, created_at
        FROM trade_results
        WHERE decision_mode = 'LIVE'
          AND market_type = 'forex'
          AND DATE(created_at) >= '2026-09-24'
          AND exit_reason = 'CLOSED_TIME_STOP'
        ORDER BY id ASC
    """)
    trades = cursor.fetchall()

print(f"Total Forex CLOSED_TIME_STOP trades found: {len(trades)}")

# Separate negative trades vs all trades
neg_trades = [t for t in trades if float(t.get('pips') or 0) <= 0]
print(f"Forex CLOSED_TIME_STOP negative trades: {len(neg_trades)}")

def analyze_trade_trajectory(trade):
    sym = trade['symbol'].replace('=X', '')
    action = trade['action'].upper()
    entry_p = float(trade['entry_price'])
    sl_p = float(trade['sl_price']) if trade.get('sl_price') else None
    tp_p = float(trade['tp_price']) if trade.get('tp_price') else None
    exit_p = float(trade['exit_price']) if trade.get('exit_price') else entry_p
    pip_size = 0.01 if 'JPY' in sym else 0.0001
    
    # Time conversion: DB timestamps are UTC
    exit_time = trade['exit_time']
    if isinstance(exit_time, str):
        exit_time = datetime.fromisoformat(exit_time.replace('Z', '+00:00'))
    if exit_time.tzinfo is not None:
        exit_time = exit_time.astimezone(timezone.utc).replace(tzinfo=None)
    
    # We look forward up to 24 hours (or 288 M5 bars)
    from_time = exit_time
    to_time = exit_time + timedelta(hours=24)
    
    rates = mt5.copy_rates_range(sym, mt5.TIMEFRAME_M5, from_time, to_time)
    if rates is None or len(rates) == 0:
        # Fallback to copy_rates_from
        rates = mt5.copy_rates_from(sym, mt5.TIMEFRAME_M5, from_time, 288)
        
    if rates is None or len(rates) == 0:
        return None

    # Track what happens
    hit_tp = False
    hit_sl = False
    hit_be = False # reached entry price
    hit_stepdown = False # reached +2.0 pips profit
    first_hit = None # 'TP', 'SL', or 'NEITHER'
    
    max_fav_pips = -999.0
    max_adv_pips = 999.0
    
    # Track pips at 1h (12 bars), 2h (24 bars), 4h (48 bars)
    pips_1h = None
    pips_2h = None
    pips_4h = None

    for i, bar in enumerate(rates):
        high = float(bar['high'])
        low = float(bar['low'])
        close = float(bar['close'])
        
        if action == 'BUY':
            curr_fav = (high - entry_p) / pip_size
            curr_adv = (low - entry_p) / pip_size
            close_pips = (close - entry_p) / pip_size
            
            # Check TP / SL hit
            bar_hit_sl = (sl_p is not None and low <= sl_p)
            bar_hit_tp = (tp_p is not None and high >= tp_p)
            
            if curr_fav >= 0:
                hit_be = True
            if curr_fav >= 2.0:
                hit_stepdown = True
                
        else: # SELL
            curr_fav = (entry_p - low) / pip_size
            curr_adv = (entry_p - high) / pip_size
            close_pips = (entry_p - close) / pip_size
            
            bar_hit_sl = (sl_p is not None and high >= sl_p)
            bar_hit_tp = (tp_p is not None and low <= tp_p)
            
            if curr_fav >= 0:
                hit_be = True
            if curr_fav >= 2.0:
                hit_stepdown = True

        if curr_fav > max_fav_pips:
            max_fav_pips = curr_fav
        if curr_adv < max_adv_pips:
            max_adv_pips = curr_adv

        if first_hit is None:
            if bar_hit_sl and bar_hit_tp:
                # Collision bar: conservative assumes SL
                first_hit = 'SL'
                hit_sl = True
            elif bar_hit_sl:
                first_hit = 'SL'
                hit_sl = True
            elif bar_hit_tp:
                first_hit = 'TP'
                hit_tp = True

        if i == 11: # ~1 hour
            pips_1h = close_pips
        if i == 23: # ~2 hours
            pips_2h = close_pips
        if i == 47: # ~4 hours
            pips_4h = close_pips

    if first_hit is None:
        first_hit = 'NEITHER'

    return {
        'id': trade['id'],
        'symbol': sym,
        'action': action,
        'cut_pips': float(trade['pips'] or 0),
        'cut_usd': float(trade['profit_loss'] or 0),
        'first_hit': first_hit,
        'hit_be': hit_be,
        'hit_stepdown': hit_stepdown,
        'max_fav_pips': max_fav_pips,
        'max_adv_pips': max_adv_pips,
        'pips_1h': pips_1h,
        'pips_2h': pips_2h,
        'pips_4h': pips_4h,
        'total_bars': len(rates)
    }

results = []
for t in neg_trades:
    res = analyze_trade_trajectory(t)
    if res:
        results.append(res)

print(f"\nSuccessfully simulated: {len(results)} / {len(neg_trades)} trades")

# Compile Statistics
total = len(results)
tp_first = sum(1 for r in results if r['first_hit'] == 'TP')
sl_first = sum(1 for r in results if r['first_hit'] == 'SL')
neither = sum(1 for r in results if r['first_hit'] == 'NEITHER')

hit_be_count = sum(1 for r in results if r['hit_be'])
hit_stepdown_count = sum(1 for r in results if r['hit_stepdown'])

print("\n=======================================================")
print("=== SIMULATION RESULTS: IF CLOSED_TIME_STOP WAS NOT CUT ===")
print("=======================================================")
print(f"Total Negative Forex Time-Stop Orders: {total}")
print(f"1. Hit SL First (Losing deeper / Full SL): {sl_first} orders ({sl_first/total*100:.1f}%)")
print(f"2. Hit TP First (Rebounded to Full TP Win): {tp_first} orders ({tp_first/total*100:.1f}%)")
print(f"3. Still in range (Neither hit in 24h): {neither} orders ({neither/total*100:.1f}%)")
print(f"\n--- Recovery / Short Scalp Opportunities ---")
print(f"* Rebounded to Breakeven (Entry Price): {hit_be_count} orders ({hit_be_count/total*100:.1f}%)")
print(f"* Rebounded to +2.0 pips (Stepdown Profit): {hit_stepdown_count} orders ({hit_stepdown_count/total*100:.1f}%)")

# Compare PnL if cut vs if let run to SL/TP
cut_usd_sum = sum(r['cut_usd'] for r in results)
cut_pips_sum = sum(r['cut_pips'] for r in results)

# Actual simulated PnL if let run
simulated_pips_sum = 0.0
for r in results:
    if r['first_hit'] == 'TP':
        simulated_pips_sum += 15.0 # Average TP distance
    elif r['first_hit'] == 'SL':
        simulated_pips_sum -= 10.0 # Average SL distance
    else:
        simulated_pips_sum += (r['pips_4h'] if r['pips_4h'] is not None else r['cut_pips'])

print(f"\n--- Total Pips Impact ---")
print(f"* Pips when cut by Time-Stop: {cut_pips_sum:.1f} pips ({cut_usd_sum:.2f} USD)")
print(f"* Pips if let run: {simulated_pips_sum:.1f} pips")

mt5.shutdown()
conn.close()
