import re
import sys
sys.stdout.reconfigure(encoding='utf-8')

log_files = [
    r"C:\Users\GF\.gemini\antigravity-cli\brain\15c3d84b-364f-4f67-a9d8-21ef1efa6af8\.system_generated\tasks\task-1963.log",
    r"C:\Users\GF\.gemini\antigravity-cli\brain\15c3d84b-364f-4f67-a9d8-21ef1efa6af8\.system_generated\tasks\task-2359.log"
]

all_lines = []
for fpath in log_files:
    try:
        with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
            all_lines.extend(f.readlines())
    except Exception as e:
        print(f"Error reading {fpath}: {e}")

print(f"Total lines read: {len(all_lines)}")

in_target_window = False
current_timestamp = ""

gold_related = []
for line in all_lines:
    m = re.search(r'\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]', line)
    if m:
        current_timestamp = m.group(1)
        if "2026-09-28T09:14" <= current_timestamp <= "2026-09-28T10:40":
            in_target_window = True
        else:
            in_target_window = False

    if in_target_window:
        if any(k in line for k in ["GOLD", "XAUUSD", "2328846997", "Gold", "Time-Stop", "Early Cut", "Break-Even", "Micro-Scalp", "Pressure Exit"]):
            gold_related.append((current_timestamp, line.strip()))

print(f"\nFound {len(gold_related)} Gold-related log entries during the trade window:")
for ts, text in gold_related:
    print(f"[{ts}] {text}")
