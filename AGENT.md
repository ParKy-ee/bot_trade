# AGENT OPERATIONAL DIRECTIVE & ARCHITECTURE RULES

> **Last Updated**: 2026-09-18 08:50 Asia/Bangkok  
> **Environment**: MetaTrader 5 (XM Global MT5 Demo — Login: `169315887`, Server: `XMGlobal-MT5 2`)  
> **Operating Mode**: Full Autonomous AI Live Execution (Demo Capital / Maximum ML Exploration Mode)  
> **Active Models**: Forex Champion `v1.6.0` | Forex Challenger `challenger-v1.6.0` | Crypto `v1.2.0` | Dynamic Trailing `v1.0`

---

## 🎯 1. Core Operating Philosophy (หลักการทำงานของบอท)

1. **Demo Account Full Freedom (บัญชีเดโม ทดลองได้เต็มที่ไร้กังวลเรื่องพอร์ต)**:
   - บัญชีที่เชื่อมต่อกับ MT5 เป็น **XM Global MT5 Demo Account** ไม่ใช่เงินจริง
   - **ไม่ต้องกังวลเรื่องการ Drawdown ของพอร์ตเงินจริง**: บอทได้รับอนุญาตให้ส่งคำสั่งเทรดจริงบน MT5 ได้อย่างอิสระเต็มที่ เพื่อให้โมเดล AI ได้สัมผัสสภาวะตลาดจริงและสะสมประสบการณ์ความผิดพลาด/ชัยชนะอย่างเป็นกลาง (Unbiased Learning)

2. **Data Harvesting & Multi-Position Scale (โหมดสะสมประสบการณ์จริง)**:
   - อนุญาตให้เปิด position สะสมประสบการณ์พร้อมกันได้สูงสุด **3–4 ไม้ต่อสัญลักษณ์** สำหรับตลาด Crypto (`SOLUSD`, `BTCUSD`, `ETHUSD`), Forex (`EURUSD`, `GBPUSD` ฯลฯ) และ Gold (`GOLD`)
   - หุ้นสหรัฐ (`NVDA`, `TSLA`, `AMD`, `MSFT`, `GOOGL`) ล็อคไว้ไม่เกิน **2 ไม้ต่อตัว** เพื่อรักษาสภาพคล่อง
   - ทุกไม้ที่เข้าเทรดและปิดสถานะจะถูกบันทึก 13 Features และ PnL ลงฐานข้อมูล `trade_results` เพื่อใช้เป็น Ground Truth สำหรับการ Retrain ต่อเนื่อง

3. **Multi-Tier Profit Ratchet & Stall Harvester Active (ระบบล็อกกำไรขั้นบันได)**:
   - **Tier 1 (50% TP)**: ล็อก Break-Even $+1.5$ pips ทันที
   - **Tier 2 (70% TP)**: ล็อกกำไรขั้นบันได $+50\%$ ของ TP ป้องกันกำไร 70-80% ไหลกลับมาติดลบ
   - **Tier 3 (85% TP)**: ล็อกกำไร $+70\%$ ของ TP พร้อม Trail ชิดราคา
   - **Momentum Stall Harvester**: ตรวจจับกราฟที่ขึ้นแตะ $\ge 70\%$ TP แล้วนิ่งค้าง $\ge 15$ นาที บอทจะสั่งปิดเก็บกำไรทันที (`CLOSED_STALL_HARVEST`)
   - **One-Way Ratchet Rule**: ค่า Stop Loss จะต้องเลื่อนไปในทิศทางที่เป็นบวกเสมอ ห้ามถอยกลับ

---

## 🛡️ 2. Data Integrity Guarantee (การรับประกันความสมบูรณ์ของชุดข้อมูลเดิม)

1. **ไม่กระทบ Dataset ในอดีต (100% Backward Compatible)**:
   - ไฟล์ประวัติศาสตร์ `data/dataset_forex_m5.csv` (44,559 แท่ง) และ `dataset_crypto_m5.csv` (8,922 แท่ง) ยังคงสมบูรณ์ ไม่มีการแก้ไขโครงสร้าง
