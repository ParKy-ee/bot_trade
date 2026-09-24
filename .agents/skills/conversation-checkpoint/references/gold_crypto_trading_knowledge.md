# 🏆 Gold & Crypto Trading Knowledge Base & Architecture Blueprint
## สรุปองค์ความรู้เชิงลึก: พฤติกรรมตลาดทองคำ (GOLD / XAUUSD) และคริปโทเคอร์เรนซี (BTCUSD)
**เอกสารอ้างอิงสำหรับ**: การออกแบบโมเดล AI และ Indicator แยกเฉพาะรายสินทรัพย์ (Asset-Specific Engines & ML Models)  
**วันที่จัดทำ**: 2026-09-09  
**แหล่งข้อมูลอ้างอิง**:
1. *TFEX Gold Trading Knowledge* (tfex.co.th)
2. *Uhas: 5 Factors Affecting Gold Price* (uhas.com)
3. *TMGM: Gold Trading Top Tips* (tmgm.com)
4. *FXCM: Insights - How to Trade Gold* (fxcm.com)
5. *FBS Academy: How to Trade Gold* (fbs.co.th)
6. *Bitkub: 6 Strategies for Crypto Traders* (bitkub.com)
7. *Uhas: สอนเทรดบิตคอยน์ Forex* (uhas.com)
8. *Orbix Trade: Price Pattern พื้นฐานในการเทรด Bitcoin* (orbixtrade.com)

---

## 🧭 ทำไมต้องแยก Model และ Indicator ตามสินทรัพย์? (Core Philosophy)
ในตลาดการเงิน สินทรัพย์แต่ละประเภทมี **Market Microstructure**, **ผู้เล่นหลัก (Participants)** และ **กลไกราคา (Driving Forces)** ที่แตกต่างกันอย่างสิ้นเชิง:
* **Forex ทั่วไป (EURUSD, USDJPY, GBPUSD)**: ตลาด Mean-Reversion กึ่ง Trend ขับเคลื่อนด้วยส่วนต่างอัตราดอกเบี้ย (Interest Rate Parity) และ Currency Strength Meter (CSM)
* **ทองคำ (GOLD / XAUUSD)**: Safe-Haven Asset และ Inflation Hedge ไม่สร้างกระแสเงินสด (Zero Yield) ไวต่อ Real Yields และ US Dollar Index (DXY) สวิงแรงและมีแท่งเทียนทิ้งไส้กวาด Stop Loss สูง (High Wicks / Liquidity Sweeps)
* **คริปโทเคอร์เรนซี (BTCUSD)**: สินทรัพย์ High-Beta เทรดตลอด 24/7 ไม่มีวันหยุด มี Trend Persistence และโมเมนตัมสูงมาก ขับเคลื่อนด้วย Derivatives Liquidation Cascades, Halving Cycles และ On-Chain Whales

> บทเรียนสำคัญ: การใช้ Indicator ชุดเดียวหรือโมเดล AI กล่องเดียว (One-Size-Fits-All) มาเทรดทุกสินทรัพย์มักจะล้มเหลว เพราะทองคำต้องการระยะ SL กว้างขึ้นตาม ATR และฟิลเตอร์ DXY ขณะที่คริปโทต้องการ Volatility Breakout และ Liquidity Hunt Reversal

---

# PART 1: 🟡 เจาะลึกตลาดทองคำ (GOLD / XAUUSD)

### 1.1 ปัจจัยพื้นฐานและตัวเร่งราคา (5 Macro Catalysts - อ้างอิง Uhas & TFEX)
1. **US Dollar Index (DXY) - สหสัมพันธ์ผกผันรุนแรง (-0.80 ถึง -0.90)**:
   * ราคาทองคำซื้อขายด้วยสกุลเงินดอลลาร์สหรัฐฯ หาก DXY แข็งค่า ทองคำจะแพงขึ้นในสายตานักลงทุนต่างชาติ ทำให้ราคาปรับลดลง
   * *AI Feature*: สัญญาณ DXY Slope / Momentum (ถ้า DXY ทะลุแนวต้าน ให้ห้ามเปิด BUY ทองคำ)
2. **Real Interest Rates (อัตราดอกเบี้ยที่แท้จริง)**:
   * Real Yield = US 10Y Nominal Yield - Inflation Expectations
   * ทองคำไม่มีผลตอบแทนดอกเบี้ย หากดอกเบี้ยแท้จริงปรับขึ้น ค่าเสียโอกาสในการถือทองจะสูงขึ้น ส่งผลให้เงินทุนไหลออกจากทองคำไปยังพันธบัตร
