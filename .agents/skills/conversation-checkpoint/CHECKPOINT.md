# 📍 Conversation Checkpoint: AI Multi-Asset Trading System (Quad-Market Architecture)

**บันทึกเมื่อ**: 2026-09-09T10:45:00+07:00  
**สถานะปัจจุบัน**: 🟢 ออนไลน์สมบูรณ์ (ติดตั้งครบ 4 ตลาด: US Stocks, Forex M5 Scalping, Gold M5, Crypto 24/7 พร้อมแยก Engine และ Indicator เฉพาะรายสินทรัพย์)

---

### 1. 🎯 เป้าหมายหลัก (Core Goals)
- พัฒนาระบบ AI Autonomous Trading System ที่เทรดอัตโนมัติ 4 ตลาดคู่ขนาน: **หุ้นสหรัฐ (US Stocks Swing)**, **คู่เงิน Forex (M5 Scalping)**, **ทองคำ (`GOLD` / `XAUUSD`)**, และ **คริปโทเคอร์เรนซี (`BTCUSD` 24/7)** ผ่าน **MetaTrader 5 (MT5)** บัญชี XM Global Demo (`169315887`)
- แยกสถาปัตยกรรม Engine, Indicator, และ AI Model ตามพฤติกรรมเฉพาะสินทรัพย์ (Asset-Specific Architecture) เพื่อขจัดปัญหาความขัดแย้งของสัญญาณและเพิ่มโอกาสในการได้ออเดอร์ตลอดทั้งวันและวันหยุดสุดสัปดาห์
- บันทึกฟีเจอร์และผลลัพธ์ลงตาราง `trade_results` ใน XAMPP MySQL เพื่อใช้สำหรับ Continuous Active Learning (Auto-Retraining)
- ติดตามผลตอบแทนแบบ Real-time บน Web Dashboard ด้วย Server-Sent Events (SSE) และ One-Click Retraining

---

### 2. 📌 ข้อกำหนดสำคัญ (Key Requirements)
- **Runtime**: Node.js (ES Module) บน Windows โดยไม่ใช้ Docker | พอร์ตเว็บ 3000
- **ฐานข้อมูล**: XAMPP MySQL (Port 3306) ชื่อฐานข้อมูล `ai_trading_db`
- **Quad-Daemon Engine Schedulers**:
  * Stocks: ทุก 5 นาที (จ-ศ ช่วงเวลาตลาดสหรัฐ 20:30 - 03:00 น.)
  * Forex: ทุก 5 นาที (จ-ศ ตลอด 24 ชม.)
  * Gold: ทุก 5 นาที (จ-ศ ตลอด 24 ชม. ยกเว้นช่วง Rollover 04:00 - 05:00 น.)
  * Crypto: ทุก 5 นาที (**รันต่อเนื่อง 24 ชั่วโมง 7 วัน รวมเสาร์-อาทิตย์**)
- **Position Sizing & Safety**:
  * Forex: 0.01 Lot (ขยายเป็น 0.02 Lot เมื่อ Confidence $\ge 75\%$ และ $|CSM| \ge 3.0$)
  * Gold: 0.01 Lot คงที่ (SL ขั้นต่ำ $3.50 buffer เพื่อความปลอดภัย)
  * Crypto: 0.01 Lot คงที่ (SL ขั้นต่ำ $350-$600 buffer บนราคา Bitcoin)
  * Fast-Sync: ตรวจสอบสถานะกับ MT5 ทุก 2.5 วินาที ครอบคลุมทั้ง 4 ตลาด

---

### 3. ⚖️ การตัดสินใจที่ผ่านมา (Past Decisions)
1. **Asset-Specific Separation (การแยกตามสินทรัพย์)**: ไม่ใช้ One-Size-Fits-All Indicator ชุดเดียว เพราะทองคำต้องการ Session + Liquidity Sweep และระยะ SL กว้างขึ้น ขณะที่คริปโทต้องการ Bollinger Squeeze + Volume Ratio
2. **Tri-Ensemble Architecture**: ผสาน LightGBM (35%) + XGBoost (25%) + CatBoost (25%) + Random Forest (15%) สำหรับ Forex M5
3. **Chandelier Multi-Stage Exit**: แบ่งปิดทำกำไรหุ้น 50% (Core) ที่ $+2.5 \times \text{ATR}$ ขยับ SL ไป Break-Even และรัน 50% ที่เหลือด้วย Chandelier Stop
4. **Time-Decay Hard Exit**: ตัดขาดทุนหรือปิดทำกำไรไม้ไร้โมเมนตัม (Forex 120 นาที, Gold 4 ชั่วโมง, Crypto 6 ชั่วโมง) ป้องกันเงินทุนจม
5. **Weekend Whale Fakeout Guard**: ปรับเกณฑ์ Volume Spike สำหรับ Crypto เป็น $2.0\times$ ในวันเสาร์-อาทิตย์