2. **ความเข้ากันได้ของ Features 13 ตัว**:
   - ฟีเจอร์ที่โมเดลใช้ (`ret_1`, `ret_5`, `rsi_14`, `atr_pct`, `adx_14`, `ema_spread_20_50`, `macd_hist`, `csm_spread`, `h1_trend_slope`, `is_jpy`, `time_sin_hour`, `time_cos_hour`, `spread_to_atr`) จะถูกคำนวณและบันทึกลง `trade_results` ในทุกออเดอร์อย่างครบถ้วน
3. **Continuous Retraining Support**:
   - ทุกคำสั่งที่ปิดสถานะบน MT5 จะสามารถถูกนำไป Retrain ผ่าน `npm run model:retrain` ได้ทันทีแบบไร้รอยต่อ

---

## ⚙️ 3. Key Runtime Configurations ([.env](file:///C:/xampp/htdocs/trade_bot/.env))

* `MT5_ENABLED=true`
* `TRADING_SANDBOX_ENABLED=false` *(เมื่อเป็น `true` ระบบหลักจะบังคับเป็น shadow และบล็อกการเปิดออเดอร์ MT5)*
* `FOREX_MODEL_VERSION=v1.6.0` *(Champion Model)*
* `FOREX_CHALLENGER_MODEL_VERSION=challenger-v1.6.0` *(Challenger Model)*
* `CRYPTO_MODEL_VERSION=v1.2.0` *(Crypto Tri-Ensemble)*
* `FOREX_CONFIDENCE_THRESHOLD=0.45`
* `FOREX_MAX_POSITIONS_PER_SYMBOL=4`
* `CRYPTO_MAX_POSITIONS_PER_SYMBOL=4`
* `GOLD_MAX_POSITIONS_PER_SYMBOL=4`
* `STOCK_MAX_POSITIONS_PER_SYMBOL=2`
* `FOREX_SCALP_MODE=true` *(โหมดสไนเปอร์เก็บเร็ว 1.5 - 2.5 pips)*
* `FOREX_MICRO_HARVEST_PIPS_MAJOR=1.8` *(ปิดรวบกำไรทันทีเมื่อคู่ Major กำไรแตะ 1.8 pips)*
* `FOREX_MICRO_HARVEST_PIPS_JPY=2.5` *(ปิดรวบกำไรทันทีเมื่อคู่ JPY กำไรแตะ 2.5 pips)*
* `FOREX_MICRO_BE_TRIGGER_PIPS=0.6` *(ล็อกทุน +0.1 pips ทันทีเมื่อกำไร +0.6 pips)*
* `FOREX_STEPDOWN_MAX_MINUTES=12` *(ถือเกิน 12 นาทีแล้วกำไรเป็นบวก >= +0.4 pips ปิดทำกำไรทันที)*
* `FOREX_DYNAMIC_MIN_TP_MAJOR=3.5`
* `FOREX_DYNAMIC_MIN_SL_MAJOR=2.8` *(กระชับ SL คู่ Major เหลือ 2.8 pips)*
* `FOREX_DYNAMIC_MIN_TP_JPY=5.5`
* `FOREX_DYNAMIC_MIN_SL_JPY=4.2` *(กระชับ SL คู่ JPY เหลือ 4.2 pips)*
* `FOREX_STALL_HARVEST_ENABLED=true`
* `FOREX_TP_MULTIPLIER=1.0`

---

## ⚡ 4. Asset Class Holding Duration Matrix & AI Exit Architecture

ระบบได้รับการออกแบบให้ถือครองและปิดสถานะแยกตามธรรมชาติของสินทรัพย์ 4 กลุ่มอย่างชัดเจน:

| ประเภทสินทรัพย์ | กรอบเวลาถือครองที่ออกแบบไว้ | กลยุทธ์การปิดทำกำไร (Take Profit / Harvest) | กลยุทธ์การตัดความเสี่ยง (Stop / AI Exit) |
| :--- | :---: | :--- | :--- |
| 💱 **Forex (คู่เงิน)** | **20 – 30 นาที** (ห้ามค้างข้ามคืน) | `CLOSED_MICRO_SCALP` (+1.8 pips Major / +2.5 pips JPY)<br>`CLOSED_STEPDOWN_PROFIT` (12 นาที) | `CLOSED_TIME_STOP` (30 นาที Hard Cutoff)<br>SL แคบ 2.8 – 4.2 pips |
| 🥇 **Gold (XAUUSD / GOLD)** | **20 – 30 นาที** (สไนเปอร์เก็บเร็ว) | `CLOSED_MICRO_SCALP` (+1.5x ATR หรือ >= +$2.50)<br>`CLOSED_TP` (+4.5x ATR) | `CLOSED_TIME_STOP` (30 นาที Hard Cutoff)<br>SL กว้าง $3.50+ เผื่อ Market Noise |
| 🪙 **Crypto (BTC, ETH, SOL)** | **1 – 6 ชั่วโมง** (ปานกลาง / ลากตามเทรนด์) | `Trend Rider Trailing` (ลาก SL ตาม $+2.0\text{x ATR}$)<br>Dynamic Multi-Tier TP | `CLOSED_AI_TREND_EXIT` (EMA20/50 breakdown)<br>`CLOSED_TIME_STOP` (180 นาทีถ้านิ่ง) |
| 📈 **US Stocks (CFD หุ้นเติบโต)** | **1 – 3 วัน** (Swing / Minervini Trend) | `Chandelier TP1 50%` (+2.5 ATR)<br>`Runner Trailing Stop` (3.0 ATR) | `CLOSED_AI_TREND_EXIT` (RS < 0, SPY Bearish, Price < EMA50)<br>Minervini 3-Day Stale Rule |

---

## 🧪 5. Testing & Operational Verification Protocols (คำแนะนำและคู่มือการ Test ระบบ)

เพื่อให้การบำรุงรักษาและการทดสอบระบบเป็นไปอย่างมีมาตรฐาน ปลอดภัย และไม่กระทบต่อชุดข้อมูล ให้ปฏิบัติตามคู่มือการ Test แต่ละส่วนดังนี้:

### 5.1 ตรวจสอบความพร้อมของระบบฐานข้อมูล (Database & Health Check)
* **ทดสอบเชื่อมต่อ MySQL (XAMPP)**:
  ```powershell
  npm run test-db
  ```
  *(ผลลัพธ์ต้องแสดง `Database connection successful`)*
* **ตรวจสอบโครงสร้างตารางข้อมูลและจำนวน Record ล่าสุด**:
  ```powershell
  node scripts/check_tables.js
  ```
* **ตรวจสอบ Syntax ของโค้ด JavaScript ทั้งหมดก่อนเริ่มรัน**:
  ```powershell
  node -c server.js daemon.js services/tradingEngine.js services/forexEngine.js services/cryptoEngine.js services/goldEngine.js services/tradeResultTracker.js
  ```

---

### 5.2 ทดสอบการเชื่อมต่อ MT5 Broker & Symbol Bridge
* **ตรวจสอบสถานะ Terminal และดึงรายการ Open Positions ปัจจุบัน**:
  ```powershell
  python -c "import MetaTrader5 as mt5; mt5.initialize(); pos = mt5.positions_get(); print(f'Total Open Positions: {len(pos)}' if pos else 'No open positions'); from collections import Counter; print(dict(Counter([p.symbol for p in pos])) if pos else {}); mt5.shutdown()"
  ```
* **ทดสอบการดึงราคาแท่งเทียนสดจาก MT5 (M5)**:
  ```powershell
  python python/mt5_bridge.py rates EURUSD M5 10
  ```
* **สคริปต์ปิดล้างสถานะหุ้น CFD ค้าง (รันเมื่อตลาดสหรัฐเปิด 20:30 น.)**:
  ```powershell
  node scratch/close_stock_positions.js
  ```

---

