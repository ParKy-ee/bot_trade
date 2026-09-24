import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import json, urllib.request, os, sys

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT_DIR = r'C:\Users\GF\.gemini\antigravity\brain\7880765e-10c4-4ad5-bd5c-7e9875980ffa'
PUBLIC_DIR = os.path.join(ROOT_DIR, 'public')

def fetch_trades(market='all'):
    url = f'http://localhost:3000/api/trade-results?market={market}&limit=200'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"❌ Failed to fetch trade results ({market}): {e}")
        return []

def generate_separated_results_plots():
    trades = fetch_trades('all')
    if not trades:
        print("⚠️ No trade data found.")
        return False

    df = pd.DataFrame(trades)
    forex_df = df[df['market_type'] == 'forex'].copy()
    stock_df = df[df['market_type'] == 'stock'].copy()

    print(f"[*] Loaded {len(df)} total trades: Forex={len(forex_df)}, Stock={len(stock_df)}")

    # Color Palette & Style
    plt.style.use('seaborn-v0_8-darkgrid' if 'seaborn-v0_8-darkgrid' in plt.style.available else 'default')
    fig, axes = plt.subplots(2, 2, figsize=(17, 12), facecolor='#0f172a')

    accent_blue = '#38bdf8'
    accent_green = '#22c55e'
    accent_red = '#ef4444'
    accent_gold = '#eab308'
    accent_purple = '#818cf8'
    accent_cyan = '#06b6d4'
    text_color = '#f8fafc'
    grid_color = '#334155'

    for ax in axes.flat:
        ax.set_facecolor('#1e293b')
        ax.tick_params(colors=text_color, labelsize=10)
        ax.xaxis.label.set_color(text_color)
        ax.yaxis.label.set_color(text_color)
        ax.title.set_color(text_color)
        for spine in ax.spines.values():
            spine.set_color(grid_color)
        ax.grid(True, color=grid_color, linestyle='--', alpha=0.5)

    # ==================== 1. FOREX: Cumulative Pips ====================
    ax1 = axes[0, 0]
    fx_closed = forex_df[forex_df['pips'].notna()].sort_values('id').copy()
    if len(fx_closed) > 0:
        fx_closed['cum_pips'] = fx_closed['pips'].astype(float).cumsum()
        x_vals = range(1, len(fx_closed) + 1)
        ax1.plot(x_vals, fx_closed['cum_pips'], marker='o', linewidth=2.5, color=accent_blue, label='Forex Cumulative Pips')

        fx_wins = fx_closed[fx_closed['is_win'] == 1]
        fx_losses = fx_closed[fx_closed['is_win'] == 0]

        ax1.scatter([fx_closed.index.get_loc(i) + 1 for i in fx_wins.index], fx_wins['cum_pips'], color=accent_green, s=120, zorder=5, label='Forex Win (TP)')
        ax1.scatter([fx_closed.index.get_loc(i) + 1 for i in fx_losses.index], fx_losses['cum_pips'], color=accent_red, s=80, zorder=5, label='Forex Loss (SL)')

        wr = (len(fx_wins) / len(fx_closed)) * 100 if len(fx_closed) > 0 else 0
        tot_pips = fx_closed['cum_pips'].iloc[-1]
        ax1.text(0.04, 0.15, f'Forex Closed: {len(fx_closed)} | Win Rate: {wr:.1f}%\nTotal Pips: {tot_pips:+.1f} pips', 
                 transform=ax1.transAxes, color=text_color, fontsize=10, fontweight='bold',
                 bbox=dict(boxstyle='round,pad=0.5', facecolor='#0f172a', edgecolor=accent_blue, alpha=0.9))

    ax1.axhline(0, color='#94a3b8', linestyle=':', alpha=0.7)
    ax1.set_title('1. Forex M5 Scalping: Cumulative Pips Trajectory', fontsize=12, fontweight='bold', pad=10)
    ax1.set_xlabel('Closed Trade Order (#)', fontsize=10)
    ax1.set_ylabel('Cumulative Pips', fontsize=10)
    ax1.legend(loc='lower left', facecolor='#1e293b', edgecolor=grid_color, labelcolor=text_color)

    # ==================== 2. FOREX: Pips by Currency Pair ====================
    ax2 = axes[0, 1]
    if len(fx_closed) > 0:
        pair_pips = fx_closed.groupby('symbol')['pips'].sum().reset_index()
        bar_colors = [accent_green if p > 0 else accent_red for p in pair_pips['pips']]
        clean_labels = [s.replace('=X', '') for s in pair_pips['symbol']]
        bars2 = ax2.bar(clean_labels, pair_pips['pips'], color=bar_colors, width=0.55, edgecolor='#0f172a')

        for bar in bars2:
            h = bar.get_height()
            y_pos = h + 1 if h >= 0 else h - 4
            ax2.text(bar.get_x() + bar.get_width()/2., y_pos, f'{h:+.1f}', ha='center', color=text_color, fontweight='bold', fontsize=9)

    ax2.axhline(0, color='#94a3b8', linestyle='-', alpha=0.5)
    open_fx_count = len(forex_df[forex_df['exit_reason'] == 'OPEN'])
    ax2.text(0.04, 0.85, f'Forex Open on MT5: {open_fx_count} trades\nAll with safe SL buffers (14-25 pips)',
             transform=ax2.transAxes, color='#a7f3d0', fontsize=10, fontweight='bold',
             bbox=dict(boxstyle='round,pad=0.4', facecolor='#064e3b', edgecolor=accent_green, alpha=0.85))
    ax2.set_title(f'2. Forex Net Pips by Currency Pair ({len(forex_df)} Total)', fontsize=12, fontweight='bold', pad=10)
    ax2.set_xlabel('Currency Pair', fontsize=10)
    ax2.set_ylabel('Net Pips', fontsize=10)

    # ==================== 3. STOCK: Cumulative % Return Trajectory ====================
    ax3 = axes[1, 0]
    stk_closed = stock_df[stock_df['return_pct'].notna()].sort_values('id').copy()
    if len(stk_closed) > 0:
        stk_closed['cum_return'] = stk_closed['return_pct'].astype(float).cumsum()
        x_stk = range(1, len(stk_closed) + 1)
        ax3.plot(x_stk, stk_closed['cum_return'], marker='s', linewidth=2.5, color=accent_purple, label='Stock Cumulative % Return')

        stk_wins = stk_closed[stk_closed['is_win'] == 1]
        stk_losses = stk_closed[stk_closed['is_win'] == 0]

        ax3.scatter([stk_closed.index.get_loc(i) + 1 for i in stk_wins.index], stk_wins['cum_return'], color=accent_green, s=120, zorder=5, label='Stock Win (TP)')
        ax3.scatter([stk_closed.index.get_loc(i) + 1 for i in stk_losses.index], stk_losses['cum_return'], color=accent_red, s=80, zorder=5, label='Stock Loss (SL)')

        stk_wr = (len(stk_wins) / len(stk_closed)) * 100 if len(stk_closed) > 0 else 0
        tot_ret = stk_closed['cum_return'].iloc[-1]
        ax3.text(0.04, 0.75, f'Stock Closed: {len(stk_closed)} | Win Rate: {stk_wr:.1f}%\nTotal Return: {tot_ret:+.2f}%', 
                 transform=ax3.transAxes, color=text_color, fontsize=10, fontweight='bold',
                 bbox=dict(boxstyle='round,pad=0.5', facecolor='#0f172a', edgecolor=accent_purple, alpha=0.9))

    ax3.axhline(0, color='#94a3b8', linestyle=':', alpha=0.7)
    ax3.set_title('3. US Stock Swing: Cumulative % Return Trajectory', fontsize=12, fontweight='bold', pad=10)
    ax3.set_xlabel('Closed Trade Order (#)', fontsize=10)
    ax3.set_ylabel('Cumulative Return (%)', fontsize=10)
    ax3.legend(loc='lower left', facecolor='#1e293b', edgecolor=grid_color, labelcolor=text_color)

    # ==================== 4. STOCK: Return % by Ticker ====================
    ax4 = axes[1, 1]
    if len(stock_df) > 0:
        stk_bars_data = stock_df.copy()
        ticker_labels = list(stk_bars_data['symbol'])
        returns = [float(r) if pd.notna(r) else 0.0 for r in stk_bars_data['return_pct']]
        colors4 = [accent_green if r > 0 else (accent_red if r < 0 else accent_gold) for r in returns]
        
        bars4 = ax4.bar(ticker_labels, returns, color=colors4, width=0.5, edgecolor='#0f172a')
        for bar in bars4:
            h = bar.get_height()
            y_pos = h + 1 if h >= 0 else h - 2.5
            ax4.text(bar.get_x() + bar.get_width()/2., y_pos, f'{h:+.1f}%', ha='center', color=text_color, fontweight='bold', fontsize=9)

        open_stk_count = len(stock_df[stock_df['exit_reason'] == 'OPEN'])
        ax4.text(0.04, 0.85, f'Stock Open Positions: {open_stk_count} (NVDA, NFLX)\nSwing Strategy with Trailing Stops',
                 transform=ax4.transAxes, color='#e0e7ff', fontsize=10, fontweight='bold',
                 bbox=dict(boxstyle='round,pad=0.4', facecolor='#312e81', edgecolor=accent_purple, alpha=0.85))

    ax4.axhline(0, color='#94a3b8', linestyle='-', alpha=0.5)
    ax4.set_title(f'4. US Stock Outcomes by Ticker ({len(stock_df)} Total)', fontsize=12, fontweight='bold', pad=10)
    ax4.set_xlabel('Stock Ticker', fontsize=10)
    ax4.set_ylabel('Return (%)', fontsize=10)

    # Overall Super Title
    plt.suptitle(f'AI Multi-Asset Trading System: Separated Performance Analytics (Forex: {len(forex_df)} | Stock: {len(stock_df)})', 
                 fontsize=15, fontweight='bold', color=text_color, y=0.98)
    plt.tight_layout(rect=[0, 0.03, 1, 0.95])

    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    art_path = os.path.join(ARTIFACT_DIR, 'model_trade_results_analysis.png')
    pub_path = os.path.join(PUBLIC_DIR, 'model_trade_results_analysis.png')

    plt.savefig(art_path, dpi=200, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.savefig(pub_path, dpi=200, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"✅ Successfully created separated dual-market plot at {art_path}")
    return True

if __name__ == '__main__':
    generate_separated_results_plots()
