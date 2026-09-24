import os
import sys
import json
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

try:
    import MetaTrader5 as mt5
except ImportError:
    print(json.dumps({"error": "MetaTrader5 package not installed in Python environment"}))
    sys.exit(1)

def get_env_credentials():
    # Attempt to load credentials from .env in project root
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(base_dir, ".env")
    creds = {
        "path": r"C:\Program Files\MetaTrader 5\terminal64.exe",
        "login": None,
        "password": "",
        "server": ""
    }
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("MT5_PATH="):
                        val = line.split("=", 1)[1].strip()
                        if val: creds["path"] = val
                    elif line.startswith("MT5_LOGIN="):
                        val = line.split("=", 1)[1].strip()
                        if val: creds["login"] = int(val)
                    elif line.startswith("MT5_PASSWORD="):
                        creds["password"] = line.split("=", 1)[1].strip()
                    elif line.startswith("MT5_SERVER="):
                        creds["server"] = line.split("=", 1)[1].strip()
        except Exception:
            pass
    return creds

def init_mt5():
    creds = get_env_credentials()
    
    # 1. First try connecting to currently running terminal (fast & non-blocking)
    try:
        if mt5.initialize():
            return True, "Connected to running MT5 terminal"
    except Exception:
        pass

    # 2. Prefer the explicitly configured terminal path before trying a
    # credential-based login. When multiple terminals are open, a bare
    # initialize() can attach to a different broker terminal and return an
    # authorization error even though the configured XM terminal is ready.
    try:
        if creds.get("path") and mt5.initialize(path=creds["path"], timeout=5000):
            return True, f"Connected to configured MT5 terminal ({creds['path']})"
    except Exception:
        pass

    # 3. If credentials are provided in .env, launch and login. The MT5
    # Python API can resolve the account's server from the selected terminal,
    # so MT5_SERVER is optional. This is important when more than one MT5
    # terminal is running and the initial attach lands on the wrong one.
    if creds.get("login"):
        try:
            init_kwargs = {
                "path": creds["path"],
                "login": creds["login"],
                "password": creds["password"],
                "timeout": 5000
            }
            if creds.get("server"):
                init_kwargs["server"] = creds["server"]
            ok = mt5.initialize(**init_kwargs)
            if ok:
                return True, f"Logged into MT5 ({creds['login']} @ {creds['server']})"
        except Exception:
            pass

    last_err = mt5.last_error()
    return False, f"MT5 initialize failed (โปรแกรม MT5 ยังไม่ได้เปิด หรือยังไม่ได้ล็อกอิน): {last_err}"

STOCK_MAP = {
    "NVDA": "Nvidia",
    "TSLA": "Tesla",
    "MSFT": "Microsoft",
    "AMZN": "Amazon",
    "GOOGL": "Google",
    "GOOG": "Google",
    "META": "Facebook",
    "NFLX": "Netflix",
    "AMD": "AdvMicroDev",
    "AVGO": "Broadcom",
    "AAPL": "Apple",
    "SPY": "SPY"
}

# XM accounts may publish Gold as GOLD instead of XAUUSD. Resolve the requested
# instrument against both names before the normal broker-symbol search.
SYMBOL_ALIASES = {
    "XAUUSD": ("XAUUSD", "GOLD"),
}

def find_broker_symbol(symbol):
    """Clean symbol name and match against broker's available symbols (Forex and US Stocks)"""
    clean = symbol.replace("=X", "").upper()

    for candidate in SYMBOL_ALIASES.get(clean, (clean,)):
        s_info = mt5.symbol_info(candidate)
        if s_info:
            if not s_info.visible:
                mt5.symbol_select(candidate, True)
            return candidate
    
    # 1. Check mapped stock names in XM (e.g. NVDA -> Nvidia, TSLA -> Tesla)
    mapped = STOCK_MAP.get(clean)
    if mapped:
        s_info = mt5.symbol_info(mapped)
        if s_info:
            if not s_info.visible:
                mt5.symbol_select(mapped, True)
            return mapped

    # 2. Check direct match
    s_info = mt5.symbol_info(clean)
    if s_info:
        if not s_info.visible:
            mt5.symbol_select(clean, True)
        return clean

    # 3. Search for symbol with broker suffix
    all_symbols = mt5.symbols_get()
    if all_symbols:
        for s in all_symbols:
            if clean in s.name:
                if not s.visible:
                    mt5.symbol_select(s.name, True)
                return s.name

    return clean

