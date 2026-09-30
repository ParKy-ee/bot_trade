# Forex M5 label policy (FIRST_TOUCH_V2)

Each sample uses the close of a completed M5 candle as its bid reference. The
next five consecutive M5 candles are inspected in time order. Hypothetical BUY
and SELL orders use TP = 1.5 ATR and SL = 1.0 ATR, with a fixed estimated spread
of 0.00015 for non-JPY pairs and 0.02 for JPY pairs. BUY enters at ask and exits
at bid; SELL enters at bid and exits at ask. This is an OHLC estimate, not a tick
execution replay.

| BUY outcome | SELL outcome | market_state | target_buy | target_sell |
| --- | --- | --- | ---: | ---: |
| TP first | Other | BUY | 1 | 0 |
| Other | TP first | SELL | 0 | 1 |
| No TP first | No TP first | NO_TRADE | 0 | 0 |
| Ambiguous same-candle TP/SL, both TP, or missing candle | Any | AVOID | 0 | 0 |

The two training scripts exclude AVOID and accept only observations labeled
`FIRST_TOUCH_V2`. The historical CSV stays unchanged; its labels are calculated
in memory. The `--relabel-v1` option recalculates legacy observations from their
stored bars; any legacy rows left unconverted are excluded from training.
Closed trades are excluded from paired BUY/SELL training because the untraded
side has no observed outcome.

The confusion matrix compares predicted actions against these realized states.
For the existing dual-model architecture, each side also has its own binary
confusion matrix. Accuracy alone does not describe trading quality; inspect
side-specific precision, signal coverage, and net performance after costs.