---

### 4. ✅ งานที่เสร็จแล้ว (Completed Work)
1. **Phase 1: Dynamic Symbol Gating & Asymmetric Sizing**: กรองคู่เงิน Sideway ด้วย ADX และ CSM Spread ใน `services/forexEngine.js`
2. **Phase 2: Chandelier Multi-Stage Exit & Stock Sync**: ติดตั้งระบบ Partial Close บน MT5 และกู้คืนไม้ `AMD` สู่ `SIGNAL_OPEN` กำไรลอยตัว +$2.21
3. **Phase 3: 13 ML Features & Tri-Ensemble Retrain v2**: เทรนโมเดลบน 44,959 ตัวอย่าง (AUC BUY 80.25% / SELL 83.26%) ผลงานจริงล่าสุด ชน Take Profit 3 ไม้รวด (`USDJPY` +$1.25, `GBPJPY` +$1.26, `EURJPY` +$1.28)
4. **Phase 4: Time-Decay Stale Order Guard**: ระบบ Time-Stop ล้างไม้ค้างข้ามคืน 7 ไม้ ปลดล็อก Margin ได้สำเร็จ
5. **Phase 5: Knowledge Synthesis (Gold & Crypto)**: สกัดความรู้จาก 8 บทความ บันทึกลง `references/gold_crypto_trading_knowledge.md`
6. **Phase 6: Dedicated Gold & Crypto Trading Engines**:
   - สร้างและติดตั้ง `services/goldEngine.js` และ `services/cryptoEngine.js`
   - เพิ่ม AI Predictor ใน `services/modelPredictor.js`
   - อัปเดต `services/tradeResultTracker.js` รองรับ `market_type IN ('forex', 'stock', 'gold', 'crypto')`
   - อัปเดต `server.js` ติดตั้ง Quad-Schedulers และ API Endpoints (`/api/gold/scan`, `/api/crypto/scan`)
   - อัปเดตเอกสารระบบ `patch.md` สู่เวอร์ชัน `ver.beta.0.2`

---

### 5. ⏳ งานที่ยังค้างและทิศทางการพัฒนาต่อ (Pending Tasks & Roadmap)
- [ ] **เฝ้าติดตามผลการรันจริงของ 4 ตลาดต่อเนื่อง 24-48 ชั่วโมง**: บันทึกสถิติออเดอร์ทองคำและบิตคอยน์เข้าตาราง `trade_results`
- [ ] **Train Dedicated AI Models สำหรับ Gold และ Crypto**: เมื่อสะสมข้อมูลแท่งเทียนและออเดอร์จริงครบ 100-200 ไม้ ทำการ Train โมเดลแยกอิสระ
- [ ] **Stock News Sentiment Pipeline**: เชื่อมต่อ Gemini Flash หรือ Finnhub News เข้ามาเสริมคะแนน Catalyst ให้กับหุ้นสหรัฐช่วงก่อนตลาดเปิด
- [ ] **Automated Retrain Scheduler**: ตั้งเวลาให้ระบบ Retrain อัตโนมัติเมื่อสะสม Closed Trades ครบทุก 50 ไม้

---

### 6. ⚠️ ปัญหาหรือข้อจำกัด (Issues & Constraints)
- **MT5 Terminal**: ต้องเปิดโปรแกรม MT5 บน Windows และเปิดปุ่ม `Algo Trading` (สีเขียว) ไว้ตลอดเวลา
- **เวลาทำการตลาด**: หุ้นเปิด 20:30 - 03:00 น., Forex และ Gold พักช่วงสุดสัปดาห์ ในขณะที่ **Crypto เทรดได้ต่อเนื่อง 24/7 ไม่มีวันหยุด**
- **ความผันผวนของทองคำและบิตคอยน์**: ต้องคุม Lot Size ไว้ที่ 0.01 Lot เสมอเพื่อป้องกันความเสี่ยงจาก Slippage และ Spread ในช่วงข่าวใหญ่
