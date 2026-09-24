// DOM Elements
const tabStocks = document.getElementById('tab-stocks');
const tabForex = document.getElementById('tab-forex');

const dbBadge = document.getElementById('db-badge');
const botBadge = document.getElementById('bot-badge');
const marketBadge = document.getElementById('market-badge');
const mt5Badge = document.getElementById('mt5-badge');
const mt5Banner = document.getElementById('mt5-info-banner');
const mt5AccName = document.getElementById('mt5-acc-name');
const mt5AccDetails = document.getElementById('mt5-acc-details');
const mt5Balance = document.getElementById('mt5-balance');
const mt5Equity = document.getElementById('mt5-equity');
const mt5Margin = document.getElementById('mt5-margin');

const btnScan = document.getElementById('btn-scan');
const btnToggle = document.getElementById('btn-toggle');
const btnSeed = document.getElementById('btn-seed');

const valPositions = document.getElementById('val-positions');
const valSignals = document.getElementById('val-signals');
const valLastScan = document.getElementById('val-last-scan');
const valNextScan = document.getElementById('val-next-scan');
const valThreshold = document.getElementById('val-threshold');

const tbodyPositions = document.getElementById('tbody-positions');
const tbodySignals = document.getElementById('tbody-signals');
const badgePositionsCount = document.getElementById('badge-positions-count');
const badgeSignalsCount = document.getElementById('badge-signals-count');

const selectSymbol = document.getElementById('select-symbol');
const canvasChart = document.getElementById('canvas-chart');
const selectTable = document.getElementById('select-table');
const theadRaw = document.getElementById('thead-raw');
const tbodyRaw = document.getElementById('tbody-raw');

let currentMarket = localStorage.getItem('active_market') || 'forex'; // default 'forex' or 'stock'
let currentStatus = null;
let chartBars = [];

const STOCK_SYMBOLS = [
  { value: 'SPY', label: 'SPY (S&P 500 ETF)' },
  { value: 'NVDA', label: 'NVDA (NVIDIA)' },
  { value: 'AMD', label: 'AMD (Advanced Micro Devices)' },
  { value: 'TSLA', label: 'TSLA (Tesla)' },
  { value: 'MSFT', label: 'MSFT (Microsoft)' },
  { value: 'AVGO', label: 'AVGO (Broadcom)' },
  { value: 'NFLX', label: 'NFLX (Netflix)' },
  { value: 'AMZN', label: 'AMZN (Amazon)' },
  { value: 'META', label: 'META (Meta)' },
  { value: 'GOOGL', label: 'GOOGL (Alphabet)' }
];

const FOREX_SYMBOLS = [
  { value: 'EURUSD=X', label: 'EUR/USD (Euro / US Dollar)' },
  { value: 'GBPUSD=X', label: 'GBP/USD (British Pound / USD)' },
  { value: 'USDJPY=X', label: 'USD/JPY (US Dollar / Japanese Yen)' },
  { value: 'USDCHF=X', label: 'USD/CHF (US Dollar / Swiss Franc)' },
  { value: 'AUDUSD=X', label: 'AUD/USD (Australian Dollar / USD)' },
  { value: 'USDCAD=X', label: 'USD/CAD (US Dollar / Canadian Dollar)' },
  { value: 'NZDUSD=X', label: 'NZD/USD (New Zealand Dollar / USD)' },
  { value: 'EURJPY=X', label: 'EUR/JPY (Euro / Japanese Yen)' },
  { value: 'GBPJPY=X', label: 'GBP/JPY (British Pound / Yen)' },
  { value: 'DX-Y.NYB', label: 'DXY (US Dollar Index Benchmark)' }
];

