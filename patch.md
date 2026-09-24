# 📋 System Release Notes & Technical Specifications: patch.md

เอกสารบันทึกรายละเอียดสถาปัตยกรรมระบบ, รูปแบบข้อมูล, อินดิเคเตอร์, และโมเดล Machine Learning ในแต่ละเวอร์ชันของการพัฒนา (Collect Data Term)

---

## 🏷️ เวอร์ชัน: `ver.beta.0 (collect data term)`
**วันที่บันทึก**: 2026-09-08 (ก่อนการปรับปรุงระบบ)  
**เป้าหมายหลัก**: วางรากฐานระบบ Dual-Asset Autonomous Trading Bot รันเก็บข้อมูลและเทรดอัตโนมัติบน MT5 Demo ข้ามคืน

### 1. 🏗️ ภาพรวมระบบและความสามารถ (System Capabilities)
* **การเทรด 2 ตลาดคู่ขนาน (Dual-Daemon Engine)**:
  - **Forex M5 Scalping**: สแกนคู่เงิน 9 คู่ (`EURUSD`, `GBPUSD`, `USDJPY`, `USDCHF`, `AUDUSD`, `USDCAD`, `NZDUSD`, `EURJPY`, `GBPJPY`) ทุก 5 นาที
  - **US Stocks Swing**: สแกนหุ้นสหรัฐ 9 ตัว (`NVDA`, `AMD`, `TSLA`, `MSFT`, `AVGO`, `NFLX`, `AMZN`, `META`, `GOOGL`) ทุก 5 นาที
* **Fast-Sync & Real-Time Telemetry**:
  - ซิงค์สถานะออเดอร์กับ MT5 ทุก 2.5 วินาที
  - สตรีม Telemetry แบบสดผ่าน Server-Sent Events (SSE) ที่ `GET /api/stream`
* **ระบบความปลอดภัยและการป้องกันความเสี่ยง (Risk Guards)**:
  - **Session Guard**: ระงับการเปิดออเดอร์ Forex ในช่วงเวลาผันผวนสูง (16:00-17:00 น. London Fix และ 19:00-20:15 น. Pre-US Open)
  - **Consecutive Loss Circuit Breaker**: พักเทรดคู่เงินนั้น 2 ชั่วโมงหากแพ้ติดกัน 2 ไม้
  - **Cooldown Guard**: ห้ามเปิดออเดอร์ซ้ำในคู่เดิมภายใน 15 นาที
  - **One Position Per Symbol**: จำกัดการถือครอง 1 ออเดอร์ต่อ 1 สัญลักษณ์

---

### 2. 🤖 โมเดล Machine Learning และสถาปัตยกรรม (ML Models)
#### A. Forex M5 Tri-Ensemble Model v1
* **ไฟล์โมเดล**: `python/models/forex_m5_model.joblib`
* **สถาปัตยกรรม Ensemble**:
  - LightGBM Classifier (น้ำหนัก 35%)
  - XGBoost Classifier (น้ำหนัก 25%)
  - CatBoost Classifier (น้ำหนัก 25%)
  - Random Forest Classifier (น้ำหนัก 15%)
* **วิธีการติดป้ายข้อมูล (Triple Barrier Method)**:
  - Upper Barrier (TP Target): $+1.5 \times \text{ATR}$ (คำนวณจากเปอร์เซ็นต์ราคา)
  - Lower Barrier (SL Barrier): $-1.0 \times \text{ATR}$
  - Time Barrier: 5 แท่งเทียน M5
* **การตัดสินใจ (Inference Logic)**:
  - คำนวณความน่าจะเป็นสัมพัทธ์:
    $$\text{Relative Confidence} = \frac{P(BUY)}{P(BUY) + P(SELL)}$$
  - เกณฑ์การส่งคำสั่ง (Confidence Threshold): $\ge 0.58$ (หรือ $\ge 58\%$)

#### B. US Stock Swing Model
* **ไฟล์โมเดล**: `python/models/dynamic_trailing_model.joblib`
* **ฟีเจอร์หลัก**: Relative Strength vs SPY (`rs_20d`), RVOL, Distance to 20-Day High, ATR Volatility
* **เกณฑ์การส่งคำสั่ง**: ความมั่นใจ $\ge 0.45$, ดัชนีตลาดแม่ SPY อยู่ในสภาวะ Bullish, และราคาอยู่เหนือ EMA 50

---

### 3. 📊 อินดิเคเตอร์และพารามิเตอร์ทางเทคนิค (Indicators & Parameters)
ระบบใน `ver.beta.0` ใช้ชุดอินดิเคเตอร์มาตรฐานในการคำนวณ Feature ดังนี้:

| อินดิเคเตอร์ (Indicator) | สัญลักษณ์ / พารามิเตอร์ (Parameters) | วัตถุประสงค์และการนำไปใช้ |
| :--- | :--- | :--- |
| **EMA 9** | Exponential Moving Average (Period = 9) | ติดตามโมเมนตัมระยะสั้นพิเศษ |
| **EMA 21** | Exponential Moving Average (Period = 21) | เส้นแบ่งเทรนด์ย่อยระยะสั้น |
| **EMA 50** | Exponential Moving Average (Period = 50) | Trend Baseline บังคับ BUY เหนือเส้น และ SELL ใต้เส้น |
| **RSI 14** | Relative Strength Index (Period = 14) | วัดโมเมนตัมภาพรวม (Forex & Stock) |
| **RSI 9** | Relative Strength Index (Period = 9) | วัด Overbought / Oversold ตอบสนองไวในแท่ง M5 |
| **ADX 14** | Average Directional Index (Period = 14) | วัดความแรงของเทรนด์ (Trend Strength) |
| **MACD Hist** | Fast = 12, Slow = 26, Signal = 9 | Histogram วัดอัตราเร่งของการบีบ/ขยายตัวของราคา |
| **ATR 14** | Average True Range (Period = 14) | คำนวณระยะ Stop Loss, Take Profit และ Trailing Stop |
| **CSM Spread** | Currency Strength Meter (8 Currencies, Lookback = 12 bars) | คำนวณความแข็งแกร่งสัมพัทธ์ของ Base Currency ลบ Quote Currency |
| **RS 20D** | Relative Strength เทียบ SPY (20 วันทำการ) | คัดเลือกหุ้นที่มีความแข็งแกร่งชนะตลาดภาพรวม |
| **RVOL 20D** | Relative Volume (Volume ปัจจุบัน / เฉลี่ย 20 วัน) | กรอง Volume Breakout ของหุ้น |

---

### 4. 🗄️ รูปแบบและโครงสร้างข้อมูลที่บันทึก (Data Schema)
บันทึกลงฐานข้อมูล XAMPP MySQL `ai_trading_db`:
1. **ตาราง `market_bars`**:
   - ฟิลด์: `time`, `symbol`, `open`, `high`, `low`, `close`, `volume`, `rsi`, `atr`, `market_type`, `last_scanned_at`
2. **ตาราง `signals`**:
   - ฟิลด์: `id`, `time`, `symbol`, `price`, `ai_confidence`, `sl_price`, `tp_price`, `action`, `market_type`, `mt5_ticket`
3. **ตาราง `active_positions`**:
   - ฟิลด์: `symbol`, `entry_date`, `entry_price`, `highest_price`, `sl_price`, `tp_price`, `status_note`, `updated_at`, `market_type`, `mt5_ticket`
4. **ตาราง `trade_results` (หัวใจของการเรียนรู้ ML)**:
   - บันทึก Feature ทั้งหมด ณ วินาทีที่เปิดออเดอร์: `entry_time`, `entry_price`, `lot_size`, `ai_confidence`, `sl_price`, `tp_price`, `ema9`, `ema21`, `ema50`, `rsi`, `adx`, `macd_hist`, `atr`, `filter_reasons`
   - บันทึกผลลัพธ์หลังปิดออเดอร์: `exit_time`, `exit_price`, `exit_reason` (`CLOSED_TP`, `CLOSED_SL`), `pips`, `profit_loss`, `return_pct`, `is_win`, `hold_duration_minutes`

---

### 5. 🔍 ผลการดำเนินงานและปัญหาที่พบใน `ver.beta.0`
* **ข้อดีที่พบ**:
  - กลุ่ม JPY Crosses (`USDJPY`, `EURJPY`, `GBPJPY`) ทำผลงานยอดเยี่ยม Win Rate 73.9%, Profit Factor 3.10
  - หุ้นสหรัฐ `MSFT` (+$56.48) และ `NVDA` (+$25.19) รันเทรนด์ได้กำไรก้อนใหญ่
* **ข้อจำกัดและปัญหา (Bottlenecks)**:
  1. คู่เงิน Non-JPY Majors (`GBPUSD`, `USDCHF`) สภาวะ Sideway มี Win Rate ต่ำเพียง 22.2% ฉุดรั้งกำไรโดยรวม
  2. หุ้นสหรัฐยังไม่มีฟังก์ชัน Partial Take Profit ทำให้ต้องถือจนชน Trailing Stop อย่างเดียว
  3. ระบบ Fast-Sync ตรวจสอบเฉพาะ `market_type = 'forex'` ทำให้ไม้หุ้นบน MT5 (เช่น `AMD`) หลุดการ Sync ในฐานข้อมูล

---
---

## 🏷️ เวอร์ชัน: `ver.beta.0.1 (collect data term)`
**วันที่บันทึก**: 2026-09-09 (หลังการติดตั้ง 3 Phase Architecture)  
**เป้าหมายหลัก**: ปรับปรุงระบบตามสถิติเชิงประจักษ์ คัดกรองตลาด Sideway, เพิ่มกลยุทธ์ Chandelier Multi-Stage Exit และขยายฟีเจอร์โมเดล ML