def get_account():
    ok, msg = init_mt5()
    if not ok:
        return {"connected": False, "error": msg}

    acc = mt5.account_info()
    if not acc:
        return {"connected": False, "error": f"Failed to get account info: {mt5.last_error()}"}

    term = mt5.terminal_info()

    return {
        "connected": True,
        "login": acc.login,
        "name": acc.name,
        "server": acc.server,
        "currency": acc.currency,
        "leverage": acc.leverage,
        "balance": acc.balance,
        "equity": acc.equity,
        "margin": acc.margin,
        "freeMargin": acc.margin_free,
        "profit": acc.profit,
        "tradeAllowed": acc.trade_allowed,
        "tradeExpert": term.trade_allowed if term else False,
        "company": acc.company
    }

def fetch_rates(symbol, tf_str="M15", count=100):
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    tf_map = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1
    }
    timeframe = tf_map.get(tf_str.upper(), mt5.TIMEFRAME_M15)
    broker_sym = find_broker_symbol(symbol)

    rates = mt5.copy_rates_from_pos(broker_sym, timeframe, 0, count)
    if rates is None or len(rates) == 0:
        return {"error": f"Failed to copy rates for {broker_sym}: {mt5.last_error()}"}

    bars = []
    for r in rates:
        dt_str = datetime.fromtimestamp(r["time"]).strftime("%Y-%m-%d %H:%M:%S")
        bars.append({
            "time": dt_str,
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": int(r["tick_volume"])
        })
    return {"symbol": broker_sym, "timeframe": tf_str, "bars": bars}

def order_send_with_filling_fallback(req):
    filling_modes = [
        mt5.ORDER_FILLING_IOC,
        mt5.ORDER_FILLING_FOK,
        mt5.ORDER_FILLING_RETURN
    ]
    broker_sym = req.get("symbol")
    if broker_sym:
        s_info = mt5.symbol_info(broker_sym)
        if s_info and hasattr(s_info, "filling_mode"):
            fm = s_info.filling_mode
            preferred = []
            if fm & 1:
                preferred.append(mt5.ORDER_FILLING_FOK)
            if fm & 2:
                preferred.append(mt5.ORDER_FILLING_IOC)
            if not preferred:
                preferred.append(mt5.ORDER_FILLING_RETURN)
            for m in preferred:
                if m in filling_modes:
                    filling_modes.remove(m)
            filling_modes = preferred + filling_modes

    last_res = None
    for mode in filling_modes:
        req["type_filling"] = mode
        res = mt5.order_send(req)
        last_res = res
        if res is not None and res.retcode == mt5.TRADE_RETCODE_DONE:
            return res
        if res is not None and res.retcode != 10030:
            return res
    return last_res

def place_order(symbol, action, lot=0.01, sl=0.0, tp=0.0, comment="AI Trade Bot"):
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    broker_sym = find_broker_symbol(symbol)
    tick = mt5.symbol_info_tick(broker_sym)
    if not tick:
        return {"error": f"Cannot get tick info for {broker_sym}"}

    action_upper = action.upper()
    order_type = mt5.ORDER_TYPE_BUY if action_upper == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if action_upper == "BUY" else tick.bid

    # Ensure symbol info digits and volume constraints
    s_info = mt5.symbol_info(broker_sym)
    digits = s_info.digits if s_info else 5
    req_lot = float(lot)
    if s_info and hasattr(s_info, "volume_min") and s_info.volume_min > 0:
        if req_lot < s_info.volume_min:
            req_lot = float(s_info.volume_min)

    # Broker-safe stop level clamp to guarantee MT5 acceptance without error 10016
    point = s_info.point if (s_info and s_info.point) else (0.001 if "JPY" in broker_sym else 0.00001)
    spread_points = s_info.spread if (s_info and s_info.spread) else 20
    stops_level = s_info.trade_stops_level if (s_info and s_info.trade_stops_level) else 0
    min_dist_price = max(stops_level + 5, spread_points + 15) * point

    final_sl = round(float(sl), digits) if sl > 0 else 0.0
    final_tp = round(float(tp), digits) if tp > 0 else 0.0

    if order_type == mt5.ORDER_TYPE_BUY:
        if final_sl > 0 and final_sl > (price - min_dist_price):
            final_sl = round(price - min_dist_price, digits)
        if final_tp > 0 and final_tp < (price + min_dist_price):
            final_tp = round(price + min_dist_price, digits)
    else:  # SELL
        if final_sl > 0 and final_sl < (price + min_dist_price):
            final_sl = round(price + min_dist_price, digits)
        if final_tp > 0 and final_tp > (price - min_dist_price):
            final_tp = round(price - min_dist_price, digits)

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": broker_sym,
        "volume": req_lot,
        "type": order_type,
        "price": round(price, digits),
        "sl": final_sl,
        "tp": final_tp,
        "deviation": 20,
        "magic": 234000,
        "comment": str(comment)[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC
    }

    res = order_send_with_filling_fallback(req)
    if res is None or res.retcode != mt5.TRADE_RETCODE_DONE:
        retcode = res.retcode if res else "UNKNOWN"
        # If rejected specifically due to Invalid Stops (10016), retry fill with zero stops then modify post-fill
        if retcode == 10016 and (req["sl"] > 0 or req["tp"] > 0):
            req_fallback = req.copy()
            req_fallback["sl"] = 0.0
            req_fallback["tp"] = 0.0
            res_fallback = order_send_with_filling_fallback(req_fallback)
            if res_fallback and res_fallback.retcode == mt5.TRADE_RETCODE_DONE:
                # Order filled! Attempt to apply clamped stops post-fill
                ticket_id = res_fallback.order
                try:
                    modify_position(ticket_id, final_sl, final_tp)
                except Exception:
                    pass
                return {
                    "success": True,
                    "ticket": ticket_id,
                    "symbol": broker_sym,
                    "action": action_upper,
                    "volume": res_fallback.volume,
                    "price": res_fallback.price,
                    "comment": f"{res_fallback.comment} (stops deferred)"
                }
        comment_str = res.comment if res else "No response"
        return {
            "success": False,
            "error": f"Order failed (code {retcode}): {comment_str}"
        }

    return {
        "success": True,
        "ticket": res.order,
        "symbol": broker_sym,
        "action": action_upper,
        "volume": res.volume,
        "price": res.price,
        "comment": res.comment
    }