function updateSymbolOptions() {
  const symbols = currentMarket === 'forex' ? FOREX_SYMBOLS : STOCK_SYMBOLS;
  selectSymbol.innerHTML = symbols.map(s => `<option value="${s.value}">${s.label}</option>`).join('');
  loadChartData();
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  const color = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6';
  toast.style.borderLeft = `4px solid ${color}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.4s';
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// Format price by market and symbol
function fmtPrice(val, symbol = '') {
  const num = Number(val);
  if (!Number.isFinite(num)) return '-';
  if (currentMarket === 'forex' || symbol.includes('=X')) {
    if (symbol.includes('JPY')) return num.toFixed(3);
    return num.toFixed(5);
  }
  return '$' + num.toFixed(2);
}

// Fetch all dashboard data
async function loadDashboard() {
  try {
    const statusUrl = currentMarket === 'forex' ? '/api/forex/status' : '/api/status';
    const [healthRes, statusRes] = await Promise.all([
      fetch('/api/health').then(r => r.json()),
      fetch(statusUrl).then(r => r.json())
    ]);

    currentStatus = statusRes;

    if (healthRes.status === 'online') {
      dbBadge.textContent = `● MySQL: ${healthRes.database} (Online)`;
      dbBadge.className = 'badge badge-ok';
    } else {
      dbBadge.textContent = `● MySQL: Offline`;
      dbBadge.className = 'badge badge-bad';
    }

    const isScanning = currentMarket === 'forex' ? statusRes.isForexScanning : statusRes.isScanning;
    if (statusRes.botRunning) {
      botBadge.textContent = isScanning ? '● บอท: กำลังสแกน...' : '● บอท: รันคู่ขนาน (Stock & Forex Dual Active)';
      botBadge.className = 'badge badge-ok';
      btnToggle.innerHTML = '<span class="btn-icon">⏸️</span> หยุดบอทชั่วคราว';
    } else {
      botBadge.textContent = '● บอท: หยุดชั่วคราว (Paused)';
      botBadge.className = 'badge badge-neutral';
      btnToggle.innerHTML = '<span class="btn-icon">▶️</span> เริ่มการทำงานบอท';
    }

    if (statusRes.isWeekend) {
      marketBadge.textContent = '● ตลาด: ปิดสุดสัปดาห์';
      marketBadge.className = 'badge badge-neutral';
    } else {
      marketBadge.textContent = currentMarket === 'forex' ? '● ตลาด: Forex เปิด 24/5' : '● ตลาด: หุ้นสหรัฐวันทำการ';
      marketBadge.className = 'badge badge-ok';
    }

    valThreshold.textContent = `${(statusRes.confidenceThreshold * 100).toFixed(1)}%`;
    const lastTime = currentMarket === 'forex' ? statusRes.lastForexScanTime : statusRes.lastScanTime;
    if (lastTime) {
      valLastScan.textContent = new Date(lastTime).toLocaleTimeString('th-TH');
      valNextScan.textContent = `ความถี่: ทุก ${statusRes.scanIntervalMinutes} นาที`;
    }

    // MT5 Demo Account status
    try {
      const accRes = await fetch('/api/mt5/account').then(r => r.json());
      if (accRes && accRes.connected) {
        if (mt5Badge) {
          mt5Badge.textContent = `● MT5 Demo: ${accRes.login} (${accRes.server})`;
          mt5Badge.className = 'badge badge-ok';
        }
        if (currentMarket === 'forex' && mt5Banner) {
          mt5Banner.style.display = 'flex';
          if (mt5AccName) mt5AccName.textContent = `${accRes.name || 'Demo Trader'} (${accRes.login})`;
          if (mt5AccDetails) mt5AccDetails.textContent = `${accRes.server} | Leverage 1:${accRes.leverage} | ${accRes.currency}`;
          if (mt5Balance) mt5Balance.textContent = `$${Number(accRes.balance).toFixed(2)}`;
          if (mt5Equity) mt5Equity.textContent = `$${Number(accRes.equity).toFixed(2)}`;
          if (mt5Margin) mt5Margin.textContent = `$${Number(accRes.freeMargin).toFixed(2)}`;
        } else if (mt5Banner) {
          mt5Banner.style.display = 'none';
        }
      } else {
        if (mt5Badge) {
          mt5Badge.textContent = '● MT5: ยังไม่ได้เชื่อมต่อ';
          mt5Badge.className = 'badge badge-neutral';
        }
        if (mt5Banner) mt5Banner.style.display = 'none';
      }
    } catch (e) {
      if (mt5Badge) {
        mt5Badge.textContent = '● MT5: ออฟไลน์';
        mt5Badge.className = 'badge badge-neutral';
      }
      if (mt5Banner) mt5Banner.style.display = 'none';
    }

    loadPositions();
    loadSignals();
    loadRawTable();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

async function loadPositions() {
  try {
    const res = await fetch(`/api/positions?market=${currentMarket}`);
    const positions = await res.json();
    badgePositionsCount.textContent = `${positions.length} ตำแหน่ง`;
    valPositions.textContent = positions.length;

    if (positions.length === 0) {
      tbodyPositions.innerHTML = `<tr><td colspan="8" class="text-center muted">ไม่มีตำแหน่งที่กำลังถือในตลาด ${currentMarket === 'forex' ? 'Forex' : 'หุ้นสหรัฐ'}</td></tr>`;
      return;
    }

    tbodyPositions.innerHTML = positions.map(p => {
      const entryPrice = Number(p.entry_price);
      const highestPrice = Number(p.highest_price);
      const slPrice = Number(p.sl_price);
      const tpPrice = Number(p.tp_price);
      const isShort = p.status_note?.includes('SELL') || tpPrice < entryPrice;
      const gainToTp = isShort
        ? (((entryPrice - tpPrice) / entryPrice) * 100).toFixed(1)
        : (((tpPrice - entryPrice) / entryPrice) * 100).toFixed(1);
      const ticketBadge = p.mt5_ticket ? `<span class="badge" style="background:#0f172a; color:#38bdf8; font-size:10px; margin-left:6px; border:1px solid #334155;">#${p.mt5_ticket}</span>` : '';

      return `
        <tr>
          <td><strong>${p.symbol.replace('=X', '')}</strong>${ticketBadge}</td>
          <td>${p.entry_date ? new Date(p.entry_date).toLocaleDateString() : '-'}</td>
          <td>${fmtPrice(entryPrice, p.symbol)}</td>
          <td>${fmtPrice(highestPrice, p.symbol)}</td>
          <td class="text-danger">${fmtPrice(slPrice, p.symbol)}</td>
          <td class="text-success">${fmtPrice(tpPrice, p.symbol)}</td>
          <td class="text-success">+${gainToTp}%</td>
          <td><span class="${isShort ? 'tag-sell' : 'tag-buy'}">${p.status_note}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Load positions error:', err);
  }
}

async function loadSignals() {
  try {
    const res = await fetch(`/api/signals?market=${currentMarket}&limit=25`);
    const signals = await res.json();
    badgeSignalsCount.textContent = `${signals.length} รายการ`;
    valSignals.textContent = signals.length;

    if (signals.length === 0) {
      tbodySignals.innerHTML = `<tr><td colspan="8" class="text-center muted">ยังไม่มีสัญญาณเทรดในตลาด ${currentMarket === 'forex' ? 'Forex' : 'หุ้นสหรัฐ'}</td></tr>`;
      return;
    }

    tbodySignals.innerHTML = signals.map(s => {
      const price = Number(s.price);
      const sl = Number(s.sl_price);
      const tp = Number(s.tp_price);
      const risk = Math.abs(price - sl) || 0.0001;
      const reward = Math.abs(tp - price) || 0.0001;
      const rrRatio = (reward / risk).toFixed(2);
      const confPct = (Number(s.ai_confidence) * 100).toFixed(1);
      const isSell = s.action === 'SELL';

      return `
        <tr>
          <td>${new Date(s.time).toLocaleString('th-TH')}</td>
          <td><strong>${s.symbol.replace('=X', '')}</strong></td>
          <td><span class="${isSell ? 'tag-sell' : 'tag-buy'}">${s.action}</span></td>
          <td>${fmtPrice(price, s.symbol)}</td>
          <td><strong class="text-accent">${confPct}%</strong></td>
          <td class="text-danger">${fmtPrice(sl, s.symbol)}</td>
          <td class="text-success">${fmtPrice(tp, s.symbol)}</td>
          <td>1 : ${rrRatio}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Load signals error:', err);
  }
}

