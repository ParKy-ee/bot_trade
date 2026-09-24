# Checkpoint Update — Bot data collection live

Date: 2026-09-14 13:30 Asia/Bangkok

## Current runtime

- Node.js service: `http://127.0.0.1:3000`
- MySQL database: `ai_trading_db` connected
- XM Global MT5 Demo: login `169315887`, server `XMGlobal-MT5 2`
- MT5 permissions: `tradeAllowed=true`, `tradeExpert=true`
- Keep the existing Node process running. Do not start a second `npm start` on port 3000 (`EADDRINUSE`).

## Active models

- Forex live execution: Champion `forex_champion / v1.3.0`
- Challenger: `challenger-v1.1.0`, shadow-only for comparison and data harvesting
- Range expert: enabled/live-enabled; no range trade in the latest snapshot
- Freqtrade-to-MT5 bridge test completed; test trade was manually closed

## Latest result snapshot

- Forex database: 215 records, 212 closed, 70 wins, 142 losses, win rate 33.02%
- Forex cumulative result: -791.64 pips / -63.43 USD
- Today: 5 Champion live records; 3 remain open and 2 are closed
- Champion closed today: NZDUSD SELL +13.1 pips, EURJPY SELL -4.1 pips
- Champion net today: +9.0 pips / +1.02 USD
- Dashboard and Freqtrade test trades today: -0.22 USD and -0.15 USD; both manually closed

## MT5 account snapshot

- Balance: 9,872.27 USD
- Equity: 9,862.15 USD
- Floating P/L: -10.12 USD
- Current Forex positions: EURUSD SELL, GBPUSD SELL, GBPJPY SELL
- MT5 also contains existing crypto/stock positions, so account floating P/L includes all instruments

## Data collection instructions

- Leave the bot running and allow M5 bar-close scans to collect realized outcomes.
- Do not retrain or promote from open/shadow rows; use only broker-confirmed closed results.
- Monitor duplicate exposure, MT5 synchronization, rejection reasons, model source/version, and Champion versus Challenger outcomes.
- Before retraining, export a new report after enough new closed samples have accumulated.
- Do not judge the Range model from the current small live sample.

## Known issue

- Node started from the assistant environment previously returned `spawn EPERM` for child Python processes, while direct Python MT5 bridge calls worked. If scans show no market data, stop the existing Node process and run `npm start` from the user PowerShell session, then verify `/api/health`, `/api/mt5/account`, and one scan.