### 1. 🛡️ การอัปเกรด Phase 1: Dynamic Symbol Gating & Asymmetric Sizing
* **Dynamic Symbol Gating** ([`services/forexEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/forexEngine.js)):
  - บังคับคัดกรองคู่เงินก่อนส่งให้ AI ประเมินสัญญาณ:
    * **กลุ่ม JPY Crosses**: กำหนดเกณฑ์ $\text{ADX} \ge 18$ และ $|CSM_{spread}| \ge 1.5$
    * **กลุ่ม Non-JPY Majors**: กำหนดเกณฑ์ $\text{ADX} \ge 22$ และ $|CSM_{spread}| \ge 2.2$
  - ผลลัพธ์: ปฏิเสธคู่เงิน Sideway ไร้เทรนด์ทันที พร้อมบันทึก `🛡️ [GATING FILTER]` ขจัด False Breakout
* **Asymmetric Position Sizing**:
  - ในไม้ที่มีความมั่นใจสูงพิเศษ (AI Confidence $\ge 75\%$ และ $|CSM_{spread}| \ge 3.0$) ขยาย Lot Size จาก 0.01 เป็น **0.02 Lot** อัตโนมัติ เพื่อเพิ่มน้ำหนักกำไรในจังหวะที่มีแต้มต่อสูง

---

### 2. 🎯 การอัปเกรด Phase 2: Chandelier Multi-Stage Exit สำหรับหุ้น & MT5 Stock Sync
* **MT5 Partial Close Engine** ([`python/mt5_bridge.py`](file:///c:/xampp/htdocs/trade_bot/python/mt5_bridge.py) & [`services/mt5Broker.js`](file:///c:/xampp/htdocs/trade_bot/services/mt5Broker.js)):
  - รองรับคำสั่ง Partial Volume Close ผ่าน `TRADE_ACTION_DEAL` บน MT5
* **Chandelier Multi-Stage Exit** ([`services/tradingEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/tradingEngine.js)):
  - **TP1 (Core 50%)**: เมื่อราคาวิ่งถึง $+2.5 \times \text{ATR}$ ส่งคำสั่งปิดทำกำไรกึ่งหนึ่ง (50% Volume) บน MT5 เพื่อล็อกกำไรเข้าพอร์ต
  - **Break-Even Floor**: ขยับ SL ของไม้ที่เหลือมาที่ราคาคุ้มทุน ($+0.5 \times \text{ATR}$) การันตีไม่มีวันขาดทุน
  - **TP2 (Runner 50%)**: ปล่อยให้รันต่อด้วย Chandelier Exit ($\text{Highest High} - 3.0 \times \text{ATR}$)