async function loadChartData() {
  const symbol = selectSymbol.value;
  if (!symbol) return;
  try {
    const res = await fetch(`/api/bars?symbol=${symbol}&limit=90`);
    chartBars = await res.json();
    drawChart(chartBars, symbol);
  } catch (err) {
    console.error('Load chart error:', err);
  }
}

function drawChart(bars, symbol) {
  const ctx = canvasChart.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasChart.getBoundingClientRect();
  canvasChart.width = rect.width * dpr;
  canvasChart.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, rect.width, rect.height);

  if (!bars || bars.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`ไม่มีข้อมูลแท่งราคาสำหรับ ${symbol} (กรุณากด Scan ตลาด)`, rect.width / 2, rect.height / 2);
    return;
  }

  const padding = { left: 80, right: 30, top: 30, bottom: 40 };
  const w = rect.width - padding.left - padding.right;
  const h = rect.height - padding.top - padding.bottom;

  const closes = bars.map(b => Number(b.close));
  const minVal = Math.min(...closes) * 0.995;
  const maxVal = Math.max(...closes) * 1.005;
  const range = (maxVal - minVal) || 0.0001;

  const getX = i => padding.left + (i * w / (bars.length - 1 || 1));
  const getY = val => padding.top + (maxVal - val) * h / range;

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const yVal = minVal + (i * range / 4);
    const yPx = getY(yVal);
    ctx.beginPath();
    ctx.moveTo(padding.left, yPx);
    ctx.lineTo(rect.width - padding.right, yPx);
    ctx.stroke();
    ctx.fillText(fmtPrice(yVal, symbol), padding.left - 8, yPx + 4);
  }

  const gradient = ctx.createLinearGradient(0, padding.top, 0, rect.height - padding.bottom);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.35)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

  ctx.beginPath();
  closes.forEach((val, i) => {
    const x = getX(i);
    const y = getY(val);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  ctx.lineTo(getX(closes.length - 1), rect.height - padding.bottom);
  ctx.lineTo(getX(0), rect.height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  const lastBar = bars[bars.length - 1];
  ctx.fillStyle = '#f3f4f6';
  ctx.font = '600 13px Inter, sans-serif';
  ctx.textAlign = 'left';
  const cleanName = symbol.replace('=X', '');
  ctx.fillText(`${cleanName} · ปิดล่าสุด: ${fmtPrice(lastBar.close, symbol)} (${lastBar.time.split('T')[0]})`, padding.left, 20);
}

async function loadRawTable() {
  const table = selectTable.value;
  try {
    const res = await fetch(`/api/data?table=${table}`);
    const data = await res.json();
    if (!data.columns) return;

    theadRaw.innerHTML = `<tr>${data.columns.map(c => `<th>${c}</th>`).join('')}</tr>`;
    if (data.rows.length === 0) {
      tbodyRaw.innerHTML = `<tr><td colspan="${data.columns.length}" class="text-center muted">ไม่มีข้อมูลในตาราง ${table}</td></tr>`;
      return;
    }
    tbodyRaw.innerHTML = data.rows.map(row => `
      <tr>
        ${data.columns.map(c => `<td title="${row[c] ?? ''}">${row[c] ?? ''}</td>`).join('')}
      </tr>
    `).join('');
  } catch (err) {
    console.error('Load raw table error:', err);
  }
}

// Tab Switching
function applyTabState() {
  if (currentMarket === 'forex') {
    tabForex.classList.add('active');
    tabStocks.classList.remove('active');
    btnSeed.style.display = 'none';
    btnScan.innerHTML = '<span class="btn-icon">⚡</span> สแกน Forex ทันที (3-Pillar Filter)';
  } else {
    tabStocks.classList.add('active');
    tabForex.classList.remove('active');
    btnSeed.style.display = 'inline-flex';
    btnScan.innerHTML = '<span class="btn-icon">⚡</span> สแกนหุ้นสหรัฐทันที';
  }
}
applyTabState();

tabStocks.addEventListener('click', () => {
  currentMarket = 'stock';
  localStorage.setItem('active_market', 'stock');
  applyTabState();
  updateSymbolOptions();
  loadDashboard();
});

tabForex.addEventListener('click', () => {
  currentMarket = 'forex';
  localStorage.setItem('active_market', 'forex');
  applyTabState();
  updateSymbolOptions();
  loadDashboard();
});

// Button Actions
btnScan.addEventListener('click', async () => {
  btnScan.disabled = true;
  btnScan.innerHTML = '<span class="btn-icon">⏳</span> กำลังสแกน...';
  const marketName = currentMarket === 'forex' ? 'Forex' : 'หุ้นสหรัฐ';
  showToast(`เริ่มต้นการสแกนตลาด ${marketName}...`, 'info');

  const endpoint = currentMarket === 'forex' ? '/api/forex/scan' : '/api/scan';
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'OK') {
      showToast(`การสแกนตลาด ${marketName} เสร็จสิ้นสมบูรณ์!`, 'success');
    } else {
      showToast('การสแกนล้มเหลว: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'error');
  } finally {
    btnScan.disabled = false;
    btnScan.innerHTML = `<span class="btn-icon">⚡</span> สแกน${marketName}ทันที`;
    loadDashboard();
  }
});

btnToggle.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/bot/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await res.json();
    showToast(data.botRunning ? 'เปิดการทำงานบอทเรียบร้อย' : 'หยุดบอทชั่วคราวเรียบร้อย', 'info');
    loadDashboard();
  } catch (err) {
    showToast('เกิดข้อผิดพลาดในการสลับสถานะบอท', 'error');
  }
});