3. **ราคาน้ำมันโลกและเงินเฟ้อ (Crude Oil & CPI Inflation)**:
   * น้ำมันดิบเป็นต้นทุนของห่วงโซ่เศรษฐกิจ หากน้ำมันพุ่ง เงินเฟ้อจะพุ่งตาม ทองคำจะถูกซื้อเป็นเกราะป้องกันเงินเฟ้อ (Inflation Hedge)
4. **ความไม่แน่นอนทางภูมิรัฐศาสตร์และสงคราม (Geopolitical Uncertainty & Safe-Haven)**:
   * วิกฤตธนาคาร สงคราม มาตรการคว่ำบาตร จะกระตุ้นแรงซื้อทองคำแท่งและ Gold ETF อย่างฉับพลัน
5. **การสะสมทองคำของธนาคารกลาง (Central Bank Gold Reserves)**:
   * การเข้าซื้อเชิงยุทธศาสตร์ของ PBoC (จีน), อินเดีย และรัสเซีย เพื่อลดการพึ่งพาดอลลาร์ (De-dollarization) สร้างแนวรับระยะยาวที่มั่นคง

---

### 1.2 วงรอบเวลาการเทรดที่ได้เปรียบ (Optimal Trading Sessions - อ้างอิง TMGM)
* **ช่วงเอเชีย (Asian Session 06:00 - 13:00 THA)**:
  * ความผันผวนต่ำ ราคาเคลื่อนไหวในกรอบสะสม (Accumulation Range) มักสร้าง High/Low หลอก
  * *กลยุทธ์*: เหมาะกับการหาขอบเขตแนวรับแนวต้าน (Asian High/Low) เพื่อรอ London กวาดสภาพคล่อง
* **ช่วงลอนดอน (London Open 14:00 - 18:00 THA)**:
  * วอลุ่มเริ่มไหลเข้า ยุโรปเริ่มตั้งทิศทางประจำวัน มักเกิดจังหวะ Judas Swing / London Manipulation (หลุดหลอกฝั่งเอเชียแล้วดีดกลับทิศจริง)
* **ช่วงตลาดซ้อนทับ ลอนดอน-นิวยอร์ก (London & NY Overlap 19:30 - 23:30 THA)**:
  * ชั่วโมงทอง (Golden Window): วอลุ่มสูงสุด โมเมนตัมสูงสุด มีตัวเลขเศรษฐกิจสหรัฐฯ สำคัญ (CPI, NFP, PPI) ออกเวลานี้
  * *กลยุทธ์*: เหมาะแก่การเทรด Breakout & Momentum Continuation ที่สุด

---

### 1.3 ท่าเข้าเทรดทองคำที่ เข้าเป้า (High-Probability Setups - อ้างอิง FXCM & FBS)

#### ท่าที่ 1: London / NY Liquidity Sweep & Retest (กวาดสภาพคล่องแล้วย้อนทิศ)
* **พฤติกรรมทองคำ**: เจ้ามือ (Institutions) มักลากราคาไปกิน Stop Loss เหนือยอด High หรือใต้ Low ของช่วง Asian Session
* **เงื่อนไขเข้าเทรด**:
  1. ราคาทะลุ Asian High/Low ขึ้นไป แต่ไม่สามารถยืนได้ เกิดแท่งเทียนทิ้งไส้ยาว (Rejection Pinbar / Wick Sweep)
  2. กราฟดึงกลับเข้ามาในกรอบเดิม (Failure to Accept Outside Range)
  3. สัญญาณ RSI (Period 14) เกิด Bearish/Bullish Divergence ใน M5/M15
  4. **จุดเข้า**: เข้าเมื่อแท่งเทียนปิดกลับเข้ามาในกรอบ, SL วางเหนือปลายไส้ที่กวาดไป + 1.5x ATR (M5), TP ที่ Asian Midpoint หรือ Opposite Low (R:R >= 1:2.5)

#### ท่าที่ 2: Dynamic Trend Pullback + EMA Confluence
* **พฤติกรรมทองคำ**: เมื่อทองมีเทรนด์ชัดเจนใน H1/M15 มักจะไม่ย่อลึกถึงแนวรับใหญ่ แต่จะย่อมาแตะเส้นค่าเฉลี่ยเคลื่อนที่ไดนามิก
* **เงื่อนไขเข้าเทรด**:
  1. H1 Trend ยืนเหนือ EMA 50 และ EMA 200 อย่างมั่นคง
  2. M5 เกิดการย่อตัวแตะเส้น EMA 21 หรือ EMA 50
  3. Stochastic Oscillator (5,3,3) หรือ RSI ย่อแตะระดับ Oversold (<30)
  4. เกิดแท่งเทียน Bullish Engulfing ยืนยันการกลับตัว
  5. **จุดเข้า**: เปิด BUY ทันที, SL ใต้ Low ล่าสุด - 30-40 pips (300-400 points), Partial TP 50% ที่ 1.5x ATR, รันเทรนด์ด้วย Chandelier Trailing Stop