def modify_position(ticket, sl, tp=0.0):
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    ticket_id = int(ticket)
    positions = mt5.positions_get(ticket=ticket_id)
    if not positions:
        return {"error": f"Position ticket {ticket_id} not found on MT5"}

    pos = positions[0]
    s_info = mt5.symbol_info(pos.symbol)
    digits = s_info.digits if s_info else 5
    point = s_info.point if (s_info and s_info.point) else (0.001 if "JPY" in pos.symbol else 0.00001)
    tick = mt5.symbol_info_tick(pos.symbol)
    cur_price = tick.bid if pos.type == mt5.ORDER_TYPE_SELL else (tick.ask if tick else pos.price_open)
    spread_points = s_info.spread if (s_info and s_info.spread) else 20
    stops_level = s_info.trade_stops_level if (s_info and s_info.trade_stops_level) else 0
    min_dist_price = max(stops_level + 5, spread_points + 15) * point

    mod_sl = round(float(sl), digits) if sl > 0 else pos.sl
    mod_tp = round(float(tp), digits) if tp > 0 else pos.tp

    if pos.type == mt5.ORDER_TYPE_BUY:
        if mod_sl > 0 and mod_sl > (cur_price - min_dist_price):
            mod_sl = round(cur_price - min_dist_price, digits)
        if mod_tp > 0 and mod_tp < (cur_price + min_dist_price):
            mod_tp = round(cur_price + min_dist_price, digits)
    else:  # SELL
        if mod_sl > 0 and mod_sl < (cur_price + min_dist_price):
            mod_sl = round(cur_price + min_dist_price, digits)
        if mod_tp > 0 and mod_tp > (cur_price - min_dist_price):
            mod_tp = round(cur_price - min_dist_price, digits)

    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket_id,
        "symbol": pos.symbol,
        "sl": mod_sl,
        "tp": mod_tp
    }

    res = mt5.order_send(req)
    if res.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": f"Modify failed (code {res.retcode}): {res.comment}"}

    return {"success": True, "ticket": ticket_id, "sl": req["sl"], "tp": req["tp"]}

