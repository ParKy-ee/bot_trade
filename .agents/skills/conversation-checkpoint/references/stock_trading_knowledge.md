# 📚 Stock Trading Knowledge Base & Feature Specification
## สรุปองค์ความรู้การเทรดหุ้นสากล สู่การพัฒนาระบบ AI Trading Bot

**เอกสารอ้างอิงสำหรับ**: การพัฒนาฟีเจอร์ AI Stock Swing Trading  
**วันที่บันทึก**: 2026-09-08  
**แหล่งที่มาของการวิเคราะห์**: Mark Minervini (SEPA & Trend Template), Stan Weinstein (Stage Analysis), Charles Le Beau (Chandelier Exit), FinBERT / LLM Financial NLP Research

---

## 1. 📈 การวิเคราะห์แนวโน้ม ขาขึ้น-ขาลง (Trend Identification & Market Regime)

### 1.1 Minervini Trend Template (Stage 2 Markup Confirmation)
ระบบคัดกรองหุ้นขาขึ้นแข็งแกร่ง (Institutional Accumulation) จะต้องผ่านเกณฑ์ 8 ประการพร้อมกัน:
1. **ราคาปัจจุบัน > SMA 150 และ SMA 200**
2. **SMA 150 > SMA 200**
3. **SMA 200 กำลังโค้งขึ้น (Uptrending)** ต่อเนื่องอย่างน้อย 1 เดือน (20 วันทำการ)
4. **EMA 50 > SMA 150 และ SMA 200**
5. **ราคาปัจจุบัน > EMA 50**
6. **ราคาปัจจุบันสูงกว่าจุดต่ำสุดในรอบ 52 สัปดาห์ (52-Week Low) อย่างน้อย 30%** (หุ้นที่กำลังฟื้นตัวหรือผู้นำตลาดจริงจะไม่อยู่ก้นเหว)
7. **ราคาปัจจุบันอยู่ห่างจากจุดสูงสุด 52 สัปดาห์ (52-Week High) ไม่เกิน 25%** (หุ้นนำตลาดมักทำ All-Time High หรือเกาะใกล้จุดสูงสุด)
8. **Relative Strength (RS vs SPY) อยู่ในกลุ่มนำ (Top 20-30%)**

### 1.2 Market Regime Filter (Macro Health)
* หากดัชนีแม่ **SPY (S&P 500)** หลุดต่ำกว่า SMA 200 หรืออยู่ใน Stage 4 (Downtrend):
  * **Action**: ระงับการเปิด Long อัตโนมัติ หรือลด Position Size เหลือ 25-50% เนื่องจากหุ้น 75-80% ในตลาดจะปรับตัวลงตามดัชนีภาพรวม

---

## 2. 📰 การวิเคราะห์ข่าวสารและตัวเร่งเชิงพื้นฐาน (News Sentiment & Catalysts)

### 2.1 โครงสร้างการวิเคราะห์ข่าว 2 ชั้น (Hybrid NLP Architecture)
1. **Fast Sentiment Triage (FinBERT)**:
   * จัดหมวดหมู่อารมณ์ข่าวแบบเร็ว: `Positive`, `Negative`, `Neutral`
   * ตรวจจับคำศัพท์ทางการเงินที่แบบจำลองทั่วไปมักเข้าใจผิด (เช่น "missed guidance", "margin expansion", "dilution")
2. **Deep Semantic Reasoning (LLM - Gemini 2.5 Flash)**:
   * วิเคราะห์บริบทของข่าว (Impact Scope, Time Horizon)
   * แยกแยะข่าวลวง/ข่าวลือ (Fluff/Clickbait) ออกจากข่าวมูลค่าจริง (Material Catalysts)

### 2.2 ประเภทข่าวตัวเร่งสำคัญ (Key Catalyst Categories)
* **Earnings Surprise & Guidance (PEAD Effect)**:
  * กำไร/รายได้ดีกว่าคาด (Earnings Beat) + ปรับเป้าคาดการณ์ขึ้น (Guidance Upgrade) เป็นตัวเร่งราคาที่มีแนวโน้มวิ่งต่อหลายสัปดาห์ (Post-Earnings Announcement Drift)
* **Product & Strategic Moves**:
  * การอนุมัติสิทธิบัตร/ยาใหม่, การเข้าถือครองกิจการ (M&A), ดีลความร่วมมือกับลูกค้ารายใหญ่
* **Capital & Management Changes**:
  * ซื้อหุ้นคืน (Stock Buyback), ผู้บริหารระดับสูงเข้าซื้อหุ้นในตลาด (Insider Buying)
* **Negative Red Flags**:
  * การเพิ่มทุนแปลงสภาพ (Dilutive Offering), การฟ้องร้องทางกฎหมาย (SEC Investigation), ปรับลด Guidance

### 2.3 Information Decay (อายุของข่าว)
* สัญญาณจากข่าวจะมีน้ำหนักสูงสุดภายใน **0 - 24 ชั่วโมงแรก**
* หากข่าวออกมาเกิน 48 ชั่วโมง ตลาดมักจะสะท้อนราคา (Priced-in) ไปแล้ว สัญญาณทางเทคนิคจะกลับมามีน้ำหนักมากกว่า

