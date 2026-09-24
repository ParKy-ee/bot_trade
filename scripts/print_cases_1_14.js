import fs from 'fs';

const cases = JSON.parse(fs.readFileSync('./scripts/detailed_trade_cases.json', 'utf-8'));

cases.slice(0, 14).forEach((c, idx) => {
  console.log(`================================================================================`);
  console.log(`CASE #${idx + 1} | [Trade ID: ${c.trade_id}] | Bot: ${c.bot} (${c.version}) [${c.market}]`);
  console.log(`Symbol: ${c.symbol} | Action: ${c.action} | Entry: ${c.entry_time} @ ${c.entry_price} (SL: ${c.sl_price}, TP: ${c.tp_price})`);
  console.log(`Exit:   ${c.exit_time} @ ${c.exit_price} [${c.exit_reason}] | Result: ${c.is_win ? '🟢 WIN' : '🔴 LOSS'} | PnL: $${c.profit_loss} (${c.pips} pips) | Hold: ${c.duration_min} min`);
  console.log(`Conf: ${c.confidence ? (c.confidence * 100).toFixed(1) + '%' : 'N/A'} | RSI: ${c.rsi} | ADX: ${c.adx} | ATR: ${c.atr}`);
  console.log(`Filter Reasons: ${JSON.stringify(c.filter_reasons)}`);
  
  if (c.candle_context && c.candle_context.length > 0) {
    const entryCandles = c.candle_context.filter(b => Math.abs(new Date(b.time) - new Date(c.entry_time)) < 20 * 60 * 1000);
    console.log(`Surrounding Candlestick Summary:`);
    entryCandles.forEach(b => {
      console.log(`  🕒 ${b.time} | O:${b.open} H:${b.high} L:${b.low} C:${b.close} | ${b.body_type} (Body:${b.body_size.toFixed(4)}, WickUp:${b.upper_wick.toFixed(4)}, WickDn:${b.lower_wick.toFixed(4)}) | RSI:${b.rsi}`);
    });
  }
});