btnSeed.addEventListener('click', async () => {
  btnSeed.disabled = true;
  btnSeed.innerHTML = '<span class="btn-icon">⏳</span> กำลัง Seed ข้อมูล...';
  showToast('กำลังดึงและบันทึกข้อมูลย้อนหลัง 1 ปี (อาจใช้เวลาประมาณ 10-20 วินาที)...', 'info');

  try {
    const res = await fetch('/api/seed', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'OK') {
      showToast(`Seed ข้อมูลสำเร็จ! บันทึก ${data.result.barsInserted} bars และ ${data.result.signalsCreated} signals`, 'success');
    } else {
      showToast('Seed ล้มเหลว: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'error');
  } finally {
    btnSeed.disabled = false;
    btnSeed.innerHTML = '<span class="btn-icon">📦</span> Seed ข้อมูลย้อนหลัง';
    loadDashboard();
  }
});

selectSymbol.addEventListener('change', loadChartData);
selectTable.addEventListener('change', loadRawTable);

const btnRetrainMl = document.getElementById('btn-retrain-ml');
const imgModelAnalytics = document.getElementById('img-model-analytics');
const modelInfoBadge = document.getElementById('model-info-badge');

async function loadModelInfo() {
  if (!modelInfoBadge) return;
  try {
    const res = await fetch('/api/model/info');
    const data = await res.json();
    if (data.success) {
      const aucAvg = (((data.auc_buy || 0.75) + (data.auc_sell || 0.75)) / 2 * 100).toFixed(1);
      modelInfoBadge.innerHTML = `🤖 Tri-Ensemble (AUC ${aucAvg}%) &bull; ${data.live_samples_count || 0} ไม้จริง`;
      modelInfoBadge.title = `โมเดล: ${data.architecture}\nตัวอย่างทั้งหมด: ${data.total_samples_count?.toLocaleString()}\nอัปเดตเมื่อ: ${data.trained_at || '-'}`;
    }
  } catch {}
}
loadModelInfo();

if (btnRetrainMl) {
  btnRetrainMl.addEventListener('click', async () => {
    btnRetrainMl.disabled = true;
    btnRetrainMl.innerHTML = '⏳ กำลัง Retrain โมเดล...';
    showToast('กำลังทำการ Retrain โมเดล Tri-Ensemble (LightGBM+XGBoost+CatBoost+RF)...', 'info');

    try {
      const res = await fetch('/api/model/retrain', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const aucBuyStr = data.auc_buy ? (data.auc_buy * 100).toFixed(1) + '%' : '-';
        const aucSellStr = data.auc_sell ? (data.auc_sell * 100).toFixed(1) + '%' : '-';
        const liveCount = data.live_samples || 0;
        showToast(`🎉 Retrain Tri-Ensemble สำเร็จ! (Live: ${liveCount} ไม้, AUC: BUY ${aucBuyStr} / SELL ${aucSellStr})`, 'success');
        if (imgModelAnalytics) {
          imgModelAnalytics.src = `/model_trade_results_analysis.png?t=${Date.now()}`;
        }
        loadModelInfo();
      } else {
        showToast('การ Retrain ขัดข้อง: ' + (data.error || 'Unknown'), 'error');
      }
    } catch (err) {
      showToast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'error');
    } finally {
      btnRetrainMl.disabled = false;
      btnRetrainMl.innerHTML = '🔄 Retrain ML Model ทันที';
    }
  });
}

// ================= REAL-TIME SSE & LIVE TELEMETRY =================
const sseBadge = document.getElementById('sse-badge');
const sseWinRate = document.getElementById('sse-winrate');
const sseClosedCount = document.getElementById('sse-closed-count');
const sseClosedPips = document.getElementById('sse-closed-pips');
const sseFloatingPips = document.getElementById('sse-floating-pips');
const sseFloatingPnl = document.getElementById('sse-floating-pnl');
const sseLastTick = document.getElementById('sse-last-tick');
const sseOpenCountBadge = document.getElementById('sse-open-count-badge');
const livePositionsGrid = document.getElementById('live-positions-grid');
const canvasLivePips = document.getElementById('canvas-live-pips');
const btnToggleView = document.getElementById('btn-toggle-view');
const containerLiveChart = document.getElementById('container-live-chart');
const containerStaticChart = document.getElementById('container-static-chart');

const btnChartForex = document.getElementById('btn-chart-forex');
const btnChartStock = document.getElementById('btn-chart-stock');
const chartCurveTitle = document.getElementById('chart-curve-title');

const sseLabelWinrate = document.getElementById('sse-label-winrate');
const sseLabelClosedCount = document.getElementById('sse-label-closed-count');
const sseLabelClosedPips = document.getElementById('sse-label-closed-pips');
const sseLabelFloatingPips = document.getElementById('sse-label-floating-pips');
const sseLabelFloatingPnl = document.getElementById('sse-label-floating-pnl');

let isStaticView = false;
let selectedChartMarket = currentMarket || 'forex';
let lastTelemetryData = null;

function setChartMarket(market) {
  selectedChartMarket = market;
  if (btnChartForex && btnChartStock) {
    if (market === 'forex') {
      btnChartForex.style.background = '#38bdf8';
      btnChartForex.style.color = '#0f172a';
      btnChartForex.style.fontWeight = 'bold';
      btnChartStock.style.background = 'transparent';
      btnChartStock.style.color = '#94a3b8';
      btnChartStock.style.fontWeight = '500';
      if (chartCurveTitle) chartCurveTitle.textContent = '📈 เส้นทางผลตอบแทนสะสม Forex (Live Cumulative Pips Curve)';
    } else {
      btnChartStock.style.background = '#818cf8';
      btnChartStock.style.color = '#0f172a';
      btnChartStock.style.fontWeight = 'bold';
      btnChartForex.style.background = 'transparent';
      btnChartForex.style.color = '#94a3b8';
      btnChartForex.style.fontWeight = '500';
      if (chartCurveTitle) chartCurveTitle.textContent = '📈 เส้นทางผลตอบแทนสะสม US Stock (Live Cumulative % Return Curve)';
    }
  }
  if (lastTelemetryData) {
    updateTelemetryUI(lastTelemetryData);
  }
}

if (btnChartForex) btnChartForex.addEventListener('click', () => setChartMarket('forex'));
if (btnChartStock) btnChartStock.addEventListener('click', () => setChartMarket('stock'));

if (btnToggleView) {
  btnToggleView.addEventListener('click', () => {
    isStaticView = !isStaticView;
    if (isStaticView) {
      containerLiveChart.style.display = 'none';
      containerStaticChart.style.display = 'block';
      btnToggleView.innerHTML = '📈 ดู Interactive Live Chart';
      if (imgModelAnalytics) {
        imgModelAnalytics.src = `/model_trade_results_analysis.png?t=${Date.now()}`;
      }
    } else {
      containerLiveChart.style.display = 'block';
      containerStaticChart.style.display = 'none';
      btnToggleView.innerHTML = '📊 ดูภาพรายงาน 4 มิติ';
      if (lastTelemetryData) updateTelemetryUI(lastTelemetryData);
    }
  });
}

function initSSE() {
  if (!window.EventSource) {
    if (sseBadge) sseBadge.innerHTML = '⚠️ Browser ไม่รองรับ SSE';
    return;
  }

  const evtSource = new EventSource('/api/stream');

  evtSource.onopen = () => {
    if (sseBadge) {
      sseBadge.innerHTML = '🟢 SSE: Real-Time สด (2.5s)';
      sseBadge.style.color = '#4ade80';
      sseBadge.style.background = 'rgba(34, 197, 94, 0.15)';
    }
  };

  evtSource.onerror = () => {
    if (sseBadge) {
      sseBadge.innerHTML = '🟡 SSE: กำลังเชื่อมต่อใหม่...';
      sseBadge.style.color = '#fbbf24';
      sseBadge.style.background = 'rgba(251, 191, 36, 0.15)';
    }
  };

  evtSource.addEventListener('telemetry', (e) => {
    try {
      const data = JSON.parse(e.data);
      lastTelemetryData = data;
      updateTelemetryUI(data);
    } catch (err) {
      console.warn('Error parsing SSE telemetry:', err);
    }
  });
}

function updateTelemetryUI(data) {
  const { stats, openPositions, recentTradesForex, recentTradesStock, timestamp, usMarketStatus } = data;

  const stocksTabSub = document.getElementById('stocks-tab-sub');
  if (stocksTabSub && usMarketStatus) {
    if (usMarketStatus.isOpen) {
      stocksTabSub.textContent = `● ตลาดเปิด (${usMarketStatus.timeStr})`;
      stocksTabSub.style.color = '#4ade80';
    } else {
      stocksTabSub.textContent = `● ตลาดปิด (${usMarketStatus.timeStr})`;
      stocksTabSub.style.color = '#94a3b8';
    }
  }

  if (sseLastTick) {
    const timeStr = new Date(timestamp).toLocaleTimeString('th-TH');
    sseLastTick.innerHTML = `⚡ ซิงค์สด Server: ${timeStr}`;
  }

  const isFx = selectedChartMarket === 'forex';
  const marketStats = isFx ? (stats.forex || stats) : (stats.stock || stats);

  // Update Metric Labels & Values according to selected market
  if (sseLabelWinrate) sseLabelWinrate.textContent = isFx ? 'Win Rate (Forex M5)' : 'Win Rate (US Stocks)';
  if (sseLabelClosedCount) sseLabelClosedCount.textContent = isFx ? 'ไม้ Forex ที่ปิด (W/L)' : 'หุ้นที่ปิดรอบ (W/L)';
  if (sseLabelClosedPips) sseLabelClosedPips.textContent = isFx ? 'Pips สะสม (Forex)' : 'ผลตอบแทนสะสม (% Return)';
  if (sseLabelFloatingPips) sseLabelFloatingPips.textContent = isFx ? 'Floating Pips (สด)' : 'หุ้นที่กำลังถือครอง';
  if (sseLabelFloatingPnl) sseLabelFloatingPnl.textContent = isFx ? 'Floating P&L (USD)' : 'กำไร/ขาดทุนสะสม (Pts)';

  if (marketStats) {
    if (sseWinRate) {
      sseWinRate.innerHTML = `${marketStats.winRate || 0}%`;
      sseWinRate.style.color = marketStats.winRate >= 50 ? '#4ade80' : (marketStats.winRate >= 30 ? '#38bdf8' : '#fbbf24');
    }
    if (sseClosedCount) {
      sseClosedCount.innerHTML = `${marketStats.wins || 0}W / ${marketStats.losses || 0}L (${marketStats.closedTrades || 0})`;
    }
    if (sseClosedPips) {
      if (isFx) {
        const p = marketStats.totalPips || 0;
        sseClosedPips.innerHTML = `${p >= 0 ? '+' : ''}${p.toFixed(1)} pips`;
        sseClosedPips.style.color = p >= 0 ? '#4ade80' : '#f43f5e';
      } else {
        const ret = marketStats.totalReturnPct || 0;
        sseClosedPips.innerHTML = `${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`;
        sseClosedPips.style.color = ret >= 0 ? '#4ade80' : '#f43f5e';
      }
    }
    if (sseFloatingPips) {
      if (isFx) {
        const fp = marketStats.totalFloatingPips || 0;
        sseFloatingPips.innerHTML = `${fp >= 0 ? '+' : ''}${fp.toFixed(1)}`;
        sseFloatingPips.style.color = fp >= 0 ? '#4ade80' : '#f43f5e';
      } else {
        const openStk = marketStats.activeOpenCount || 0;
        sseFloatingPips.innerHTML = `${openStk} ตัว (NVDA, NFLX)`;
        sseFloatingPips.style.color = '#818cf8';
      }
    }
    if (sseFloatingPnl) {
      if (isFx) {
        const pnl = marketStats.totalFloatingPnl || 0;
        sseFloatingPnl.innerHTML = `${pnl >= 0 ? '+$' : '-$'}${Math.abs(pnl).toFixed(2)}`;
        sseFloatingPnl.style.color = pnl >= 0 ? '#4ade80' : '#fbbf24';
      } else {
        const pnl = marketStats.totalPnl || 0;
        sseFloatingPnl.innerHTML = `${pnl >= 0 ? '+$' : '-$'}${Math.abs(pnl).toFixed(2)}`;
        sseFloatingPnl.style.color = pnl >= 0 ? '#4ade80' : '#fbbf24';
      }
    }
  }

  // Update Live Open Positions Grid (Forex MT5)
  if (sseOpenCountBadge) {
    sseOpenCountBadge.innerHTML = `${(openPositions || []).length} ไม้`;
  }
  const forexTabSub = document.getElementById('forex-tab-sub');
  if (forexTabSub) {
    const count = (openPositions || []).length;
    forexTabSub.innerHTML = count > 0 ? `🟢 ${count} ไม้ MT5 รันสด` : `🟢 MT5 เชื่อมต่อสด`;
  }

  if (livePositionsGrid) {
    if (!openPositions || openPositions.length === 0) {
      livePositionsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 15px; color: #64748b; font-size: 12px;">
          ไม่มีออเดอร์ถือค้างใน MT5 ขณะนี้ (รอสัญญาณรอบถัดไป)
        </div>`;
    } else {
      livePositionsGrid.innerHTML = openPositions.map(pos => {
        const isBuy = pos.type === 'BUY';
        const pColor = pos.profit >= 0 ? '#4ade80' : '#f43f5e';
        const pipColor = pos.livePips >= 0 ? '#4ade80' : '#f43f5e';
        const cleanSym = String(pos.symbol).replace('=X', '');
        const dec = cleanSym.includes('JPY') ? 3 : 5;

        return `
          <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px; font-size: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.2);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-weight: bold; color: #f8fafc; font-size: 13px;">${cleanSym}</span>
              <span class="badge" style="background: ${isBuy ? 'rgba(34, 197, 94, 0.2)' : 'rgba(244, 63, 94, 0.2)'}; color: ${isBuy ? '#4ade80' : '#f43f5e'}; font-size: 10px; padding: 2px 6px;">
                ${pos.type} ${pos.volume} lot
              </span>
            </div>
            <div style="color: #94a3b8; font-size: 11px; display: flex; justify-content: space-between;">
              <span>เข้า: ${Number(pos.priceOpen).toFixed(dec)}</span>
              <span>สด: <b style="color: #cbd5e1;">${Number(pos.priceCurrent).toFixed(dec)}</b></span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 6px; border-top: 1px dashed #334155;">
              <span style="font-weight: bold; color: ${pipColor};">
                ${pos.livePips >= 0 ? '+' : ''}${pos.livePips} pips
              </span>
              <span style="font-weight: bold; color: ${pColor}; font-size: 13px;">
                ${pos.profit >= 0 ? '+$' : '-$'}${Math.abs(pos.profit).toFixed(2)}
              </span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Draw Live Canvas Chart for Selected Market
  if (!isStaticView) {
    const tradesToDraw = isFx ? (recentTradesForex || data.recentTrades || []) : (recentTradesStock || []);
    drawLiveMarketChart(tradesToDraw, selectedChartMarket);
  }
}

// Live Dynamic Canvas Chart Renderer (Supports both Forex and Stock)
function drawLiveMarketChart(trades, market = 'forex') {
  if (!canvasLivePips) return;
  const ctx = canvasLivePips.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvasLivePips.clientWidth;
  const height = canvasLivePips.clientHeight;

  canvasLivePips.width = width * dpr;
  canvasLivePips.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const isFx = market === 'forex';
  const valKey = isFx ? 'pips' : 'return_pct';
  const unitStr = isFx ? 'pips' : '%';
  const mainColor = isFx ? '#38bdf8' : '#818cf8';

  // Filter closed trades and sort chronologically
  const closed = trades
    .filter(t => t[valKey] !== null && t[valKey] !== undefined)
    .sort((a, b) => a.id - b.id);

  if (closed.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`ยังไม่มีข้อมูลไม้ที่ปิดสถานะในตลาด ${isFx ? 'Forex' : 'หุ้นสหรัฐ'}`, width / 2, height / 2);
    return;
  }

  // Calculate Cumulative Series
  let cum = 0;
  const points = [{ id: 0, val: 0, cum: 0, isWin: null }];
  closed.forEach(t => {
    cum += Number(t[valKey]);
    points.push({
      id: t.id,
      symbol: t.symbol,
      val: Number(t[valKey]),
      cum: Number(cum.toFixed(2)),
      // Use realized net P&L for display so positive pips with negative
      // broker costs are not shown as wins.
      isWin: Number(t.profit_loss) > 0
    });
  });

  const cums = points.map(p => p.cum);
  const minVal = Math.min(-5, Math.min(...cums));
  const maxVal = Math.max(5, Math.max(...cums));
  const range = (maxVal - minVal) || 1;

  const padLeft = 45;
  const padRight = 35;
  const padTop = 25;
  const padBottom = 30;

  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const getX = (idx) => padLeft + (idx / (points.length - 1 || 1)) * chartW;
  const getY = (val) => padTop + chartH - ((val - minVal) / range) * chartH;

  // Draw Grid Lines & Y-Axis Labels
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = minVal + (i / ySteps) * range;
    const y = getY(val);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillText(`${val >= 0 ? '+' : ''}${val.toFixed(isFx ? 0 : 1)}${unitStr}`, padLeft - 6, y + 3);
  }

  // Zero Line (Dashed)
  const zeroY = getY(0);
  ctx.beginPath();
  ctx.strokeStyle = '#475569';
  ctx.setLineDash([4, 4]);
  ctx.moveTo(padLeft, zeroY);
  ctx.lineTo(width - padRight, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw Gradient Area under curve
  ctx.beginPath();
  ctx.moveTo(getX(0), getY(0));
  points.forEach((pt, idx) => {
    ctx.lineTo(getX(idx), getY(pt.cum));
  });
  ctx.lineTo(getX(points.length - 1), zeroY);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, padTop, 0, height - padBottom);
  const lastVal = cums[cums.length - 1];
  if (lastVal >= 0) {
    grad.addColorStop(0, 'rgba(34, 197, 94, 0.25)');
    grad.addColorStop(1, 'rgba(34, 197, 94, 0.0)');
  } else {
    grad.addColorStop(0, isFx ? 'rgba(56, 189, 248, 0.15)' : 'rgba(129, 140, 248, 0.15)');
    grad.addColorStop(1, 'rgba(244, 63, 94, 0.25)');
  }
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw Line
  ctx.beginPath();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = mainColor;
  points.forEach((pt, idx) => {
    if (idx === 0) ctx.moveTo(getX(idx), getY(pt.cum));
    else ctx.lineTo(getX(idx), getY(pt.cum));
  });
  ctx.stroke();

  // Draw Points
  points.forEach((pt, idx) => {
    if (idx === 0) return;
    const x = getX(idx);
    const y = getY(pt.cum);

    ctx.beginPath();
    ctx.arc(x, y, pt.isWin ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = pt.isWin ? '#22c55e' : '#ef4444';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
  });

  // Current Metric Badge on last point
  const lastPt = points[points.length - 1];
  const lastX = getX(points.length - 1);
  const lastY = getY(lastPt.cum);

  ctx.fillStyle = lastPt.cum >= 0 ? '#22c55e' : '#f43f5e';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${lastPt.cum >= 0 ? '+' : ''}${lastPt.cum.toFixed(isFx ? 1 : 2)} ${unitStr}`, lastX + 8, lastY + 4);
}

// Sync chart market when top tabs are clicked
tabStocks.addEventListener('click', () => setChartMarket('stock'));
tabForex.addEventListener('click', () => setChartMarket('forex'));

// Window resize listener
window.addEventListener('resize', () => {
  if (chartBars.length > 0) drawChart(chartBars, selectSymbol.value);
  if (lastTelemetryData && !isStaticView) updateTelemetryUI(lastTelemetryData);
});

// Initialize Everything
updateSymbolOptions();
loadDashboard();
initSSE();
setInterval(loadDashboard, 20000);