---

## 3. 🎯 จุดเข้าเทรดและจังหวะราคา (Entry Timing & Patterns)

### 3.1 Volatility Contraction Pattern (VCP)
* ในหุ้น Stage 2 ที่ผ่าน Trend Template การเข้าซื้อไม่ใช่ไล่ราคาสุ่มสี่สุ่มห้า แต่ต้องรอการบีบตัวของราคา:
  * การแกว่งตัวจากกว้าง ค่อยๆ แคบลง (เช่น ย่อครั้งแรก 15% -> ย่อครั้งที่สอง 8% -> ย่อครั้งที่สาม 3%)
  * **Volume Dry-Up**: ปริมาณการซื้อขายเหือดแห้ง แสดงว่าแรงเทขายของนักลงทุนรายย่อยเริ่มหมดมือ
  * **Pivot Breakout**: ราคาเบรกทะลุกรอบบีบตัวด้วย Volume เพิ่มขึ้นอย่างน้อย $1.5 \times$ ของค่าเฉลี่ย 20 วัน (RVOL $\ge 1.5$)

### 3.2 Key MA Pullback Entry
* สำหรับกลยุทธ์ Swing Trading ที่ไม่ต้องรอ Breakout:
  * หุ้นที่แข็งแกร่งกว่าตลาด ย่อตัวลงมาทดสอบเส้น **EMA 20** หรือ **EMA 50**
  * มีแท่งเทียนกลับตัว (Bullish Reversal / Hammer) พร้อม RSI ยืนเหนือ 45-50

---

## 4. 🛡️ การบริหารความเสี่ยง, TP และ SL (Risk & Exit Architecture)

### 4.1 Chandelier Exit (ความผันผวนตาม ATR)
* ออกแบบโดย Charles Le Beau ใช้ติดตามความผันผวนจริงของหุ้น:
  $$\text{Chandelier Long Stop} = \text{Highest High}(22) - (\text{ATR}(22) \times 3.0)$$
* **ข้อดี**: ไม่โดนเขย่าหลุดเพราะ Noise รายวันในหุ้นที่ผันผวนสูง และจะกระชับตามราคาสูงสุดใหม่โดยอัตโนมัติ

### 4.2 Multi-Stage Take Profit Strategy ("Core & Runner")
* **TP1 (Core 50%)**:
  * ปิดทำกำไรกึ่งหนึ่ง (50% ของ Position) เมื่อราคาถึงเป้าหมาย Risk-to-Reward $1:2$ หรือ $2.5 \times \text{ATR}$
  * **Break-Even Trigger**: เมื่อ TP1 ถูกแตะ ให้ขยับ SL ของไม้ที่เหลือมาที่จุดคุ้มทุน (Entry Price $+ 0.5 \times \text{ATR}$) ทันที การเทรดนี้จะไม่มีวันขาดทุน
* **TP2 (Runner 50%)**:
  * ถือครองหุ้นที่เหลืออีก 50% ต่อเนื่องโดยไม่มี Target ตายตัว เพื่อรันเทรนด์ใหญ่
  * ออกจากไม้ Runner เมื่อราคาปิดหลุดเส้น **Chandelier Exit** หรือปิดต่ำกว่า **EMA 20**

### 4.3 Capital Protection Rule
* กำหนด Maximum Risk ต่อหนึ่ง Trade ไม่เกิน 1.0% - 1.5% ของ Equity ทั้งหมด
* หาก Stop Loss คำนวณจาก ATR แล้วกว้างเกิน 8% ให้ลดขนาด Lot/Share ลง เพื่อรักษา Dollar Risk ให้คงที่เสมอ

---

## 5. 🚀 แผนพัฒนาฟีเจอร์ใหม่เข้าสู่ระบบ AI Trading Bot

| โมดูล | ฟีเจอร์ใหม่ที่สามารถต่อยอดได้ | แหล่งโค้ดเป้าหมาย |
| :--- | :--- | :--- |
| **Trend Screener** | **Minervini Stage 2 Engine**: ตรวจสอบ MA 50/150/200 และคำนวณ 52-week High/Low distance | `services/indicators.js`, `services/tradingEngine.js` |
| **News Catalyst** | **News Sentiment Scorer**: เชื่อมต่อ Financial News API (Yahoo/Finnhub) + Gemini Reviewer ประเมิน Sentiment Score (-1.0 ถึง +1.0) | `services/geminiReviewer.js` |
| **Alpha Composite** | **Multi-Factor Entry Gate**: รวมค่า `ML Probability` + `Technical RS` + `News Sentiment` เป็น Composite Score | `services/tradingEngine.js` |
| **Exit Engine** | **Chandelier Dynamic Exit & Partial Take Profit**: รองรับการปิด 50% ที่ $2.5 \times \text{ATR}$ และรัน Chandelier Trailing ส่วนที่เหลือ | `python/mt5_bridge.py`, `services/tradingEngine.js` |