### 5.3 ทดสอบการสแกนตลาดแบบเดี่ยว (Isolated Single Scan Tests)
สามารถสั่งรัน Scan Cycle เฉพาะตลาดที่ต้องการทดสอบได้ทันทีโดยไม่ต้องรัน Daemon:
* **Forex Scan Test (สแกน 7 คู่เงิน)**:
  ```powershell
  node -e "import('./services/forexEngine.js').then(m => m.executeForexScanCycle())"
  ```
* **Crypto Scan Test (BTC, ETH, SOL)**:
  ```powershell
  npm run crypto:scan
  ```
* **Gold Scan Test (XAUUSD / GOLD)**:
  ```powershell
  node -e "import('./services/goldEngine.js').then(m => m.executeGoldScanCycle())"
  ```
* **Stock Scan Test (บังคับสแกนหุ้นแม้ตลาดปิด)**:
  ```powershell
  node -e "import('./services/tradingEngine.js').then(m => m.executeScanCycle({ force: true }))"
  ```

---

### 5.4 การวิเคราะห์ผลงานและสถิติการเทรด (Performance Diagnostics)
* **สรุปผลงานภาพรวม 24 ชม. ล่าสุด (Win Rate, PnL, Avg Pips, Exit Reasons)**:
  ```powershell
  node scratch/summarize_last_night.js
  ```
* **วิเคราะห์เชิงลึกแยกตาม Model และ Session ตลาด**:
  ```powershell
  node scripts/deep_model_and_session_analysis.js
  ```
* **เปรียบเทียบผลงานตลาด Crypto vs Forex**:
  ```powershell
  node scripts/analyze_crypto_vs_forex.js
  ```

---

### 5.5 การประเมินและเทรนโมเดล AI ใหม่ (Model Retraining Pipeline)
1. **ขั้นตอนที่ 1: Labeling แท่งเทียนจริงล่วงหน้า (Forward Observation)**:
   ```powershell
   npm run data:label:forex
   ```
2. **ขั้นตอนที่ 2: Retrain โมเดล Champion Forex (v1.x)**:
   ```powershell
   npm run model:retrain
   ```
3. **ขั้นตอนที่ 3: Retrain โมเดล Challenger Forex**:
   ```powershell
   npm run model:train:challenger:new
   ```
4. **ขั้นตอนที่ 4: Retrain โมเดล Crypto (BTC/ETH/SOL)**:
   ```powershell
   npm run crypto:retrain:results
   ```

---

### 5.6 การตรวจสอบและสลับเวอร์ชันโมเดล (Model Registry Management)
* **แสดงรายการเวอร์ชันโมเดล Forex M5 ทั้งหมด**:
  ```powershell
  npm run model:list
  ```
* **แสดงรายการเวอร์ชันโมเดล Crypto ทั้งหมด**:
  ```powershell
  npm run crypto:model:list
  ```
* **เปรียบเทียบ Metrics ระหว่าง 2 เวอร์ชัน**:
  ```powershell
  python scripts/model_registry.py --compare v1.5.0 v1.6.0
  ```
* **สลับเวอร์ชันโมเดลที่ใช้งานแบบ On-the-fly**:
  ```powershell
  python scripts/model_registry.py --activate v1.6.0
  ```

---

### 5.7 กฎความปลอดภัยของระบบ Multi-Position & Data Harvesting
1. **Symbol Normalization Rule**: ต้องแน่ใจว่าชื่อหุ้น CFD ของโบรกเกอร์ (เช่น `Nvidia`, `Tesla`, `AdvMicroDev`, `Microsoft`, `Google`) ถูกแปลงด้วย `STOCK_BROKER_MAP` ก่อนการเช็คซ้ำเสมอ
2. **5-Minute Candle Idempotency Guard**: ห้ามเปิดออเดอร์ในคู่เงิน/หุ้น/เหรียญเดิมซ้ำภายในแท่ง M5 เดียวกันเด็ดขาด
3. **Ticket-Based Position Tracking**: ระบบ Sync ข้อมูลกับ MT5 ต้องอ้างอิงจากเลข `Ticket ID (Integer)` เสมอ เพื่อป้องกันข้อผิดพลาดจากการตั้งชื่อ Symbol ที่แตกต่างกันของโบรกเกอร์
