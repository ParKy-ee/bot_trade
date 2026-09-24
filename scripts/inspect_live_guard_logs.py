import json
import os
import sys
import mysql.connector

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

# Connect to XAMPP MySQL
try:
    conn = mysql.connector.connect(
        host="127.0.0.1",
        port=3306,
        user="root",
        password="",
        database="ai_trading_db"
    )
    cursor = conn.cursor(dictionary=True)
except Exception as e:
    print(f"Database connection error: {e}")
    sys.exit(1)

print("=" * 80)
print("📊 REAL-TIME GUARD PERFORMANCE & FILTERING AUDIT (Today 2026-09-23)")
print("=" * 80)

# 1. Audit forex_ml_observations for today
cursor.execute("""
    SELECT sample_kind, COUNT(*) as cnt
    FROM forex_ml_observations
    WHERE DATE(created_at) = '2026-09-23'
    GROUP BY sample_kind
""")
obs_counts = cursor.fetchall()
obs_dict = {r['sample_kind']: r['cnt'] for r in obs_counts}
total_obs = sum(obs_dict.values())
signals_cnt = obs_dict.get('SIGNAL', 0)
rejected_cnt = obs_dict.get('REJECTED', 0)
no_trade_cnt = obs_dict.get('NO_TRADE', 0)

candidates = signals_cnt + rejected_cnt
rejection_pct = (rejected_cnt / candidates * 100.0) if candidates > 0 else 0.0

print(f"\n1. Forex ML Observation Pipeline:")
print(f"   - Total Observations Evaluated Today: {total_obs:,} bars")
print(f"   - Qualified Setup Candidates:         {candidates:,}")
print(f"   - Signals Passed & Entered:           {signals_cnt:,} ({100 - rejection_pct:.1f}%)")
print(f"   - Orders Vetoed / Blocked by Guards:  {rejected_cnt:,} ({rejection_pct:.1f}%)")
print(f"   - No Setup Formed (Baseline filter):  {no_trade_cnt:,}")

# 2. Rejection Reasons Breakdown
cursor.execute("""
    SELECT reasons, COUNT(*) as cnt
    FROM forex_ml_observations
    WHERE DATE(created_at) = '2026-09-23' AND sample_kind = 'REJECTED'
    GROUP BY reasons
    ORDER BY cnt DESC
    LIMIT 10
""")
top_reasons = cursor.fetchall()
print(f"\n2. Top Rejection Reasons by Guards (Why Orders Were Cut):")
for r in top_reasons:
    reason_txt = r['reasons'][:95] if r['reasons'] else 'Unknown'
    print(f"   [{r['cnt']:4d} times] {reason_txt}")

# 3. Pocket Evaluation Signals today (Live vs Shadow)
cursor.execute("""
    SELECT decision_mode, COUNT(*) as cnt
    FROM trade_results
    WHERE DATE(created_at) = '2026-09-23' AND market_type LIKE 'forex%'
    GROUP BY decision_mode
""")
decisions = cursor.fetchall()
print(f"\n3. Forex Trade Routing Today (Live vs Shadow/Blocked):")
for d in decisions:
    print(f"   - {d['decision_mode'] or 'DEFAULT'}: {d['cnt']} trades")

# 4. Crypto Today
cursor.execute("""
    SELECT symbol, action, is_win, profit_loss, exit_reason, created_at
    FROM trade_results
    WHERE DATE(created_at) = '2026-09-23' AND market_type = 'crypto'
    ORDER BY id DESC
    LIMIT 10
""")
crypto_trades = cursor.fetchall()
print(f"\n4. Recent Crypto Trades Today:")
for ct in crypto_trades:
    win_str = "🟢 WIN" if ct['is_win'] == 1 else ("🔴 LOSS" if ct['is_win'] == 0 else "⏳ OPEN")
    pnl = f"${float(ct['profit_loss']):+.2f}" if ct['profit_loss'] is not None else "$0.00"
    print(f"   - {ct['created_at']} | {ct['symbol']:7} {ct['action']:4} | {win_str:7} | PnL: {pnl:7} | Reason: {ct['exit_reason']}")

# 5. Currently Active Positions
cursor.execute("""
    SELECT symbol, market_type, entry_price, highest_price, sl_price, tp_price, status_note, updated_at
    FROM active_positions
    WHERE status_note NOT LIKE 'CLOSED%'
""")
active_pos = cursor.fetchall()
print(f"\n5. Currently Active Open Positions ({len(active_pos)} positions):")
for p in active_pos:
    print(f"   - [{p['market_type'].upper()}] {p['symbol']:8} | Entry: {p['entry_price']} | SL: {p['sl_price']} | TP: {p['tp_price']} | Note: {p['status_note']}")

print("=" * 80)
conn.close()