def close_position(ticket, volume=None):
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    ticket_id = int(ticket)
    positions = mt5.positions_get(ticket=ticket_id)
    if not positions:
        return {"error": f"Position ticket {ticket_id} not found on MT5"}

    pos = positions[0]
    tick = mt5.symbol_info_tick(pos.symbol)
    if not tick:
        return {"error": f"Cannot get tick info for {pos.symbol}"}

    order_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask

    close_vol = float(pos.volume)
    if volume is not None and float(volume) > 0 and float(volume) < float(pos.volume):
        close_vol = float(volume)

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": ticket_id,
        "symbol": pos.symbol,
        "volume": close_vol,
        "type": order_type,
        "price": price,
        "deviation": 20,
        "magic": 234000,
        "comment": "Partial Close" if close_vol < float(pos.volume) else "Close Position",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC
    }
    res = order_send_with_filling_fallback(req)
    if res is None or res.retcode != mt5.TRADE_RETCODE_DONE:
        retcode = res.retcode if res else "UNKNOWN"
        comment_str = res.comment if res else "No response"
        return {"success": False, "error": f"Close failed (code {retcode}): {comment_str}"}

    return {
        "success": True,
        "ticket": ticket_id,
        "symbol": pos.symbol,
        "price": res.price,
        "volume": res.volume,
        "remaining_volume": round(float(pos.volume) - close_vol, 4) if close_vol < float(pos.volume) else 0.0,
        "comment": res.comment
    }

def get_positions():
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    pos_list = mt5.positions_get()
    if pos_list is None:
        return []

    result = []
    for p in pos_list:
        result.append({
            "ticket": p.ticket,
            "time": datetime.fromtimestamp(p.time).strftime("%Y-%m-%d %H:%M:%S"),
            "symbol": p.symbol,
            "type": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "volume": p.volume,
            "priceOpen": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "priceCurrent": p.price_current,
            "profit": p.profit,
            "comment": p.comment
        })
    return result

def get_closed_deals():
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    from datetime import datetime, timedelta
    deals = mt5.history_deals_get(datetime.now() - timedelta(days=7), datetime.now() + timedelta(days=1))
    if not deals:
        return []

    result = []
    for d in deals:
        # entry == 1 indicates an exit / closing deal in MT5
        if getattr(d, 'entry', None) == 1:
            result.append({
                "deal": d.ticket,
                "position": d.position_id,
                "symbol": d.symbol,
                "volume": d.volume,
                "price": d.price,
                "profit": d.profit,
                "swap": getattr(d, 'swap', 0.0),
                "commission": getattr(d, 'commission', 0.0),
                "fee": getattr(d, 'fee', 0.0),
                "netProfit": float(
                    getattr(d, 'profit', 0.0)
                    + getattr(d, 'swap', 0.0)
                    + getattr(d, 'commission', 0.0)
                    + getattr(d, 'fee', 0.0)
                ),
                "comment": d.comment,
                "time": datetime.fromtimestamp(d.time).strftime("%Y-%m-%d %H:%M:%S")
            })
    return result

def place_pending_order(symbol, order_type_str, price, lot=0.01, sl=0.0, tp=0.0, expiration_minutes=45, comment="AI Pending Bot"):
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    broker_sym = find_broker_symbol(symbol)
    type_str = str(order_type_str).upper().strip()

    type_map = {
        "BUY_LIMIT": mt5.ORDER_TYPE_BUY_LIMIT,
        "SELL_LIMIT": mt5.ORDER_TYPE_SELL_LIMIT,
        "BUY_STOP": mt5.ORDER_TYPE_BUY_STOP,
        "SELL_STOP": mt5.ORDER_TYPE_SELL_STOP
    }

    if type_str not in type_map:
        return {"error": f"Unsupported pending order type: {order_type_str}. Use BUY_LIMIT, SELL_LIMIT, BUY_STOP, or SELL_STOP"}

    mt5_type = type_map[type_str]
    s_info = mt5.symbol_info(broker_sym)
    if not s_info:
        return {"error": f"Symbol {broker_sym} not found"}
    digits = s_info.digits if s_info else 5
    req_lot = float(lot)
    if hasattr(s_info, "volume_min") and s_info.volume_min > 0:
        if req_lot < s_info.volume_min:
            req_lot = float(s_info.volume_min)

    req = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": broker_sym,
        "volume": req_lot,
        "type": mt5_type,
        "price": round(float(price), digits),
        "sl": round(float(sl), digits) if sl > 0 else 0.0,
        "tp": round(float(tp), digits) if tp > 0 else 0.0,
        "deviation": 20,
        "magic": 234000,
        "comment": str(comment)[:31],
        "type_filling": mt5.ORDER_FILLING_RETURN
    }

    if expiration_minutes and float(expiration_minutes) > 0:
        tick = mt5.symbol_info_tick(broker_sym)
        base_time = tick.time if (tick and getattr(tick, 'time', 0) > 0) else int(datetime.now().timestamp())
        req["type_time"] = mt5.ORDER_TIME_SPECIFIED
        req["expiration"] = int(base_time + (float(expiration_minutes) * 60))
    else:
        req["type_time"] = mt5.ORDER_TIME_GTC

    res = mt5.order_send(req)
    if res.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "success": False,
            "error": f"Pending order failed (code {res.retcode}): {res.comment}"
        }

    return {
        "success": True,
        "ticket": res.order,
        "symbol": broker_sym,
        "type": type_str,
        "volume": res.volume,
        "price": round(float(price), digits),
        "sl": req["sl"],
        "tp": req["tp"],
        "comment": res.comment,
        "expiration": req.get("expiration")
    }

