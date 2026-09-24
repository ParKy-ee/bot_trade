# 🧠 System Knowledge & Architectural Reference: AI Trading Bot System

**Updated as of**: 2026-09-08 (Live MT5 Demo & Dual Daemon Active)

---

## 1. 🏗️ สถาปัตยกรรมระบบหลัก (System Architecture)
ระบบเป็น **AI Multi-Asset Trading Bot** ที่ออกแบบมาเพื่อรันเทรดอัตโนมัติ 2 ตลาดพร้อมกันบน Windows (ไม่ใช้ Docker):
* **Backend Runtime**: Node.js (ES Module) บน Port 3000
* **Database**: XAMPP MySQL (Port 3306) ฐานข้อมูล `ai_trading_db`
  * ตาราง `market_bars`: บันทึกแท่งเทียนราคาและ Indicator ย้อนหลัง
  * ตาราง `signals`: บันทึกสัญญาณเทรดที่ตรวจพบ (BUY/SELL)
  * ตาราง `active_positions`: จัดการสถานะออเดอร์ที่กำลังถือครองและ Trailing Stop
  * ตาราง `trade_results`: บันทึก Feature ตอนเข้าเทรดและ Outcome ผลลัพธ์หลังปิดไม้สำหรับวิจัย ML
* **Broker Execution**: MetaTrader 5 (MT5) บัญชี XM Global Demo (`169315887`) เชื่อมต่อผ่าน Python Bridge IPC (`python/mt5_bridge.py`)

---

## 2. ⚡ กลไกการทำงานคู่ขนานและ Real-Time Telemetry (Dual Engine)
* **Dual-Daemon Schedulers**:
  * `runScheduledScan()`: สแกนหุ้นสหรัฐ 9 ตัว (`SPY`, `NVDA`, `AMD`, `TSLA`, `MSFT`, `AVGO`, `NFLX`, `AMZN`, `META`, `GOOGL`) ทุก 5 นาที
  * `runScheduledForexScan()`: สแกนคู่เงิน 9 ตัว (`EURUSD`, `GBPUSD`, `USDJPY`, `USDCHF`, `AUDUSD`, `USDCAD`, `NZDUSD`, `EURJPY`, `GBPJPY`) ทุก 5 นาที
  * ทั้งสองตัวรันคู่ขนานกัน ไม่ขัดจังหวะกัน และไม่ขึ้นอยู่กับว่าเปิดหน้าจอเว็บไว้ที่แท็บใด
* **Fast-Sync Engine (2.5 วินาที)**:
  * ฟังก์ชัน `startFastSync()` ใน `server.js` ดึง Deal และ Open Positions จาก MT5 ทุก 2.5 วินาที
  * อัปเดตการชน SL หรือ TP ลง MySQL ทันทีที่เกิดขึ้นจริงใน MT5
* **Server-Sent Events (SSE) Stream (`GET /api/stream`)**:
  * สตรีม Telemetry สดทุก 2.5 วินาที ส่งข้อมูล Stats, Live Pips, และ Floating P&L ของออเดอร์ที่กำลังถือเข้าสู่ Browser
  * มี Fallback Snapshot ที่ `GET /api/realtime-state`

---

## 3. 🎯 Pipeline การสแกนและการยิงออเดอร์ (Sequential Stream Pipeline)
* **การดึงข้อมูล**: ดึงแท่งเทียนราคาของทั้ง Universe พร้อมกันก่อนเพื่อคำนวณ Benchmark (`DXY` สำหรับ Forex, `SPY` สำหรับหุ้น)
* **การวิเคราะห์และยิงออเดอร์**: วนลูปทีละตัวตามลำดับ (Sequential Evaluation):
  1. ดึงคู่เงิน/หุ้นมาคำนวณ Indicator (EMA 9/21/50, RSI 14, ADX 14, MACD Hist, ATR)
  2. ส่งค่าเข้าโมเดล ML เพื่อทำนายความมั่นใจ ($\ge 51\%$)
  3. ตรวจสอบ 4 เงื่อนไขความปลอดภัย:
     - ความมั่นใจ $\ge 51\%$
     - ยังไม่ถือคู่นี้อยู่ (One Position per Symbol)
     - พ้น Cooldown 15 นาที
     - Gemini LLM Reviewer อนุมัติ (ถ้าเปิดใช้)
  4. **ยิงคำสั่งเข้า MT5 ทันที ณ วินาทีนั้น**: ไม่ต้องรอคู่อื่นให้เสียจังหวะราคา (Zero Execution Latency)