---

### 1.4 Indicator Setup ที่เหมาะสมสำหรับทองคำ (GOLD)
* **ATR (Period 14 บน M5/M15)**: สำคัญที่สุดในการกำหนด SL/TP (ห้ามใช้ Fixed Points ตายตัว เพราะช่วงข่าว ATR สามารถพุ่งสูง 3-5 เท่า)
* **Moving Averages**: EMA 21 (จังหวะย่อสั้น), EMA 50 (แนวรับเทรนด์ระยะกลาง), SMA 200 (ทิศทางหลัก)
* **Volume Weighted Average Price (VWAP)**: ทองคำเคารพระดับ Daily VWAP และ Standard Deviation Bands อย่างยิ่ง
* **RSI (14) พร้อม Oversold/Overbought แบบ Dynamic**: ปรับระดับเป็น 25/75 เนื่องจากทองคำมีแรงเหวี่ยงหลุด 30/70 ได้บ่อยมาก

---

# PART 2: 🪙 เจาะลึกตลาดบิตคอยน์และคริปโท (BTCUSD)

### 2.1 พฤติกรรมเฉพาะตัวของคริปโท (อ้างอิง Bitkub & Uhas)
1. **เทรดได้ตลอด 24 ชั่วโมง 7 วัน (24/7 Liquidity Dynamics)**:
   * จันทร์ - ศุกร์: เคลื่อนไหวสอดคล้องกับ Nasdaq, S&P 500 และ Spot ETF Net Inflows
   * เสาร์ - อาทิตย์ (Weekend Trading): วอลุ่มสถาบันหาย เกิด Weekend Range มักมีวาฬสร้าง Fakeout บ่อยครั้ง แต่เมื่อเปิดวันจันทร์มักเกิด CME Gap Fill หรือเทรนด์กระชากจริง
2. **Derivative-Driven Cascades (Long/Short Liquidation Squeeze)**:
   * ตลาดคริปโทใช้ Leverage สูง เมื่อราคาทะลุแนวสำคัญจะเกิดการบังคับปิดสถานะต่อเนื่องเป็นลูกโซ่ ทำให้ราคาวิ่งพุ่งพรวดเป็นเส้นตรง (Parabolic Run)
3. **Cycle-Driven (Halving & Macro Liquidity)**:
   * รอบ 4 ปีของ Bitcoin Halving และสภาพคล่องดอลลาร์โลก (Global M2)

---

### 2.2 ท่าเข้าเทรด Price Pattern สไตล์คริปโท (อ้างอิง Orbix Trade)

#### รูปแบบที่ 1: Reversal Patterns (กลับทิศทางใหญ่)
* **Double Bottom / Triple Bottom (W-Pattern)**:
  * ทดสอบแนวรับสำคัญ 2 ครั้งโดยที่ก้นครั้งที่สองยกสูงขึ้นเล็กน้อย (Higher Low) หรือเกิด Liquidity Sweep กวาดก้นแรกแล้วดึงกลับทันที
  * **ท่าเข้าเป้า**: อย่ารีบเข้าที่ก้น ให้รอราคาเบรกทะลุ Neckline ขึ้นไป แล้วรอจังหวะ Pullback Retest แนว Neckline ที่กลายเป็นแนวรับ พร้อม Volume แห้งลง แล้วเกิดแท่งเทียนเด้งกลับ จึงเปิด BUY
* **Inverse Head and Shoulders (กลับตัวจากขาลงเป็นขาขึ้น)**:
  * หัวต่ำสุด ไหล่ซ้ายและขวายกตัว ทะลุ Neckline ด้วย Volume สถาบันหนุน

#### รูปแบบที่ 2: Continuation Patterns (รูปแบบไปต่อที่แม่นยำที่สุดในคริปโท)
* **Ascending Triangle (สามเหลี่ยมยกโลว์)**:
  * แนวต้านด้านบนเป็นเส้นระนาบแนวนอน ขณะที่แรงซื้อดันจุดต่ำสุดยกสูงขึ้นเรื่อยๆ (Higher Lows) แสดงถึงแรงซื้อสะสมอย่างไม่ลดละ
  * **ท่าเข้าเป้า**: รอราคาทะลุระนาบแนวนอน + Volume Expansion สูงกว่าค่าเฉลี่ย 20 วัน จากนั้นเข้าเมื่อเกิด Retest แนวต้านเดิม