def get_pending_orders():
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    orders = mt5.orders_get()
    if orders is None:
        return []

    type_reverse_map = {
        mt5.ORDER_TYPE_BUY_LIMIT: "BUY_LIMIT",
        mt5.ORDER_TYPE_SELL_LIMIT: "SELL_LIMIT",
        mt5.ORDER_TYPE_BUY_STOP: "BUY_STOP",
        mt5.ORDER_TYPE_SELL_STOP: "SELL_STOP",
        mt5.ORDER_TYPE_BUY: "BUY",
        mt5.ORDER_TYPE_SELL: "SELL"
    }

    result = []
    for o in orders:
        result.append({
            "ticket": o.ticket,
            "timeSetup": datetime.fromtimestamp(o.time_setup).strftime("%Y-%m-%d %H:%M:%S") if o.time_setup else None,
            "symbol": o.symbol,
            "type": type_reverse_map.get(o.type, str(o.type)),
            "volumeInitial": o.volume_initial,
            "volumeCurrent": o.volume_current,
            "priceOpen": o.price_open,
            "sl": o.sl,
            "tp": o.tp,
            "priceCurrent": o.price_current,
            "comment": o.comment,
            "timeExpiration": datetime.fromtimestamp(o.time_expiration).strftime("%Y-%m-%d %H:%M:%S") if o.time_expiration else None
        })
    return result

def cancel_order(ticket):
    ok, msg = init_mt5()
    if not ok:
        return {"error": msg}

    ticket_id = int(ticket)
    req = {
        "action": mt5.TRADE_ACTION_REMOVE,
        "order": ticket_id
    }
    res = mt5.order_send(req)
    if res.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": f"Cancel order failed (code {res.retcode}): {res.comment}"}

    return {"success": True, "ticket": ticket_id, "comment": res.comment}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command argument provided"}))
        sys.exit(1)

    cmd = sys.argv[1]

    try:
        if cmd == "--account":
            res = get_account()
            print(json.dumps(res))

        elif cmd == "--rates":
            symbol = sys.argv[2] if len(sys.argv) > 2 else "EURUSD"
            tf = sys.argv[3] if len(sys.argv) > 3 else "M15"
            count = int(sys.argv[4]) if len(sys.argv) > 4 else 100
            res = fetch_rates(symbol, tf, count)
            print(json.dumps(res))

        elif cmd == "--order":
            payload_str = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
            data = json.loads(payload_str)
            res = place_order(
                data["symbol"],
                data["action"],
                data.get("lot", 0.01),
                data.get("sl", 0.0),
                data.get("tp", 0.0),
                data.get("comment", "AI Trade Bot")
            )
            print(json.dumps(res))

        elif cmd == "--pending-order":
            payload_str = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
            data = json.loads(payload_str)
            res = place_pending_order(
                symbol=data["symbol"],
                order_type_str=data["type"],
                price=data["price"],
                lot=data.get("lot", 0.01),
                sl=data.get("sl", 0.0),
                tp=data.get("tp", 0.0),
                expiration_minutes=data.get("expirationMinutes", 45),
                comment=data.get("comment", "AI Pending Bot")
            )
            print(json.dumps(res))

        elif cmd == "--pending-list":
            res = get_pending_orders()
            print(json.dumps(res))

        elif cmd == "--cancel-order":
            ticket = sys.argv[2]
            res = cancel_order(ticket)
            print(json.dumps(res))

        elif cmd == "--modify":
            ticket = sys.argv[2]
            sl = float(sys.argv[3])
            tp = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
            res = modify_position(ticket, sl, tp)
            print(json.dumps(res))

        elif cmd == "--close":
            ticket = sys.argv[2]
            volume = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != "" else None
            res = close_position(ticket, volume)
            print(json.dumps(res))

        elif cmd == "--positions":
            res = get_positions()
            print(json.dumps(res))

        elif cmd == "--closed-deals":
            res = get_closed_deals()
            print(json.dumps(res))

        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}))
            sys.exit(1)

    finally:
        mt5.shutdown()

if __name__ == "__main__":
    main()