---

## 4. 🤖 การแยกโมเดล Machine Learning อย่างเด็ดขาด
1. **US Stock Swing Trading Model**:
   * ไฟล์โมเดล: `python/models/dynamic_trailing_model.joblib`
   * ฟีเจอร์: `rs_20d` (Relative Strength เทียบ SPY), `rvol`, `dist_to_20d_high`, ATR
   * วัตถุประสงค์: ถือครองหุ้นสวิงเทรดระยะกลาง (Swing 2-10 วัน) พร้อม Trailing Stop
2. **Forex M5 Scalping Model**:
   * ไฟล์โมเดล: `python/models/forex_m5_model.joblib`
   * สถาปัตยกรรม: Ensemble คู่ระหว่าง **LightGBM + Random Forest** (ทำนายแยก BUY และ SELL)
   * ฟีเจอร์: `ret_1`, `ret_5`, `rsi_14`, `atr_pct`, `adx_14`, `ema_spread_20_50`, `macd_hist`
   * การตัดสินใจ: คำนวณ Relative Probability $P(BUY) / [P(BUY) + P(SELL)] \ge 51\%$
   * สคริปต์ Retrain: `scripts/retrain_from_trade_results.py` ดึงข้อมูลจริงจากตาราง `trade_results`

---

## 5. 🛡️ การบริหารความเสี่ยงและการแก้ปัญหา Spread Trap (Broker Calibration)
* **สาเหตุการชน SL เดิม**: โบรกเกอร์ XM มี Spread 1.5 - 3.5 pips เมื่อตั้ง SL 4 pips จะถูกค่า Spread และ M5 Noise ชน SL ทันที
* **ระยะ SL/TP ใหม่ที่ปรับแต่งแล้ว**:
  * **Major Pairs**: SL ขั้นต่ำ 14 pips ($2.2 \times ATR$), TP ขั้นต่ำ 22 pips ($3.3 \times ATR$) [R:R 1 : 1.57]
  * **JPY Pairs**: SL ขั้นต่ำ 24 pips ($2.2 \times ATR$), TP ขั้นต่ำ 38 pips ($3.3 \times ATR$) [R:R 1 : 1.58]
  * **Quick Break-Even**: เมื่อกำไร $+1.5 \times ATR$ (ขั้นต่ำ 8 pips) ปรับ SL ล็อกกำไรที่ $+2$ pips

---

## 6. 📊 การแยกชุดข้อมูลและกราฟระหว่าง Stock และ Forex
* **ตาราง `trade_results`**:
  * กำกับ `market_type = 'forex'` (เก็บเป็น Pips, USD P&L)
  * กำกับ `market_type = 'stock'` (เก็บเป็น % Return, Price Points)
* **API Endpoints**:
  * `/api/trade-results?market=forex|stock|all`
  * `/api/trade-results/stats?market=forex|stock|all`
* **Dashboard Live Chart**:
  * แสดงกราฟแยกอิสระ: สลับดูกราฟ **Forex Pips** หรือ **Stock % Return** ได้จากทั้งปุ่ม Toggle และการสลับแท็บ
* **Matplotlib Static Plotter (`scripts/plot_trade_results.py`)**:
  * กราฟ 4-Panel: 2 กราฟบนสำหรับ Forex (Pips & Currency breakdown) และ 2 กราฟล่างสำหรับ Stock (% Return & Ticker breakdown)
