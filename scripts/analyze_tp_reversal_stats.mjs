import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();
  console.log('================================================================================');
  console.log('🔍 EMPIRICAL DATASET ANALYSIS: NEAR-TP REVERSAL TO SL / LOSS');
  console.log('================================================================================\n');

  // Check total closed trades with valid entry, exit, tp, sl
  const [totalClosed] = await pool.query(`
    SELECT 
      market_type,
      CASE 
        WHEN decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE') THEN 'LIVE'
        ELSE 'SHADOW'
      END as run_mode,
      COUNT(*) as total_trades,
      SUM(profit_loss > 0) as win_count,
      SUM(profit_loss <= 0) as loss_count,
      SUM(exit_reason = 'CLOSED_SL') as sl_count
    FROM trade_results
    WHERE exit_price IS NOT NULL 
      AND entry_price IS NOT NULL 
      AND tp_price IS NOT NULL
      AND exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
    GROUP BY market_type, run_mode
    ORDER BY market_type, run_mode
  `);

  console.log('📊 1. ภาพรวมออเดอร์ปิดทั้งหมดในฐานข้อมูลที่มี TP/SL ชัดเจน:');
  console.table(totalClosed);

  // Now let's calculate the intra-trade MFE (Maximum Favorable Excursion)
  // Join each trade with market_bars during its active life [entry_time, exit_time]
  const [mfeRows] = await pool.query(`
    SELECT 
      t.id,
      t.symbol,
      t.market_type,
      CASE 
        WHEN t.decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE') THEN 'LIVE'
        ELSE 'SHADOW'
      END as run_mode,
      t.action,
      t.entry_price,
      t.tp_price,
      t.sl_price,
      t.exit_price,
      t.exit_reason,
      t.profit_loss,
      t.pips as final_pips,
      t.hold_duration_minutes,
      t.entry_time,
      t.exit_time,
      CASE 
        WHEN t.action = 'BUY' THEN MAX(b.high)
        ELSE MIN(b.low)
      END as peak_price,
      COUNT(b.time) as bar_count
    FROM trade_results t
    JOIN market_bars b 
      ON t.symbol = b.symbol 
      AND b.time >= t.entry_time 
      AND b.time <= t.exit_time
    WHERE t.exit_price IS NOT NULL 
      AND t.entry_price > 0 
      AND t.tp_price > 0
      AND t.exit_reason NOT IN ('OPEN', 'CLOSED_EXPIRED', 'CLOSED_HISTORICAL')
    GROUP BY t.id
    HAVING bar_count >= 1
  `);

  console.log(`\n📥 สกัดออเดอร์ที่มีข้อมูลแท่งเทียน M5 ระหว่างถือครองสมบูรณ์: ${mfeRows.length.toLocaleString()} ออเดอร์`);

  if (mfeRows.length === 0) {
    console.log('⚠️ ไม่พบข้อมูลแท่งเทียนที่ตรงกับช่วงเวลาเทรด');
    process.exit(0);
  }

  // Analyze each trade
  let totalAnalyzed = 0;
  let totalWins = 0;
  let totalLosses = 0;

  // Breakdown metrics
  const statsByMode = {};

  mfeRows.forEach(r => {
    const isJpy = r.symbol.includes('JPY');
    const isGold = r.market_type === 'gold' || r.symbol.includes('XAU') || r.symbol === 'GOLD';
    const isCrypto = r.market_type === 'crypto' || r.symbol.includes('BTC') || r.symbol.includes('ETH') || r.symbol.includes('SOL');
    const pipMult = isJpy ? 100 : (isGold ? 10 : (isCrypto ? 1 : 10000));

    const entry = Number(r.entry_price);
    const tp = Number(r.tp_price);
    const sl = Number(r.sl_price);
    const peak = Number(r.peak_price);
    const pnl = Number(r.profit_loss || 0);
    const finalPips = Number(r.final_pips || 0);

    const isBuy = r.action === 'BUY';
    const plannedTpDist = isBuy ? (tp - entry) : (entry - tp);
    const plannedSlDist = isBuy ? (entry - sl) : (sl - entry);

    if (plannedTpDist <= 0) return; // invalid TP

    const peakProfitDist = isBuy ? (peak - entry) : (entry - peak);
    const peakProfitPips = peakProfitDist * pipMult;
    const pctToTp = (peakProfitDist / plannedTpDist) * 100;

    const key = `${r.market_type}_${r.run_mode}`;
    if (!statsByMode[key]) {
      statsByMode[key] = {
        market: r.market_type,
        mode: r.run_mode,
        total: 0,
        wins: 0,
        losses: 0,
        sl_closes: 0,
        // Losses that had floating profit
        loss_with_any_profit: 0,      // peakProfitPips > 1.5
        loss_reached_50pct_tp: 0,     // reached >= 50% TP then lost
        loss_reached_60pct_tp: 0,     // reached >= 60% TP then lost
        loss_reached_70pct_tp: 0,     // reached >= 70% TP then lost
        loss_reached_80pct_tp: 0,     // reached >= 80% TP then lost
        loss_reached_90pct_tp: 0,     // reached >= 90% TP then lost
        // P/L lost from reversals
        total_pnl_lost_after_50pct: 0,
        max_pnl_missed_after_50pct: 0
      };
    }

    const s = statsByMode[key];
    s.total++;
    totalAnalyzed++;

    const isLoss = pnl <= 0;
    if (!isLoss) {
      s.wins++;
      totalWins++;
    } else {
      s.losses++;
      totalLosses++;
      if (r.exit_reason === 'CLOSED_SL') s.sl_closes++;

      const minProfitPipsThreshold = isGold ? 15 : (isCrypto ? 5 : 2.0);
      if (peakProfitPips >= minProfitPipsThreshold) {
        s.loss_with_any_profit++;
      }
      if (pctToTp >= 50) {
        s.loss_reached_50pct_tp++;
        s.total_pnl_lost_after_50pct += Math.abs(pnl);
      }
      if (pctToTp >= 60) s.loss_reached_60pct_tp++;
      if (pctToTp >= 70) s.loss_reached_70pct_tp++;
      if (pctToTp >= 80) s.loss_reached_80pct_tp++;
      if (pctToTp >= 90) s.loss_reached_90pct_tp++;
    }
  });

  console.log('\n================================================================================');
  console.log('🎯 2. สรุปผลการวิเคราะห์เจาะลึก: ออเดอร์ที่ "เกือบถึง TP แต่กลับตัวมาชน SL / ขาดทุน"');
  console.log('================================================================================');

  const summaryTable = Object.values(statsByMode).map(s => {
    const pctOfLossesReached50 = s.losses > 0 ? ((s.loss_reached_50pct_tp / s.losses) * 100).toFixed(1) + '%' : '0%';
    const pctOfLossesReached70 = s.losses > 0 ? ((s.loss_reached_70pct_tp / s.losses) * 100).toFixed(1) + '%' : '0%';
    const pctOfTotalReached50 = s.total > 0 ? ((s.loss_reached_50pct_tp / s.total) * 100).toFixed(1) + '%' : '0%';
    const pctOfLossesHadProfit = s.losses > 0 ? ((s.loss_with_any_profit / s.losses) * 100).toFixed(1) + '%' : '0%';

    return {
      Market: s.market,
      Mode: s.mode,
      'Total Closed': s.total,
      Wins: s.wins,
      Losses: s.losses,
      'SL Exits': s.sl_closes,
      'Loss เคยบวกสวย': `${s.loss_with_any_profit} (${pctOfLossesHadProfit})`,
      'Loss ไปถึง >=50% TP': `${s.loss_reached_50pct_tp} (${pctOfLossesReached50})`,
      'Loss ไปถึง >=70% TP': `${s.loss_reached_70pct_tp} (${pctOfLossesReached70})`,
      'Loss ไปถึง >=80% TP': s.loss_reached_80pct_tp,
      '% ของทุกออเดอร์ที่โดน Reversal': pctOfTotalReached50,
      'เงินที่เสียไปฟรี ($)': `$${s.total_pnl_lost_after_50pct.toFixed(2)}`
    };
  });

  console.table(summaryTable);

  // Overall totals across entire dataset
  const totalL = Object.values(statsByMode).reduce((acc, x) => acc + x.losses, 0);
  const totalR50 = Object.values(statsByMode).reduce((acc, x) => acc + x.loss_reached_50pct_tp, 0);
  const totalR70 = Object.values(statsByMode).reduce((acc, x) => acc + x.loss_reached_70pct_tp, 0);
  const totalR80 = Object.values(statsByMode).reduce((acc, x) => acc + x.loss_reached_80pct_tp, 0);
  const totalAnyProf = Object.values(statsByMode).reduce((acc, x) => acc + x.loss_with_any_profit, 0);
  const totalUsdLost = Object.values(statsByMode).reduce((acc, x) => acc + x.total_pnl_lost_after_50pct, 0);

  console.log('\n📌 สรุปภาพรวมทุกตลาด (Overall Totals):');
  console.log(`   • ออเดอร์ปิดที่ถูกนำมาวิเคราะห์ MFE: ${totalAnalyzed.toLocaleString()} ออเดอร์ (ชนะ: ${totalWins.toLocaleString()} | ขาดทุน: ${totalL.toLocaleString()})`);
  console.log(`   • ออเดอร์ที่ขาดทุน แต่ระหว่างทาง "เคยบวกสวย": ${totalAnyProf.toLocaleString()} ออเดอร์ (${((totalAnyProf / totalL) * 100).toFixed(1)}% ของไม้ขาดทุนทั้งหมด!)`);
  console.log(`   • ออเดอร์ที่วิ่งไปถึง >= 50% ของ TP แต่กลับตัวมาชน SL: ${totalR50.toLocaleString()} ออเดอร์ (${((totalR50 / totalL) * 100).toFixed(1)}% ของไม้ขาดทุนทั้งหมด | ${((totalR50 / totalAnalyzed) * 100).toFixed(1)}% ของออเดอร์ทั้งหมด)`);
  console.log(`   • ออเดอร์ที่วิ่งไปถึง >= 70% ของ TP แต่กลับตัวมาชน SL: ${totalR70.toLocaleString()} ออเดอร์ (${((totalR70 / totalL) * 100).toFixed(1)}% ของไม้ขาดทุนทั้งหมด)`);
  console.log(`   • ออเดอร์ที่วิ่งไปถึง >= 80% ของ TP (เกือบชนเป้าอยู่แล้วแต่ย้อน): ${totalR80.toLocaleString()} ออเดอร์ (${((totalR80 / totalL) * 100).toFixed(1)}% ของไม้ขาดทุนทั้งหมด)`);
  console.log(`   • มูลค่าเงินที่ขาดทุนไปฟรีๆ จากไม้ที่เคยบวกเกิน 50% TP: -$${totalUsdLost.toFixed(2)} USD`);

  // Sample actual trade cases from LIVE
  const [sampleCases] = await pool.query(`
    SELECT 
      t.id, t.symbol, t.market_type, t.decision_mode, t.action, 
      t.entry_price, t.tp_price, t.sl_price, t.exit_price, t.exit_reason, 
      t.profit_loss, t.pips, t.entry_time, t.exit_time,
      CASE WHEN t.action = 'BUY' THEN MAX(b.high) ELSE MIN(b.low) END as peak_price
    FROM trade_results t
    JOIN market_bars b 
      ON t.symbol = b.symbol AND b.time >= t.entry_time AND b.time <= t.exit_time
    WHERE t.decision_mode IN ('LIVE', 'FOREX_SIGNAL_REENTRY', 'FOREX_SCALE_IN', 'FREQTRADE_MT5_LIVE', 'TEST_LIVE')
      AND t.exit_reason = 'CLOSED_SL'
      AND t.entry_price > 0 AND t.tp_price > 0
    GROUP BY t.id
    ORDER BY t.id DESC
    LIMIT 25
  `);

  const sampleList = [];
  sampleCases.forEach(r => {
    const isJpy = r.symbol.includes('JPY');
    const isGold = r.market_type === 'gold' || r.symbol.includes('XAU') || r.symbol === 'GOLD';
    const isCrypto = r.market_type === 'crypto' || r.symbol.includes('BTC') || r.symbol.includes('ETH') || r.symbol.includes('SOL');
    const pipMult = isJpy ? 100 : (isGold ? 10 : (isCrypto ? 1 : 10000));

    const entry = Number(r.entry_price);
    const tp = Number(r.tp_price);
    const peak = Number(r.peak_price);
    const isBuy = r.action === 'BUY';
    const plannedTpDist = isBuy ? (tp - entry) : (entry - tp);
    if (plannedTpDist <= 0) return;

    const peakProfitDist = isBuy ? (peak - entry) : (entry - peak);
    const peakProfitPips = peakProfitDist * pipMult;
    const pctToTp = (peakProfitDist / plannedTpDist) * 100;

    if (pctToTp >= 40) {
      sampleList.push({
        Ticket: r.id,
        Symbol: r.symbol,
        Mode: r.decision_mode,
        Action: r.action,
        Entry: entry,
        Peak: peak,
        TP: tp,
        'Peak Profit': `${peakProfitPips.toFixed(1)}p`,
        '% to TP Reached': `${pctToTp.toFixed(1)}%`,
        'Final PnL': `$${Number(r.profit_loss).toFixed(2)}`,
        'Exit Reason': r.exit_reason
      });
    }
  });

  console.log('\n🔥 ตัวอย่างเคสจริงจาก LIVE ที่วิ่งไปเกือบถึง TP แล้วย้อนกลับมาโดน SL:');
  console.table(sampleList.slice(0, 10));

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