* **Bull Flag / Bear Flag (ธงพักตัวสะสมพลัง)**:
  * มีแท่งเทียนวิ่งขึ้นรุนแรงเป็นเสาธง (Impulse Flagpole) จากนั้นราคาแกว่งตัวย่อลงแคบๆ ในกรอบขนาน ด้วย Volume ที่ลดลงต่อเนื่อง
  * **ท่าเข้าเป้า**: เบรกกรอบธงด้านบน เปิด BUY วาง SL ใต้กรอบธงล่าง เป้าหมาย TP เท่ากับความยาวของเสาธง (Measured Move)

---

### 2.3 Indicator Setup ที่เหมาะสมสำหรับบิตคอยน์ (BTCUSD)
* **Bollinger Bands (20, 2) + BandWidth (BB Squeeze)**:
  * คริปโทเมื่อราคาบีบตัวแคบ (BandWidth หดต่ำสุดในรอบหลายสิบแท่ง) จะตามมาด้วยการระเบิดของเทรนด์ (Expansion) รุนแรงเสมอ
* **EMA 20, 50, 200 บน Timeframe M15 / H1**:
  * สัญญาณ Golden Cross (EMA 50 ตัดขึ้นเหนือ EMA 200) และ Death Cross บน H1 เป็นจุดเปลี่ยน Regime ตลาดที่ทรงอิทธิพลมาก
* **ADX (14)**: ใช้กรอง Trend Strength อย่างเข้มงวด (ต้อง ADX >= 25 เท่านั้นถึงจะเล่นกลยุทธ์ Trend Following)
* **Volume Delta & Spike Confirmation**: ในคริปโท การเบรกแนวรับแนวต้านต้องมี Volume ยืนยันอย่างน้อย 1.5 - 2.0 เท่าของ Volume เฉลี่ย 20 วันเสมอ มิฉะนั้นมักจะเป็น Bull/Bear Trap

---

# PART 3: 🛠️ พิมพ์เขียวสถาปัตยกรรมการแยก Model และ Engine (System Architecture)

### สรุปความแตกต่างของพารามิเตอร์แต่ละสินทรัพย์

| มิติการเปรียบเทียบ | หุ้น (US Stocks) | Forex (Majors) | ทองคำ (GOLD) | คริปโท (BTCUSD) |
| :--- | :--- | :--- | :--- | :--- |
| **ความถี่เวลาตลาด** | 20:30 - 03:00 THA (จ-ศ) | 24 ชม. (จ-ศ) | 24 ชม. (หยุดพัก 1 ชม.) | **24 ชม. 7 วัน (ไม่มีวันหยุด)** |
| **ตัวขับเคลื่อนหลัก** | ผลประกอบการ, Guidance, S&P 500 | ดอกเบี้ย, CSM, เงินเฟ้อ | **DXY, Real Yield, Safe-Haven** | **Halving, On-Chain, Liquidations** |
| **พฤติกรรมราคา** | Trend + Gap เปิดตลาด | Mean Reversion + Trend | **High Wicks, Violent Sweeps** | **Explosive Breakouts, Trend Run** |
| **Key Indicator 1** | Minervini Trend (EMA 50/150/200) | CSM + ADX (18) | **London/NY Session + VWAP** | **Bollinger Squeeze + ADX (25)** |
| **Key Indicator 2** | VCP (Contraction) + FinBERT | RSI + Stochastic Dynamic | **ATR (14) Dynamic Buffers** | **Volume Spikes (>= 1.8x Avg)** |
| **SL Sweet Spot** | 3.0x ATR หรือต่ำกว่า Pivot | 1.5 - 2.0x ATR | **3.0 - 4.5x ATR (เผื่อสวิงไส้)** | **2.5 - 3.5x ATR หรือใต้ Swing** |
| **Trailing Exit** | Chandelier 3-Stage Exit | Breakeven + Time-Decay | **Partial TP 50% เร็ว + Breakeven** | **Runner Trailing ด้วย EMA 21/SuperTrend** |
| **สัดส่วน Lot Size** | 0.01 - 0.05 lot ตาม Risk | 0.01 - 0.02 lot | **0.01 lot (เริ่มต้นอย่างระวัง)** | **0.01 lot (เลเวอเรจต่ำ)** |