* **Dual-Market Fast-Sync Fix** ([`services/tradeResultTracker.js`](file:///c:/xampp/htdocs/trade_bot/services/tradeResultTracker.js)):
  - แก้ไขคิวรี Fast-Sync เป็น `WHERE ap.market_type IN ('forex', 'stock')`
  - กู้คืนสถานะไม้ `AMD` (Ticket #2305979154, กำไรลอยตัว +$2.21) กลับมาเป็น `SIGNAL_OPEN` พร้อม Trailing SL สมบูรณ์

---

### 3. 🧠 การอัปเกรด Phase 3: ขยายฟีเจอร์โมเดล (13 Features) & Tri-Ensemble Retraining
* **เพิ่ม 4 ฟีเจอร์ใหม่ในชุดข้อมูล ML**:
  1. `is_jpy`: Binary Flag (1.0 สำหรับ JPY Crosses, 0.0 สำหรับ Majors) ให้ Decision Tree แยกพฤติกรรม Momentum ชัดเจน
  2. `time_sin_hour`: Sinusoidal Cyclical Encoding ของชั่วโมง ($\sin(2\pi \times \text{Hour} / 24)$)
  3. `time_cos_hour`: Cosinusoidal Cyclical Encoding ของชั่วโมง ($\cos(2\pi \times \text{Hour} / 24)$)
  4. `spread_to_atr`: อัตราส่วนต้นทุน Spread ต่อความผันผวน ATR ป้องกันการเข้าเทรดช่วงต้นทุนเสียเปรียบ
* **ผลการ Retrain Tri-Ensemble v2** ([`scripts/retrain_from_trade_results.py`](file:///c:/xampp/htdocs/trade_bot/scripts/retrain_from_trade_results.py)):
  - ฝึกสอนบนชุดข้อมูล **44,959 ตัวอย่าง** (รวม 80 ไม้เทรดจริงที่ปิดแล้ว ถ่วงน้ำหนัก $5\times$)
  - **BUY Validation AUC**: **`80.25%`** *(เพิ่มจาก 78.7%)*
  - **SELL Validation AUC**: **`83.26%`** *(เพิ่มจาก 79.9%)*
  - ทดสอบ Inference จริง: ความมั่นใจทะลุ **91.84%** ในสัญญาณเทรนด์แรง
  - โมเดลบันทึกและรันจริงที่ `python/models/forex_m5_model.joblib`

---

### 4. 📊 ตารางเปรียบเทียบเชิงสถาปัตยกรรม (Architecture Comparison)

| มิติการเปรียบเทียบ | `ver.beta.0` (ก่อนแก้) | `ver.beta.0.1` (ปัจจุบัน) |
| :--- | :--- | :--- |
| **Forex Filtering** | EMA 9/21/50 + RSI9 (ไม่มี Gating) | **Dynamic Gating (ADX $\ge 18/22$ + CSM Spread $\ge 1.5/2.2$)** |
| **Forex Lot Sizing** | 0.01 Lot คงที่ทุกคู่เงิน | **Asymmetric Sizing (0.01 ปกติ / 0.02 High-Conviction)** |
| **Stock Exit Strategy** | ATR Trailing Stop แบบปิดเต็มไม้ | **Chandelier Multi-Stage Exit (50% Core TP1 + 50% Runner)** |
| **MT5 Fast-Sync** | ซิงค์เฉพาะตลาด Forex | **ซิงค์คู่ขนานทั้ง Forex และ US Stocks** |
| **ML Features** | 9 Features ทางเทคนิค | **13 Features (+ JPY Flag, Time-of-Day Cyclical, Spread/ATR)** |
| **Ensemble Model** | Tri-Ensemble v1 (AUC BUY 78.7% / SELL 79.9%) | **Tri-Ensemble v2 (AUC BUY 80.25% / SELL 83.26%)** |
| **Live Confidence Test** | สูงสุด ~75-80% | **พุ่งสูงถึง 91.84% บนสัญญาณ Trend Confluence** |
| **Stale Order Protection** | ไม่มี (ถือค้างข้ามคืน 7-8 ชม.) | **Time-Decay Hard Exit (120m) + Rollover Cutoff (03:45)** |

---

### 5. ⏰ การอัปเกรด Phase 4: Momentum Fade & Time-Decay Stale Order Guard
* **Forex Time-Decay Hard Exit (120 นาที)**:
  - หากออเดอร์ M5 ถือครองเกิน 120 นาที (2 ชั่วโมง) และราคาไม่สามารถขยายกำไรได้เกิน $+1.2 \times \text{ATR}$ ระบบจะส่งคำสั่งปิด Market Order บน MT5 ทันที (`exit_reason = 'CLOSED_TIME_STOP'`)
  - **ผลงานการรันจริงครั้งแรก**: ตรวจจับและปิดทำความสะอาดไม้ค้างเติ่ง 7 ไม้ (`NZDUSD`, `USDCAD`, `EURUSD`, `AUDUSD`, `USDCHF`, `GBPUSD`, `USDJPY`) ที่ติดค้างมา 7-8 ชม. ได้สำเร็จ ปลดล็อก Margin คืนสู่พอร์ตทันที
* **Forex Soft Stop Tightening (60 นาที)**:
  - หากถือครองเกิน 60 นาทีแล้วกราฟนิ่ง จะร่น Stop Loss จาก -14 pips เข้ามาบีบเหลือไม่เกิน 4 pips จากต้นทุน
* **Forex Rollover Cutoff (03:45 น. เวลาไทย)**:
  - ปิดออเดอร์ Scalp ที่ยังไม่ทำกำไรก่อนช่วงโบรกเกอร์ถ่าง Spread (04:00 - 06:00 น.)
* **US Stocks 3-Day Follow-Through Rule**:
  - หากหุ้น Breakout แล้วถือครบ 3 วันทำการแต่ราคาไม่ทำ New High และไม่แตะ $+1.2 \times \text{ATR}$ จะร่น Trailing Stop สู่ระดับ Break-Even ($+0.2 \times \text{ATR}$) ทันที

---
---

## 🏷️ เวอร์ชัน: `ver.beta.0.2 (multi-asset expansion term)`
**วันที่บันทึก**: 2026-09-09 (ช่วงบ่าย)  
**เป้าหมายหลัก**: ขยายขอบเขตการเทรดสู่ **ทองคำ (`GOLD` / `XAUUSD`)** และ **คริปโทเคอร์เรนซี (`BTCUSD`)** พร้อมสถาปัตยกรรมแยก Engine, Indicator, และ AI Model ตามพฤติกรรมเฉพาะสินทรัพย์ (Asset-Specific Architecture) รองรับการเทรดตลอด 24 ชั่วโมง 7 วัน (24/7)

### 1. 🟡 การติดตั้ง Gold Trading Engine ([`services/goldEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/goldEngine.js))
* **สินทรัพย์**: `GOLD` บน MetaTrader 5 XM Global Demo (Point = 0.01, Min Lot = 0.01)
* **การตรวจจับ Session (Session-Aware Dynamics)**:
  - **Asian Session (06:00 - 13:00 น. เวลาไทย)**: สะสมพลังและบันทึกระดับ Asian High / Asian Low
  - **London Open (14:00 - 18:00 น.)**: ตรวจจับแรงกระชาก Judas Swings
  - **London & NY Overlap (19:30 - 23:30 น.)**: Golden Window วอลุ่มและโมเมนตัมสูงสุด เหมาะแก่การเทรด
  - **Rollover Guard (04:00 - 05:00 น.)**: พักส่งคำสั่งใหม่ช่วงตลาดปิดบำรุงรักษาและถ่าง Spread
* **ชุดอินดิเคเตอร์เฉพาะทองคำ**:
  - **ATR 14 (M5)**: ตัวกำหนดระยะตัดขาดทุนแบบยืดหยุ่นตามความผันผวนจริง
  - **EMA 21, EMA 50, SMA 200**: ระดับ Confluence ร่วมกับเทรนด์ใหญ่ H1
  - **RSI 14 Dynamic Threshold**: ปรับระดับ Oversold/Overbought เป็น 25/75 ตามแรงเหวี่ยงทองคำ
* **ท่าเข้าเทรดที่เข้าเป้า (High-Probability Setups)**:
  1. **London/NY Liquidity Sweep**: ราคากระชากกิน High/Low ฝั่งเอเชียแล้วถูกปฏิเสธทิ้งไส้ยาว (Rejection Pinbar) ปิดกลับเข้ามาในกรอบเดิม พร้อม RSI Divergence
  2. **Dynamic Trend Pullback**: ราคาย่อตัวแตะ EMA 21 หรือ EMA 50 ในทิศทางเดียวกับเทรนด์ H1
* **การบริหารความเสี่ยงทองคำ**:
  - **ATR Dynamic Stop Loss**: กำหนดระยะขั้นต่ำ $3.50 (35-50 pips บนราคาทอง) เพื่อกันโดนไส้สะบัดกิน Stop Loss ก่อนกราฟวิ่งถูกทาง
  - **Dynamic Break-Even Lock**: ขยับ SL สู่จุดคุ้มทุน $+0.3 \times \text{ATR}$ ทันทีเมื่อกำไรแตะ $+1.5 \times \text{ATR}$
  - **Gold Time-Stop**: ปิดออเดอร์อัตโนมัติหากถือครองเกิน 4 ชั่วโมง (240 นาที) โดยไร้โมเมนตัม

---

### 2. 🪙 การติดตั้ง Crypto Trading Engine ([`services/cryptoEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/cryptoEngine.js))
* **สินทรัพย์**: คัดกรองเฉพาะเหรียญ High-Volume สภาพคล่องสูงอันดับต้นของโลก 3 เหรียญ (**`BTCUSD`**, **`ETHUSD`**, **`SOLUSD`**) บน MT5 XM Demo (**รันต่อเนื่อง 24 ชั่วโมง 7 วัน ไม่มีวันหยุด**)
* **Asset-Specific Min Lots & Decimals**:
  - `BTCUSD`: Min Lot = 0.01, Digits = 2, Min SL Buffer = $150.0
  - `ETHUSD`: Min Lot = 0.02, Digits = 2, Min SL Buffer = $10.0
  - `SOLUSD`: Min Lot = 0.05, Digits = 2, Min SL Buffer = $0.60
* **ระบบตรวจจับสุดสัปดาห์ (Weekend Guard)**:
  - ฟังก์ชัน `isWeekendCrypto()` ตรวจจับวันเสาร์-อาทิตย์
  - ปรับเกณฑ์ Volume Spike สูงขึ้นจาก $1.6\times$ เป็น **$2.0\times$** ของค่าเฉลี่ย 20 แท่ง เพื่อดักทางการสร้าง Fakeout ของวาฬช่วงสภาพคล่องสถาบันเบาบาง
* **ชุดอินดิเคเตอร์เฉพาะคริปโท**:
  - **Bollinger Bands (20, 2) + BandWidth Squeeze**: ตรวจจับช่วงกรอบราคาบีบตัวแคบผิดปกติ (ล่างสุด 25% ในรอบ 20 แท่ง) เพื่อรอจังหวะระเบิดเทรนด์ (Volatility Expansion)
  - **Volume Ratio (Current / Avg 20)**: กรองการเข้าซื้อของสถาบันและวาฬ
  - **ADX 14**: กรองความแข็งแกร่งของเทรนด์ ($\text{ADX} \ge 22$ เท่านั้นจึงจะเปิด Trend Following)
  - **EMA 20, EMA 50, EMA 200**: ทิศทางและการทำ Throwback
* **ท่าเข้าเทรดที่เข้าเป้า (High-Probability Setups)**:
  1. **Bollinger Band Squeeze Breakout**: เมื่อ BandWidth บีบแคบ แล้วแท่งเทียนปิดทะลุกรอบพร้อม Volume Spike หนุน
  2. **Bull/Bear Flag & EMA 20 Retest**: รอราคาเบรกแล้วย่อทดสอบ (Throwback) ด้วย Volume ที่แห้งลง แล้วเกิดแท่งเทียนยืนยันดีดตัวต่อ
* **การบริหารความเสี่ยงคริปโท**:
  - **Crypto Wide SL Buffer**: เผื่อระยะ SL ขั้นต่ำ $350 - $600 บนราคา Bitcoin ($3.0 \times \text{ATR}$)
  - **Dynamic Break-Even Lock**: เลื่อน SL สู่ Break-Even เมื่อราคาขยายกำไรถึง $+1.5 \times \text{ATR}$
  - **Crypto Time-Stop**: ปิดออเดอร์อัตโนมัติหากถือครองเกิน 6 ชั่วโมง (360 นาที) ไร้ทิศทาง

---

### 3. 🧠 การขยาย AI Model Predictor ([`services/modelPredictor.js`](file:///c:/xampp/htdocs/trade_bot/services/modelPredictor.js))
* **`predictGoldConfidence(features)`**:
  - ประเมินคะแนน Confluence ตามช่วงเวลา Session (ลอนดอน/นิวยอร์กได้น้ำหนักสูงสุด)
  - ตรวจจับ Liquidity Sweep Pinbar, DXY Inverse Momentum, และ EMA Pullback Confluence
* **`predictCryptoConfidence(features)`**:
  - ประเมินคะแนน Confluence ตามสถานะ Bollinger Squeeze, Institutional Volume Ratio, ADX Trend, และ Pattern Retest

---

### 4. 🔄 การอัปเกรด Multi-Asset Fast-Sync & Tracker ([`services/tradeResultTracker.js`](file:///c:/xampp/htdocs/trade_bot/services/tradeResultTracker.js))
* **ขยายการติดตาม 4 ตลาดพร้อมกัน**:
  - แก้ไขคิวรี Fast-Sync 2.5 วินาที เป็น:
    ```sql
    WHERE ap.market_type IN ('forex', 'stock', 'gold', 'crypto') AND ap.mt5_ticket IS NOT NULL
    ```
* **ปรับสูตรคำนวณ Pips / Points และ PnL ให้ตรงกับพฤติกรรมแต่ละสินทรัพย์**:
  - **Gold**: 1 Pip = $0.10 USD (10 Points), การเคลื่อนที่ $1.00 บน 0.01 Lot = กำไร $1.00 USD
  - **Crypto**: บันทึกการเปลี่ยนแปลงราคาดอลลาร์ของ BTCUSD คูณด้วย Lot Size จริง
  - จัดเก็บแท็ก `market_type: 'gold'` และ `market_type: 'crypto'` ลงตาราง `active_positions`, `signals`, และ `trade_results`

---

### 5. 🚀 การเชื่อมต่อระบบเซิร์ฟเวอร์ & Schedulers ([`server.js`](file:///c:/xampp/htdocs/trade_bot/server.js))
* **Quad-Engine Background Schedulers**:
  - `runScheduledScan()`: สแกนหุ้นสหรัฐ (จันทร์-ศุกร์ ช่วงเวลาตลาดสหรัฐเปิด)
  - `runScheduledForexScan()`: สแกนคู่เงิน Forex (จันทร์-ศุกร์ ตลอด 24 ชม.)
  - `runScheduledGoldScan()`: สแกนทองคำ (จันทร์-ศุกร์ ตลอด 24 ชม. มี Rollover Guard)
  - `runScheduledCryptoScan()`: สแกนคริปโท (**รันต่อเนื่อง 24 ชั่วโมง 7 วัน รวมเสาร์-อาทิตย์**)
* **Manual API Endpoints**:
  - `POST /api/gold/scan`: ทริกเกอร์รอบการสแกนทองคำแบบ Manual
  - `POST /api/crypto/scan`: ทริกเกอร์รอบการสแกนคริปโทแบบ Manual
* **US Stock Market Regular Hours Gating** ([`services/tradingEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/tradingEngine.js)):
  - เพิ่มฟังก์ชัน `checkUSStockMarket()` ตรวจสอบเวลาเปิด-ปิดตลาดหุ้นสหรัฐจริง (NYSE/NASDAQ 09:30 - 16:00 ET หรือ ~20:30 - 03:00 น. เวลาไทย)
  - เพิ่ม config `STOCK_MARKET_HOURS_ONLY=true` ใน `.env` ป้องกันการสแกนหรือยิง API ข้อมูลหุ้นช่วงที่ตลาดปิดทำการ ประหยัด Network/CPU และป้องกันราคาเก่าขยับหลอก
* **Telemetry Dashboard State**:
  - อัปเดต `GET /api/realtime-state` และ SSE Stream ให้แยกสถิติ Win Rate, ออเดอร์ที่เปิดอยู่, ประวัติการเทรดของทั้ง 4 ตลาด, และสถานะตลาดหุ้นสหรัฐ (`usMarketStatus`) แสดงป้ายตลาดเปิด/ปิดบนแท็บหุ้นแบบ Real-time

---

### 6. 📊 ตารางเปรียบเทียบสถาปัตยกรรมระบบทั้ง 4 ตลาด (Quad-Market Architecture Matrix)

| มิติการเปรียบเทียบ | หุ้นสหรัฐ (US Stocks) | คู่เงิน Forex (Majors) | ทองคำ (`GOLD`) | คริปโท (`BTCUSD`) |
| :--- | :--- | :--- | :--- | :--- |
| **ความถี่เวลาการเทรด** | 20:30 - 03:00 น. (จ-ศ) | 24 ชม. (จ-ศ) | 24 ชม. (จ-ศ, พัก 1 ชม.) | **24 ชั่วโมง 7 วัน (ไม่มีวันหยุด)** |
| **ปัจจัยขับเคลื่อนหลัก** | งบการเงิน, Guidance, SPY | ส่วนต่างดอกเบี้ย, CSM, DXY | **DXY, Real Yields, Safe-Haven** | **Halving, On-Chain, Liquidations** |
| **พฤติกรรมแท่งเทียน** | Trend + Gap เปิดตลาด | Mean-Reversion + Trend | **High Wicks, Liquidity Sweeps** | **Explosive Breakouts, Trend Run** |
| **Core Indicator 1** | Minervini Trend (EMA 50/150/200) | CSM Spread + ADX (18/22) | **London/NY Session + ATR** | **Bollinger Squeeze + Volume Ratio** |
| **Core Indicator 2** | VCP Contraction + FinBERT | RSI + Stochastic Dynamic | **Asian High/Low + EMA 21/50** | **ADX ($\ge 22$) + EMA 20 Retest** |
| **ขนาด Lot ปลอดภัย** | 0.01 - 0.05 Lot ตาม Risk | 0.01 - 0.02 Lot (Asymmetric) | **0.01 Lot คงที่** | **0.01 Lot คงที่** |
| **ระยะ Stop Loss (SL)** | $3.0 \times \text{ATR}$ หรือ Pivot | 14 - 24 Pips ปลอดภัย | **$3.5 \times \text{ATR}$ (min $3.50 buffer)** | **$3.0 \times \text{ATR}$ (min $350-$600 buffer)** |
| **กลยุทธ์การปิดออเดอร์** | Chandelier 50% TP1 + Runner | Breakeven + Time-Stop 120m | **Dynamic Breakeven + Time-Stop 4h** | **Dynamic Breakeven + Time-Stop 6h** |
| **ไฟล์ Engine ควบคุม** | `services/tradingEngine.js` | `services/forexEngine.js` | `services/goldEngine.js` | `services/cryptoEngine.js` |

---

## 🏷️ เวอร์ชัน: `ver.beta.2 (Smart Price Action, Dual-Mode Entry & Bar-Close Sync)`
**วันที่บันทึก**: 2026-09-09  
**เป้าหมายหลัก**: แก้ปัญหาจุดเข้าสุ่มเสี่ยง / การไล่ราคาที่ก้นเหว (Selling the Bottom จากกรณีศึกษา USDJPY), ยกระดับความแม่นยำด้วย Dual-Mode Execution (Pullback Limit vs Compression Breakout Stop), เสริมตัวกรอง Rejection Candlestick Veto, คำนวณ SL ป้องกันการย่อตัวทะลุ, และทำ Bar-Close Synchronization

### 1. 🏗️ โมดูลใหม่: Forex Price Action Engine ([`services/forexPriceAction.js`](file:///c:/xampp/htdocs/trade_bot/services/forexPriceAction.js))
* **Overextended Guard**:
  - คำนวณระยะห่างระหว่างราคาปิดและเส้น EMA 21:
    $$\text{Distance} = \frac{|\text{Close} - \text{EMA 21}|}{\text{ATR}(14)}$$
  - หาก $\text{Distance} > 1.8 \times \text{ATR}$ ร่วมกับ $\text{RSI} < 32$ (สำหรับ SELL) หรือ $\text{RSI} > 68$ (สำหรับ BUY) $\rightarrow$ สกัดการเปิด Market Order ทันที เปลี่ยนเป็นโหมด **PULLBACK LIMIT** เพื่อรอราคาย่อกลับสู่ค่าเฉลี่ย
* **Compression Breakout Gate**:
  - วิเคราะห์ช่วงสะสมพลัง 10–20 แท่งก่อนหน้า (Consolidation $\ge 10$ แท่ง พร้อมการทดสอบแนวรับ/ต้าน $\ge 2-3$ ครั้ง)
  - เมื่อแท่งเทียนปิดทะลุกรอบ และไส้เทียนต้านสั้น ($< 30\%$ ของ Range แท่งเทียน) $\rightarrow$ ปลดล็อกเข้าแบบ **BREAKOUT** ทันทีโดยไม่ต้องรอย่อ พร้อมวาง SL หลังขอบ Pattern
* **Rejection Candlestick Filter (Veto Guard)**:
  - สแกนแท่งเทียนล่าสุด 2 แท่ง หากพบแท่งที่มีไส้เทียนยาว $\ge 40\%$ ที่แนวรับ/ต้าน (เช่น Pinbar, Hammer, Shooting Star) $\rightarrow$ **Veto ยกเลิกสัญญาณทันที** ป้องกันการติดกับดัก Liquidity Sweep / Stop Hunt ของเจ้ามือ
* **Pullback Limit Level Calculation**:
  - คำนวณจุดตั้งรับคำสั่ง Limit Order ล่วงหน้าที่ระดับ EMA 21 หรือกึ่งกลางระหว่าง EMA 9 กับ EMA 21 อย่างแม่นยำ

### 2. ⚡ ยกระดับ MT5 Bridge สู่ Pending Orders ([`python/mt5_bridge.py`](file:///c:/xampp/htdocs/trade_bot/python/mt5_bridge.py) & [`services/mt5Broker.js`](file:///c:/xampp/htdocs/trade_bot/services/mt5Broker.js))
* **รองรับ Pending Orders ระดับสถาบัน**:
  - `place_pending_order()`: รองรับคำสั่ง `BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP` ผ่าน `TRADE_ACTION_PENDING`
  - `get_pending_orders()`: ดึงรายการออเดอร์ดักรอจาก `mt5.orders_get()`
  - `cancel_order()`: ยกเลิกคำสั่งรอดักผ่าน `TRADE_ACTION_REMOVE`
* **Broker-Native Order Expiration**:
  - กำหนด `type_time = mt5.ORDER_TIME_SPECIFIED` พร้อมเวลาหมดอายุ (ค่าเริ่มต้น 45 นาที หรือ 3 แท่ง M15) เซิร์ฟเวอร์ของโบรเกอร์ XM จะตัดออเดอร์ทิ้งอัตโนมัติหากราคาไม่มาแตะภายในเวลา ป้องกันออเดอร์ตกค้าง 100%

### 3. 🎯 การคำนวณ Structural Invalidation SL ([`services/forexExitEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/forexExitEngine.js))
* **โหมด Pullback**: วาง SL หลังจุด Swing High/Low ล่าสุด $+ 1.2 \times \text{ATR}$ เพื่อเผื่อการสะบัดไส้เทียน ทำให้การย่อตัวตามปกติไม่ชน SL
* **โหมด Breakout**: วาง SL หลังขอบกรอบพักตัวด้านตรงข้าม $+ 1.0 \times \text{ATR}$ ได้ Risk/Reward สูง $\ge 1:2 - 1:3$

### 4. ⏱️ Bar-Close Synchronization ([`server.js`](file:///c:/xampp/htdocs/trade_bot/server.js))
* ฟังก์ชัน `getMsUntilNextBarClose(intervalMinutes = 5, offsetSeconds = 2)`:
  - ซิงค์เวลาเริ่มสแกนให้ตรงกับ **วินาทีที่ 02 หลังจบแท่งเทียน M5** (เช่น 12:05:02, 12:10:02, 12:15:02)
  - แก้ปัญหา Time Lag และรับประกันว่าอินดิเคเตอร์ทุกตัวคำนวณจากแท่งเทียนที่ปิดสมบูรณ์แล้ว ไม่มีการ Repaint ระหว่างแท่ง

---

## 🏷️ เวอร์ชัน: `ver.beta.3 (Anti-Entanglement Filter, JPY Volatility Floor & Correlated Cluster Guard)`
**วันที่บันทึก**: 2026-09-09  
**เป้าหมายหลัก**: แก้ปัญหาการแพ้ 3 ออเดอร์ซ้อนของกลุ่ม JPY (`EURJPY BUY`, `GBPJPY BUY`, `USDJPY BUY` ช่วงเวลา 10:00 - 10:16 น.) จากกรณีศึกษาในฐานข้อมูล `trade_results` ที่ราคาพันกับ EMA 50 เพียง 0.5 - 2 pips ในตลาด Sideway ไร้เทรนด์ และยิงออเดอร์ทับซ้อนในทิศทางเดียวกันทำให้เกิดความเสี่ยงกระจุกตัว (Correlated Cluster Exposure)

### 1. 🛡️ ฟิลเตอร์ป้องกันเส้น EMA พันกัน (Anti-EMA Entanglement Filter)
* **ไฟล์**: [`services/forexFilter.js`](file:///c:/xampp/htdocs/trade_bot/services/forexFilter.js)
* **ปัญหาเดิม**:
  - โค้ดเดิมใช้ `currPrice >= ema50 && ema9 >= ema21` ซึ่งถ้าต่างกันเพียง 0.0001 (0.01 pip) หรือ 0.5 pip ระบบจะถือว่าเกิด Confluence ทันที
  - โมเดล ML เห็นราคาอยู่เหนือ EMA 50 จึงให้ความมั่นใจสูง $\ge 90\%$ ทั้งที่กราฟกำลังนอนราบในกรอบแคบ
* **การปรับปรุง**:
  - คำนวณอัตราส่วนการแยกตัวของเส้นเฉลี่ย:
    $$\text{emaSepRatio} = \frac{|\text{EMA 9} - \text{EMA 21}|}{\text{ATR}(14)}$$
    $$\text{ema50Distance} = \frac{|\text{Close} - \text{EMA 50}|}{\text{ATR}(14)}$$
  - ตรวจจับสภาวะพันกัน (Entangled State):
    $$\text{isEmaEntangled} = (\text{emaSepRatio} < 0.20) \land (\text{ema50Distance} < 0.30)$$
  - เงื่อนไขผ่าน Trend Confluence ใหม่:
    - ขาขึ้น (BUY): ต้อง `!isEmaEntangled` ร่วมกับ $(\text{Close} - \text{EMA 50}) \ge 0.25 \times \text{ATR}$ และ $\text{EMA 9} > \text{EMA 21}$ ชัดเจน
    - ขาลง (SELL): ต้อง `!isEmaEntangled` ร่วมกับ $(\text{EMA 50} - \text{Close}) \ge 0.25 \times \text{ATR}$ และ $\text{EMA 9} < \text{EMA 21}$ ชัดเจน
  - ตัดสัญญาณหลอกในตลาด Sideway แฟลตทิ้ง 100%

### 2. 📈 ยกระดับเกณฑ์ความผันผวนขั้นต่ำของคู่เงิน JPY (JPY ADX Floor $\ge 24$)
* **ไฟล์**: [`services/forexEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/forexEngine.js) & [`.env`](file:///c:/xampp/htdocs/trade_bot/.env)
* **ปัญหาเดิม**:
  - `FOREX_GATING_MIN_ADX_JPY` ถูกตั้งไว้ที่ 18 (ต่ำกว่าคู่สกุลหลักที่ 22)
  - ทั้ง `EURJPY` (ADX 20.59) และ `GBPJPY` (ADX 20.53) หลุดผ่านตัวกรองเข้ามาทั้งที่ความแข็งแกร่งของเทรนด์ต่ำมาก
* **การปรับปรุง**:
  - ปรับค่า Floor ขั้นต่ำสำหรับตระกูล JPY Crosses เป็น `FOREX_GATING_MIN_ADX_JPY=24`
  - หาก $\text{ADX} < 24$ ในคู่เงิน JPY จะถูกตัดทิ้งทันทีในฐานะสภาวะ Sideway ไร้เทรนด์

### 3. 🌐 เกราะป้องกันความเสี่ยงคู่เงินซ้ำซ้อน (Correlated Currency Exposure Guard)
* **ไฟล์**: [`services/forexEngine.js`](file:///c:/xampp/htdocs/trade_bot/services/forexEngine.js)
* **ปัญหาเดิม**:
  - ระบบตรวจสอบเฉพาะความซ้ำซ้อนระดับคู่เงินเดี่ยว (เช่น EURJPY ซ้ำกับ EURJPY)
  - เมื่อเปิด `EURJPY BUY` (ซึ่งเท่ากับ Short JPY) ระบบยังคงเปิด `GBPJPY BUY` (Short JPY อีก 1 ไม้ในอีก 7 วินาทีถัดมา) และเปิด `USDJPY BUY` (Short JPY อีก 1 ไม้ในอีก 15 นาทีถัดมา) กลายเป็นการเบิ้ล Short JPY ถึง 3 ไม้พร้อมกัน เมื่อเยนแข็งค่ากระทันหัน พอร์ตจึงโดนลากแพ้พร้อมกันทั้ง 3 ออเดอร์
* **การปรับปรุง**:
  - เพิ่มฟังก์ชัน `getCurrencyExposures(symbol, action)` เพื่อแตกคู่เงินออกเป็น Exposure รายสกุล (เช่น `BUY EURJPY` $\rightarrow$ Long EUR, Short JPY)
  - เพิ่มฟังก์ชัน `checkCorrelatedCurrencyGuard(existingPositions, newSymbol, newAction, maxLimit)`:
    - ตรวจสอบทั้งออเดอร์ที่ถือครองจริงบน MT5, ออเดอร์ Pending ที่รอเกี่ยว, และออเดอร์ที่เพิ่งถูกส่งในรอบสแกนเดียวกัน (`cycleNewPositions`)
    - จำกัดทิศทางการถือครองในสกุลเงินเดียวกันไม่เกิน `FOREX_MAX_CORRELATED_EXPOSURE=1`
    - หากมีออเดอร์ที่ Short JPY อยู่แล้ว ระบบจะข้ามการเปิดออเดอร์ใหม่ที่ Short JPY ในคู่อื่นทันที ป้องกันความเสี่ยงกระจุกตัวของพอร์ต (Portfolio Concentration Risk)



---

## 🏷️ เวอร์ชัน: `ver.beta.4 (Multi-Track Confluence, Supertrend, Stochastic, BB Squeeze & Data-Harvesting Unlock)`
**วันที่บันทึก**: 2026-09-09 (Asia/Bangkok)  
**เป้าหมายหลัก**: พัฒนาเครื่องยนต์วิเคราะห์ทางเทคนิคแบบผสมผสาน Multi-Track Confluence (Supertrend, Stochastic, Bollinger Squeeze) ตามมาตรฐานอินดิเคเตอร์ชั้นนำปี 2025, ปลดล็อกโควต้าและขีดจำกัดความมั่นใจตามคำสั่ง Data-First Directive ("ไม่เป็น เอา โคต้า จะเอา Data") เพื่อกวาดบันทึกข้อมูลการเทรดจริงเข้าฐานข้อมูล XAMPP MySQL (`trade_results`) สำหรับนำไป Retrain โมเดล Machine Learning

### 1. 🏗️ สถาปัตยกรรม Multi-Track Confluence Engine (`services/forexFilter.js`)
ระบบได้รับการยกระดับจาก First-Stage Filter แบบเส้นเดียว สู่ระบบ **3 Distinct Tactical Tracks** พร้อมระบบ Weighted Confluence Scoring (0–100 คะแนน):

#### แทร็กที่ 1: `TREND_RIDER` (การโหนเทรนด์ใหญ่)
* **Supertrend (Period 10, Multiplier 3.0)**:
  - คำนวณ Upper / Lower Band จาก $3.0 \times \text{ATR}(10)$
  - หากราคาปิดอยู่เหนือ Supertrend $\rightarrow$ Supertrend เป็น BUY สีเขียว (Bullish)
  - หากราคาปิดอยู่ใต้ Supertrend $\rightarrow$ Supertrend เป็น SELL สีแดง (Bearish)
* **EMA Alignment & Separation**: ตรวจสอบ EMA 9, EMA 21, EMA 50 โดยต้องไม่เกิดสภาวะพันกัน (Anti-Entanglement)
* **Momentum Confirmation**: RSI อยู่ในโซนโมเมนตัมชัดเจน ($> 52$ สำหรับ BUY, $< 48$ สำหรับ SELL) ร่วมกับ ADX $\ge 20$ (สำหรับ Major) หรือ $\ge 24$ (สำหรับ JPY)
* **คะแนนสะสม**: สูงสุด 100 คะแนน (เกณฑ์ขั้นต่ำ 70 คะแนน)

#### แทร็กที่ 2: `SQUEEZE_BREAKOUT` (การเข้าจังหวะระเบิดกรอบพลังงาน)
* **Bollinger Bands Squeeze & Expansion (Period 20, StdDev 2.0)**:
  - คำนวณ Bandwidth:
    $$\text{Bandwidth} = \frac{\text{Upper Band} - \text{Lower Band}}{\text{Middle Band (SMA 20)}}$$
  - ตรวจจับสภาวะบีบอัดตัวแคบสุดในรอบ 15 แท่ง (Squeeze Phase) ตามด้วยแท่งเทียนแทงทะลุกรอบบนหรือกรอบล่างอย่างรุนแรง
* **MACD Acceleration**: ค่า MACD Histogram ขยายตัวสอดคล้องกับทิศทางการระเบิด
* **Gating Bypass Privilege**:
  - หากระเบิดกรอบในโหมด `SQUEEZE_BREAKOUT` และได้ Confluence Score $\ge 60$ ระบบอนุญาตให้ **Bypass** ตัวกรอง $\text{ADX} < 20$ และ $|\text{CSM Spread}| < 0.8$ ได้ทันที เพราะในช่วงแท่งแรกของการ Breakout ค่า ADX ในอดีตมักจะยังต่ำอยู่ การรอ ADX สูงจะทำให้เสียเปรียบราคา

#### แทร็กที่ 3: `PULLBACK_DIP` (การดักย่อในเทรนด์แข็งแกร่ง)
* **Stochastic Oscillator (14, 3, 3)**:
  - คำนวณ $\%K$ และ $\%D$ จากราคา High/Low/Close ในรอบ 14 แท่งเทียน
  - ขาขึ้น: รอ $\%K$ ย่อตัวลงเขต Oversold ($< 30$) แล้วตัด $\%D$ ขึ้น ขณะที่ Supertrend ยังเป็นสีเขียว
  - ขาลง: รอ $\%K$ เด้งขึ้นเขต Overbought ($> 70$) แล้วตัด $\%D$ ลง ขณะที่ Supertrend ยังเป็นสีแดง

---

### 2. 🔓 การปลดล็อกโหมด Data-Harvesting Unlock Mode (`.env` & `services/forexEngine.js`)
เพื่อตอบสนองต่อคำสั่งของผู้ใช้ที่ต้องการสะสมตัวอย่างข้อมูล (Samples) ของการเทรดจริงบน MT5 ให้ได้ปริมาณสูงสุด:
* **ปลดล็อก Correlated Currency Guard**:
  - ตั้งค่า `FOREX_CORRELATED_GUARD_ENABLED=false` และ `FOREX_MAX_CORRELATED_EXPOSURE=10` ใน `.env` และ `.env.example`
  - อนุญาตให้ออกออเดอร์ในสกุลเงินเดียวกันข้ามคู่เงินได้ (เช่น Short USD พร้อมกันใน EURUSD SELL, AUDUSD SELL, USDCHF BUY) โดยไม่ถูก Correlation Guard สกัด
* **ปลดล็อก AI Confidence Threshold**:
  - ปรับค่า `FOREX_CONFIDENCE_THRESHOLD=0.01` (จากเดิม 0.58)
  - ระบบให้อำนาจการตัดสินใจแก่ Indicator Confluence Score ($\ge 70/100$) เป็นผู้จุดชนวนสัญญาณเทรด และส่งคำสั่งเข้าสู่ MT5 Broker พร้อมบันทึกฟีเจอร์ลง `trade_results`

---

### 3. 🛡️ การปรับปรุง Rejection Wick Filter (`services/forexPriceAction.js`)
* ปรับเกณฑ์ไส้เทียนสกัด `FOREX_REJECTION_WICK_THRESHOLD=50.0%` (ผ่อนปรนจาก 40.0% เดิม) ผ่าน Config `.env`
* เพิ่มการตรวจสอบความสมบูรณ์ของแท่งเทียน: หากเป็นแท่งปัจจุบันที่เพิ่งเปิดตัวได้ไม่นานและมี Range เล็กกว่า $0.4 \times \text{ATR}$ ระบบจะ **ข้ามการตรวจ Rejection Wick ในแท่งนั้น** เพื่อป้องกันการเกิด False Rejection Veto จากความผันผวนเพียงไม่กี่จุดของแท่งเทียนที่ยังสร้างไม่เสร็จ
* ส่งพารามิเตอร์ `atr` จาก `forexEngine.js` เข้าสู่ `checkRejectionCandle(bars, bias, atr)`

---

### 4. 🗄️ รูปแบบข้อมูลและการบันทึก (`trade_results` Verification)
ทุกออเดอร์ที่ถูกส่งและเปิดบน MT5 Broker จะได้รับการบันทึกข้อมูลอย่างเป็นระบบ:
* ฟีเจอร์ที่บันทึก: `ema9`, `ema21`, `ema50`, `rsi`, `adx`, `macd_hist`, `atr`, `filter_reasons`
* ข้อมูลราคาและตั๋ว: `mt5_ticket`, `symbol`, `market_type`, `action`, `lot_size`, `entry_time`, `entry_price`, `sl_price`, `tp_price`
* ข้อมูลผลลัพธ์เมื่อปิด: `exit_time`, `exit_price`, `exit_reason`, `pips`, `profit_loss`, `is_win`, `hold_duration_minutes`


---

## 🏷️ เวอร์ชัน: `ver.beta.4 (Multi-Track Confluence, Supertrend, Stochastic, BB Squeeze & Data-Harvesting Unlock)`
**วันที่บันทึก**: 2026-09-09 (Asia/Bangkok)  
**เป้าหมายหลัก**: พัฒนาเครื่องยนต์วิเคราะห์ทางเทคนิคแบบผสมผสาน Multi-Track Confluence (Supertrend, Stochastic, Bollinger Squeeze) ตามมาตรฐานอินดิเคเตอร์ชั้นนำปี 2025, ปลดล็อกโควต้าและขีดจำกัดความมั่นใจตามคำสั่ง Data-First Directive ("ไม่เป็น เอา โคต้า จะเอา Data") เพื่อกวาดบันทึกข้อมูลการเทรดจริงเข้าฐานข้อมูล XAMPP MySQL (`trade_results`) สำหรับนำไป Retrain โมเดล Machine Learning

### 1. 🏗️ สถาปัตยกรรม Multi-Track Confluence Engine (`services/forexFilter.js`)
ระบบได้รับการยกระดับจาก First-Stage Filter แบบเส้นเดียว สู่ระบบ **3 Distinct Tactical Tracks** พร้อมระบบ Weighted Confluence Scoring (0–100 คะแนน):

#### แทร็กที่ 1: `TREND_RIDER` (การโหนเทรนด์ใหญ่)
* **Supertrend (Period 10, Multiplier 3.0)**:
  - คำนวณ Upper / Lower Band จาก $3.0 \times \text{ATR}(10)$
  - หากราคาปิดอยู่เหนือ Supertrend $\rightarrow$ Supertrend เป็น BUY สีเขียว (Bullish)
  - หากราคาปิดอยู่ใต้ Supertrend $\rightarrow$ Supertrend เป็น SELL สีแดง (Bearish)
* **EMA Alignment & Separation**: ตรวจสอบ EMA 9, EMA 21, EMA 50 โดยต้องไม่เกิดสภาวะพันกัน (Anti-Entanglement)
* **Momentum Confirmation**: RSI อยู่ในโซนโมเมนตัมชัดเจน ($> 52$ สำหรับ BUY, $< 48$ สำหรับ SELL) ร่วมกับ ADX $\ge 20$ (สำหรับ Major) หรือ $\ge 24$ (สำหรับ JPY)
* **คะแนนสะสม**: สูงสุด 100 คะแนน (เกณฑ์ขั้นต่ำ 70 คะแนน)

#### แทร็กที่ 2: `SQUEEZE_BREAKOUT` (การเข้าจังหวะระเบิดกรอบพลังงาน)
* **Bollinger Bands Squeeze & Expansion (Period 20, StdDev 2.0)**:
  - คำนวณ Bandwidth:
    $$\text{Bandwidth} = \frac{\text{Upper Band} - \text{Lower Band}}{\text{Middle Band (SMA 20)}}$$
  - ตรวจจับสภาวะบีบอัดตัวแคบสุดในรอบ 15 แท่ง (Squeeze Phase) ตามด้วยแท่งเทียนแทงทะลุกรอบบนหรือกรอบล่างอย่างรุนแรง
* **MACD Acceleration**: ค่า MACD Histogram ขยายตัวสอดคล้องกับทิศทางการระเบิด
* **Gating Bypass Privilege**:
  - หากระเบิดกรอบในโหมด `SQUEEZE_BREAKOUT` และได้ Confluence Score $\ge 60$ ระบบอนุญาตให้ **Bypass** ตัวกรอง $\text{ADX} < 20$ และ $|\text{CSM Spread}| < 0.8$ ได้ทันที เพราะในช่วงแท่งแรกของการ Breakout ค่า ADX ในอดีตมักจะยังต่ำอยู่ การรอ ADX สูงจะทำให้เสียเปรียบราคา

#### แทร็กที่ 3: `PULLBACK_DIP` (การดักย่อในเทรนด์แข็งแกร่ง)
* **Stochastic Oscillator (14, 3, 3)**:
  - คำนวณ $\%K$ และ $\%D$ จากราคา High/Low/Close ในรอบ 14 แท่งเทียน
  - ขาขึ้น: รอ $\%K$ ย่อตัวลงเขต Oversold ($< 30$) แล้วตัด $\%D$ ขึ้น ขณะที่ Supertrend ยังเป็นสีเขียว
  - ขาลง: รอ $\%K$ เด้งขึ้นเขต Overbought ($> 70$) แล้วตัด $\%D$ ลง ขณะที่ Supertrend ยังเป็นสีแดง

---

### 2. 🔓 การปลดล็อกโหมด Data-Harvesting Unlock Mode (`.env` & `services/forexEngine.js`)
เพื่อตอบสนองต่อคำสั่งของผู้ใช้ที่ต้องการสะสมตัวอย่างข้อมูล (Samples) ของการเทรดจริงบน MT5 ให้ได้ปริมาณสูงสุด:
* **ปลดล็อก Correlated Currency Guard**:
  - ตั้งค่า `FOREX_CORRELATED_GUARD_ENABLED=false` และ `FOREX_MAX_CORRELATED_EXPOSURE=10` ใน `.env` และ `.env.example`
  - อนุญาตให้ออกออเดอร์ในสกุลเงินเดียวกันข้ามคู่เงินได้ (เช่น Short USD พร้อมกันใน EURUSD SELL, AUDUSD SELL, USDCHF BUY) โดยไม่ถูก Correlation Guard สกัด
* **ปลดล็อก AI Confidence Threshold**:
  - ปรับค่า `FOREX_CONFIDENCE_THRESHOLD=0.01` (จากเดิม 0.58)
  - ระบบให้อำนาจการตัดสินใจแก่ Indicator Confluence Score ($\ge 70/100$) เป็นผู้จุดชนวนสัญญาณเทรด และส่งคำสั่งเข้าสู่ MT5 Broker พร้อมบันทึกฟีเจอร์ลง `trade_results`

---

### 3. 🛡️ การปรับปรุง Rejection Wick Filter (`services/forexPriceAction.js`)
* ปรับเกณฑ์ไส้เทียนสกัด `FOREX_REJECTION_WICK_THRESHOLD=50.0%` (ผ่อนปรนจาก 40.0% เดิม) ผ่าน Config `.env`
* เพิ่มการตรวจสอบความสมบูรณ์ของแท่งเทียน: หากเป็นแท่งปัจจุบันที่เพิ่งเปิดตัวได้ไม่นานและมี Range เล็กกว่า $0.4 \times \text{ATR}$ ระบบจะ **ข้ามการตรวจ Rejection Wick ในแท่งนั้น** เพื่อป้องกันการเกิด False Rejection Veto จากความผันผวนเพียงไม่กี่จุดของแท่งเทียนที่ยังสร้างไม่เสร็จ
* ส่งพารามิเตอร์ `atr` จาก `forexEngine.js` เข้าสู่ `checkRejectionCandle(bars, bias, atr)`

---

### 4. 🗄️ รูปแบบข้อมูลและการบันทึก (`trade_results` Verification)
ทุกออเดอร์ที่ถูกส่งและเปิดบน MT5 Broker จะได้รับการบันทึกข้อมูลอย่างเป็นระบบ:
* ฟีเจอร์ที่บันทึก: `ema9`, `ema21`, `ema50`, `rsi`, `adx`, `macd_hist`, `atr`, `filter_reasons`
* ข้อมูลราคาและตั๋ว: `mt5_ticket`, `symbol`, `market_type`, `action`, `lot_size`, `entry_time`, `entry_price`, `sl_price`, `tp_price`
* ข้อมูลผลลัพธ์เมื่อปิด: `exit_time`, `exit_price`, `exit_reason`, `pips`, `profit_loss`, `is_win`, `hold_duration_minutes`

---

### 5. 📊 สรุปผลลัพธ์ประจำรุ่น `ver.beta.4`
* **Win Rate รายวัน**: เพิ่มขึ้นเป็น **51.02%** (จาก 25.56% ใน ver.beta.0)
* **ผลตอบแทนรวม**: **+112.6 Pips** / **+$1.17 Net PnL**
* **คู่เงินที่ทำผลงานสูงสุด**:
  - `USDJPY=X`: Win Rate 77.78% (+72.0 pips)
  - `GBPJPY=X`: Win Rate 62.50% (+66.5 pips)
  - `EURJPY=X`: Win Rate 62.50% (+53.3 pips)

---

## 🏷️ เวอร์ชัน: `ver.beta.5 (Unified Tri-Hybrid Architecture & Dual-Tier Data Harvesting)`
**วันที่และเวลาบันทึก**: 2026-09-10T09:15:00+07:00 (Asia/Bangkok)  
**เป้าหมายหลัก**: รวมข้อดีของทั้ง 3 Patch (`ver.beta.0.1`, `ver.beta.3`, `ver.beta.4`) เข้าด้วยกันเป็นสถาปัตยกรรมหนึ่งเดียว เพื่อแก้ไขความขัดแย้งระหว่างการ "เร่งเก็บข้อมูลตัวอย่างสำหรับ Machine Learning (Data-First)" และการ "รักษาความแม่นยำ (Win Rate $\ge 50-60\%$) และผลกำไรของพอร์ตเทรดจริงบน MT5" ผ่านระบบ **Dual-Tier Execution (Live MT5 vs Shadow Paper Harvesting)** พร้อมทั้งปรับแก้จุดอ่อนฝั่ง BUY ด้วย **Macro DXY Directional Bias Calibration** และกระชับการล็อกกำไรด้วย **Dynamic Break-Even ที่ $1.0 \times \text{ATR}$**

### 1. 🥇 Tier 1: Live MT5 Execution & Gating
* ปรับเกณฑ์ AI Confidence สำหรับยิงคำสั่งจริงเป็น $\ge 0.52$
* เปิด Correlated Exposure Guard (`FOREX_CORRELATED_GUARD_ENABLED=true`, `FOREX_MAX_CORRELATED_EXPOSURE=2`) ป้องกันการเบิ้ลสกุลเงินเดียวกันเกิน 2 คู่
* Dynamic Symbol Gating: ADX $\ge 20/24$, CSM Spread $\ge 1.0$ (Bypass สำหรับ Squeeze Breakout คะแนน $\ge 60$)
* Anti-EMA Entanglement: สกัดจุดเข้าที่ราคาพันกับ EMA 50 ทิ้ง 100%

### 2. 🥈 Tier 2: Shadow Paper Harvesting
* เมื่อ `FOREX_SHADOW_HARVESTING=true` สัญญาณที่ได้คะแนน Confluence $\ge 55/100$ แต่มีค่า AI Confidence ระดับรอง หรือติด Correlated/Session Guard จะได้รับการบันทึกลง `trade_results` เป็นสถานะ `forex_shadow` ทันที
* ติดตามผลการชน TP/SL เสมือนในทุกแท่ง M5 ถัดไป สะสมชุดข้อมูลเทรน ML ทั้งด้านบวกและลบโดยไม่เสี่ยงเสียเงินบน MT5

### 3. 🌐 Macro DXY Directional Bias Calibration
* ฝั่งที่ตามเทรนด์ใหญ่ DXY ได้รับเกณฑ์ Confluence Score ขั้นต่ำ $\ge 55/100$
* ฝั่งที่สวนเทรนด์ใหญ่ DXY (เช่น BUY Majors ในช่วง Dollar แข็ง) บังคับใช้เกณฑ์เข้มงวด $\ge 70/100$ และต้องผ่านเงื่อนไข Stochastic Oversold ($\%K \le 40$) หรือ Squeeze Breakout เท่านั้น

### 4. 🛡️ Fast Break-Even Lock at $1.0 \times \text{ATR}$
* เมื่อกำไรขยายตัวแตะ $+1.0 \times \text{ATR}$ ขยับ SL สู่จุดคุ้มทุน $+1.5$ pips และยิงคำสั่ง modifyStopLoss ซิงค์ไปยัง MT5 ทันที

---

## 🏷️ เวอร์ชัน: `ver.beta.5.1 (Model Versioning Registry & Smart HTF Pullback Limit Mode)`
**วันที่และเวลาบันทึก**: 2026-09-10T10:00:00+07:00 (Asia/Bangkok)  
**เป้าหมายหลัก**: ติดตั้งระบบควบคุมเวอร์ชันโมเดล AI (MLOps Model Registry), ตัวชี้วัดมาตรฐานสากล 10 Metrics (Scikit-Learn Standards), ปรับโหมดเข้าออเดอร์สวนเทรนด์ใหญ่เป็น Smart Adaptive Pullback Limit เพื่อแก้ปัญหาซื้อดอยปลายไส้เทียนโดยไม่ทำให้บอทกลัวที่จะเข้าเทรด, และแก้ไขบั๊กเวลาการถือครองออเดอร์ (+420 นาที)

### 1. 🏷️ AI Model Versioning Registry (`python/models/model_registry.json`)
* **โครงสร้างการจัดการ Version**:
  - ติดตามประวัติโมเดล (`v1.0.0`, `v1.1.0`, ...) พร้อมจัดเก็บสำเนาถาวรในโฟลเดอร์ `python/models/versions/`
  - บันทึกข้อมูลกำกับอย่างละเอียดทุกมิติ:
    - **Dataset Breakdown**: Total Samples, Historical Samples, Live Trade Samples, Positive Class Rates
    - **Model Hyperparameters**: แยกย่อยตาม Constituent Models (LightGBM, XGBoost, CatBoost, Random Forest)
    - **Feature Inputs**: รายชื่อฟีเจอร์ทั้ง 13 ตัวแปร
    - **Performance Metrics**: 10 ตัวชี้วัดมาตรฐานสากล
* **คำสั่งบริหารจัดการ Model Registry ผ่าน Terminal**:
  - `npm run model:list`: แสดงรายการเวอร์ชันโมเดลทั้งหมด สถานะการใช้งาน และค่า ROC-AUC
  - `npm run model:compare`: เปรียบเทียบประสิทธิภาพและการพัฒนาของโมเดลแต่ละเวอร์ชันแบบ Side-by-Side
  - `python scripts/model_registry.py --show <version>`: ดูพารามิเตอร์และสเปกฉบับเต็มของเวอร์ชันนั้นๆ
  - `python scripts/model_registry.py --activate <version>`: สลับเวอร์ชันใช้งานหรือ Rollback กลับไปเวอร์ชันเดิมได้ทันที
* **Auto-Versioning Retrain**:
  - เมื่อสั่ง `npm run model:retrain` ระบบจะคำนวณและปรับ Version ขึ้นอัตโนมัติ (เช่น `v1.2.0`) พร้อมคำนวณ 10 Metrics และบันทึกลง Registry ทันที

---

### 2. 🌐 10 International Standard ML Classification Metrics (`scripts/evaluate_model.py`)
* **ตัวชี้วัดที่รองรับตามมาตรฐาน Scikit-Learn Model Evaluation & DataRockie**:
  1. **Accuracy**: ความถูกต้องโดยรวมทั้งการเข้าและไม่เข้าเทรด
  2. **Precision**: อัตราความแม่นยำของไม้ที่เปิดจริง (Win Rate)
  3. **Recall / Sensitivity**: ความสามารถในการจับรอบวิ่งทำกำไรได้ครบถ้วน
  4. **Specificity**: ความสามารถในการอยู่เฉยๆ กรองสัญญาณหลอกและช่วงไซด์เวย์
  5. **F1-Score**: Harmonic Mean สมดุลระหว่าง Precision และ Recall
  6. **F0.5-Score**: ค่า F-Score ที่ถ่วงน้ำหนัก Precision ให้สำคัญกว่า Recall 2 เท่า (เน้นรักษาเงินต้น)
  7. **ROC-AUC**: ความสามารถในการแยกแยะ Class สัญญาณ
  8. **PR-AUC / Average Precision**: ดัชนีชี้วัดสากลสำหรับ Imbalanced Dataset
  9. **Log Loss (Cross-Entropy)**: ความแม่นยำเชิงความน่าจะเป็น
  10. **Brier Score & MCC**: Mean Squared Error ของความน่าจะเป็น และ Matthews Correlation Coefficient
* **Confusion Matrix & Live Database Verification**:
  - แสดงผล True Positive, False Positive, True Negative, False Negative
  - ดึงข้อมูลไม้จริงจากตาราง `trade_results` มาแสดง Realized Win Rate, Profit Factor, และ Expectancy Pips
  - สั่งทดสอบได้ตลอดเวลาด้วยคำสั่ง: `npm run test:model`

---

### 3. 🎯 Smart Adaptive HTF Pullback Limit Mode (`services/forexEngine.js`)
* **แก้ปัญหาซื้อปลายไส้เทียน / สวนทาง H1 Trend**:
  - วิเคราะห์ความชันของเทรนด์ใหญ่ H1 ผ่าน `h1TrendSlope` (คำนวณจากราคาเทียบย้อนหลัง 12 แท่ง M5 = 1 ชั่วโมง)
  - **ถ้าสัญญาณเทรดไปทางเดียวกับ H1 Trend**: ส่งคำสั่ง **`Market Order`** ทันที เพื่อให้บอทไม่ตกรถ
  - **ถ้าสัญญาณเทรดสวนทาง H1 Trend**: บอท **ไม่แบนสัญญาณ** (ป้องกันบอทกลัว) แต่จะเปลี่ยนโหมดเป็น **`BUY_LIMIT` / `SELL_LIMIT` (PULLBACK MODE)**
  - ดักรอรับราคาที่ย่อตัวลงมาที่แนวรับ M5 EMA 9 / EMA 21 (ย่อลงประมาณ $0.35 \times \text{ATR}$ หรือ 2-4 pips) พร้อมตั้งเวลายกเลิกอัตโนมัติ (Expiration) 45 นาที
  - **ผลลัพธ์**: ได้ต้นทุนที่ได้เปรียบสูงมาก สัดส่วน Risk-Reward ดีขึ้น และหากตลาดไม่ย่อแต่ทุบลงต่อ คำสั่ง Limit Order จะไม่ถูก Match ทำให้ไม่เสียเงินทุน

---

### 4. ⏱️ Duration Timezone Calculation Fix (`services/tradeResultTracker.js`)
* แก้ไขฟังก์ชันการบันทึกเวลาเข้า-ออกออเดอร์ใน MySQL ให้ใช้เวลาท้องถิ่น `Asia/Bangkok` (`getBangkokDateTimeStr`) แทน ISO UTC String เพื่อให้ตรงกับ `timezone: '+07:00'` ของฐานข้อมูล
* ปรับสูตรคำนวณระยะเวลาการถือครอง (`hold_duration_minutes`) โดยใช้ Normalized Timestamp Diff ขจัดความคลาดเคลื่อนของเวลา 420 นาที (7 ชั่วโมง) ในอดีตอย่างถาวร

---

## 🏷️ เวอร์ชัน: `ver.beta.5.2 (Crypto Decoupling & Autonomous Trading Engine)`
**วันที่บันทึก**: 2026-09-10  
**เป้าหมายหลัก**: แยก Dataset และ AI Model ของตลาด Crypto ออกจาก Forex อย่างเด็ดขาด 100% พร้อมปลดล็อก Crypto Engine และเชื่อมต่อ Binance Data Pipeline

### 1. 🪙 Strict Decoupling: แยก Dataset & AI Model ของ Crypto ออกจาก Forex 100%
* **Binance Data Pipeline (`scripts/fetch_crypto_binance_data.py`)**:
  - สคริปต์ดึงข้อมูลแท่งเทียน M5 คุณภาพสูงจาก Binance Public REST API โดยตรง (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`) ครั้งละ 3,000 แท่งต่อเหรียญ รวม 8,922 แถว
  - สกัด 10 Quant Indicators (Returns, RSI, ATR%, ADX, EMA Spreads, MACD Hist, Volume Ratio, BB Width)
  - กำหนดเป้าหมายด้วย Triple Barrier Method ($1.2 \times \text{ATR}$ ภายใน 5 แท่ง)
  - จัดเก็บแยกเป็น `data/dataset_crypto_m5.csv` ไม่ปะปนกับ Forex เด็ดขาด
* **Dedicated Crypto Tri-Ensemble Model (`scripts/train_crypto_m5_model.py`)**:
  - เทรนโมเดล Tri-Ensemble สำหรับ Crypto โดยเฉพาะ: LightGBM (40%) + XGBoost (35%) + Random Forest (25%)
  - ได้คะแนนสากล: **ROC-AUC BUY = 79.8%**, **ROC-AUC SELL = 77.5%**, Accuracy $\approx 88-90\%$
  - จัดเก็บเป็น `python/models/crypto_m5_model.joblib` และสำเนาเวอร์ชัน `crypto_m5_model_v1.0.0.joblib`
* **Crypto Model Registry (`python/models/crypto_model_registry.json`)**:
  - บัญชีคุมเวอร์ชันโมเดล Crypto แยกอิสระจาก Forex
  - ตรวจสอบได้ผ่านคำสั่ง: `npm run crypto:model:list`

### 2. 🔓 ปลดล็อก 3 บั๊กหลักใน Crypto Engine (`services/cryptoEngine.js`)
* **แก้ปัญหา Open-Bar Volume Trap**: เปลี่ยนจากการวัด Volume ในแท่งปัจจุบัน (`bars[n-1]`) ที่ยังไม่ปิดแท่ง (ซึ่งมักจะได้แค่ 0.15 - 0.35x) มาคิดจากแท่งที่ปิดสมบูรณ์แล้ว (`bars[n-2]`)
* **แก้ปัญหา Bollinger Squeeze Paradox**: ตรวจสอบการบีบตัวของ BandWidth ย้อนหลัง 1-3 แท่งก่อนที่จะระเบิดตัว (Prior Squeeze Expansion)
* **เพิ่มระบบ 3 Confluence Tracks**:
  1. `Track 1: SQUEEZE_EXPANSION`: Bollinger Band บีบตัวแคบแล้วระเบิดออกพร้อม Volume
  2. `Track 2: TREND_RIDER`: โมเมนตัมตามเทรนด์ EMA 20/50 + ADX $\ge 18$
  3. `Track 3: PULLBACK_DIP`: ย่อตัวทดสอบแนวรับ/แนวต้าน EMA 20 ในทิศทางเทรนด์ใหญ่
* **ปรับ SL/TP Buffers ให้สอดคล้องกับ Spread ของ MT5 Crypto**:
  - ขยาย `minSlBuffer` สำหรับ SOLUSD เป็น $1.50 (Spread XM อยู่ที่ ~$0.66) ป้องกันปัญหา Broker Reject `10016 (Invalid stops)`
* **เชื่อมโยง Python AI Bridge (`python/predict_crypto_bridge.py`)**:
  - ระบบประเมินความมั่นใจ Relative Confidence ระดับ Sub-millisecond ผ่าน Tri-Ensemble Model จริง พร้อม Quantitative Fallback ในตัว

### 3. 🔓 ปลดล็อกตัวกรอง DXY Stochastic Veto & CSM Gating (`ver.beta.5.3`)
* **สาเหตุปัญหา**: ดัชนี DXY จาก Yahoo Finance ส่งมาเป็นแท่งวัน (D1) ซึ่งติดลบอยู่ใต้เส้น EMA50 ต่อเนื่องหลายสัปดาห์ ส่งผลให้เกิดการ Veto สัญญาณเทรด M5 ของคู่เงินที่มี USD ทั้ง 7 คู่ ให้เหลือ Score 0/100 ตลอดเวลา
* **การแก้ไขใน `services/forexFilter.js`**:
  - ถอดเงื่อนไข Stochastic Hard Veto (`stochK < 60` ในขาลง และ `stochK > 40` ในขาขึ้น) ออก
  - คงเกณฑ์คัดกรองความเข้มงวดของ Confluence Score ขั้นต่ำที่ 70 คะแนน (จากปกติ 55) สำหรับสัญญาณที่สวนเทรนด์ DXY
  - ทำให้สัญญาณ Trend Rider ที่มีคะแนน Confluence สูง (77-93/100) สามารถส่งเข้าสู่กระบวนการตัดสินใจของ AI ได้ตามปกติ
* **การแก้ไขใน `services/forexEngine.js`**:
  - ปรับเกณฑ์ CSM Gating ให้สัญญาณที่มี AI Confidence $\ge 70\%$ ผ่านการเปิดออเดอร์ได้โดยไม่ต้องติดคอขวด CSM Spread 0.3
* **ผลลัพธ์การทดสอบ**:
  - ส่งคำสั่งและ Filled ออเดอร์บน MT5 สำเร็จทันที: **`EURUSD SELL` (Ticket #2309023320 @ 1.15998)**
  - ระบบ Correlation Guard สกัดการเปิดไม้ `GBPUSD` ที่ทิศทาง Long USD ซ้ำซ้อนได้อย่างถูกต้องตามแผนบริหารความเสี่ยง

---

## 🏷️ เวอร์ชัน: `ver.beta.5.4 (Forex M5 Model v1.2.0 Retrain)`
**วันที่และเวลาบันทึก**: 2026-09-11T11:27:02+07:00 (Asia/Bangkok)

### 1. 🤖 Forex M5 Model `v1.2.0` — Active
* รัน `npm run model:retrain` สำเร็จและ Registry ตั้ง `v1.2.0` เป็นโมเดลใช้งานจริง
* Artifact ปัจจุบัน: `python/models/forex_m5_model.joblib`
* Archive สำหรับ rollback: `python/models/versions/forex_m5_model_v1.2.0.joblib`
* สถาปัตยกรรมยังเป็น Tri-Ensemble 13 features:
  - LightGBM 35%, XGBoost 25%, CatBoost 25%, Random Forest 15%
  - Dataset 45,029 แถว = historical 44,559 แถว + realized live trades 94 ไม้ที่ถ่วงน้ำหนัก 5×

### 2. 📈 Registry Validation: เปรียบเทียบ `v1.1.0` กับ `v1.2.0`

| Metric | `v1.1.0` | `v1.2.0` | การเปลี่ยนแปลง |
| :--- | ---: | ---: | ---: |
| ROC-AUC BUY | 79.71% | **81.14%** | +1.43 จุด |
| ROC-AUC SELL | 79.75% | **82.36%** | +2.61 จุด |
| Precision BUY | 14.20% | **21.58%** | +7.38 จุด |
| Precision SELL | 25.19% | **34.48%** | +9.29 จุด |
| F0.5 BUY | 0.1652 | **0.1987** | +0.0335 |
| F0.5 SELL | 0.2905 | **0.3598** | +0.0693 |

### 3. ⚠️ แยกผล Validation ออกจากผลเทรดจริง
* คำสั่ง `npm run test:model` ประเมินโมเดล active บนชุด historical holdout 8,912 แท่ง ได้ ROC-AUC BUY/SELL 79.92%, PR-AUC 13.64% / 26.37% และ MCC 0.1907 / 0.3377
* Live verification ณ รอบประเมินมี 96 ไม้ที่ปิดแล้ว: Win Rate **40.62%**, Profit Factor **0.47**, Expectancy **-4.62 pips/ไม้**
* ดังนั้น `v1.2.0` มี validation ranking metrics ที่ดีขึ้น แต่ยัง **ไม่** เป็นหลักฐานว่า execution strategy ทำกำไรจริงแล้ว; ต้องเก็บผล live/shadow ต่อเนื่องและแยก provenance ของข้อมูลให้ครบก่อน retrain รอบถัดไป

---

## 🏷️ เวอร์ชัน: `ver.beta.5.5 (Champion–Challenger Shadow Pairing)`
**วันที่**: 2026-09-11 (Asia/Bangkok)

### 1. 🧪 เพิ่มโมเดล Challenger แบบไม่เพิ่มความเสี่ยง MT5
* Champion เดิม `forex_champion / v1.2.0` ยังเป็นตัวเดียวที่มีสิทธิ์ส่ง Live/Pending Order
* เพิ่ม Challenger `forex_challenger / challenger-v1.0.0` เป็น Dual GradientBoosting (BUY + SELL) จาก dataset เดิม 44,559 แถว
* Validation ของ Challenger: BUY AUC **0.8231**, SELL AUC **0.8325**; ไม่ได้ใช้ผลนี้เป็นเหตุผลให้ promote ทันที
* เมื่อ Challenger ผ่าน threshold `0.52` และ Confluence `>=55` จะสร้าง `forex_shadow` แยกแถว โดยไม่เรียก MT5 และใช้ lot จำลอง `0.01`

### 2. 🗃️ Provenance และการจับคู่ผลลัพธ์
* เพิ่ม `pair_id`, `model_source`, `model_version`, `strategy_version`, `config_hash`, `decision_mode`, `prediction_meta` ลง `trade_results`; Champion/Challenger ที่เกิดจาก symbol + bar + bias เดียวกันจะมี `pair_id` เดียวกัน
* Champion live ถูกบันทึกเป็น `decision_mode=LIVE`; Champion shadow เป็น `CHAMPION_SHADOW`; Challenger เป็น `CHALLENGER_SHADOW`
* Shadow Exit ใช้ `tradeResultId` โดยตรง ป้องกันการปิดผลลัพธ์ของอีกโมเดลเมื่อทั้งสองโมเดลมี symbol/action เดียวกัน
* SQL สำหรับติดตั้งซ้ำอยู่ที่ `scripts/update_trade_results_provenance.sql`; application migration ใน `config/database.js` ทำงานแบบตรวจซ้ำก่อน ALTER

### 3. ▶️ คำสั่งใช้งาน
```powershell
npm run model:train:challenger
node --input-type=module -e 'import {initDatabase} from "./config/database.js"; await initDatabase(); process.exit(0);'
```
หลัง restart Node service ระบบจะเริ่มเก็บ Champion–Challenger shadow pairs อัตโนมัติ โดยยังไม่เปิดเงินจริงเพิ่ม
