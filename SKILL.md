---
name: conversation-checkpoint
description: Comprehensive framework for generating concise conversation checkpoints and state summaries when chat sessions grow long. Ensures the AI preserves core goals, key requirements, past architectural decisions, completed work, pending tasks, and active constraints.
---

# Conversation Checkpoint & Context Compression Skill

## 🎯 Purpose & Scope
เมื่อบทสนทนาระหว่าง User และ AI ดำเนินไปอย่างต่อเนื่องจนเริ่มมีความยาว ซับซ้อน หรือระบบเริ่มมีการตัดทอนบริบท (Context Window Truncation) ทักษะนี้จะกำหนดระเบียบและโครงสร้างมาตรฐานในการสรุป **Checkpoint** เพื่อให้ AI สามารถรักษาความต่อเนื่องของงาน (Continuity) ได้อย่างแม่นยำ 100% โดยไม่สูญเสียบริบทสำคัญ

---

## ⏱️ Trigger Conditions (เมื่อใดที่ต้องทำ Checkpoint)
ให้ทำ Checkpoint ทันทีเมื่อเข้าเงื่อนไขข้อใดข้อหนึ่งดังนี้:
1. **บริบทเริ่มยาวหรือมีข้อความตัดทอน (Truncated Context)**: เมื่อมีข้อความ `<CONTEXT_SUMMARY>` เข้ามาในระบบ
2. **จบงานฟีเจอร์หรือ Milestone ใหญ่**: เช่น ย้ายระบบเสร็จ, ต่อ API สำเร็จ, เทรนโมเดลเสร็จ
3. **เมื่อ User สั่งคำสั่งสรุปสถานะ**: เช่น "สรุปงานตอนนี้ให้หน่อย", "สรุป checkpoint", "สถานะถึงไหนแล้ว"
4. **ก่อนเริ่มงานก้อนใหม่ที่มีความเสี่ยงสูง**: เพื่อล็อกสถานะปัจจุบันให้ชัดเจนก่อนเริ่มแก้โค้ดชุดใหม่

---

## 📋 มาตรฐานโครงสร้าง Checkpoint (Strict 6-Section Template)

เมื่อสรุป Checkpoint ให้สรุป **เฉพาะ 6 หัวข้อหลักนี้เท่านั้น** อย่างกระชับ ชัดเจน และตรงประเด็น (ห้ามเกริ่นเยิ่นเย้อ):

### 1. 🎯 เป้าหมายหลัก (Core Goals)
- วัตถุประสงค์ใหญ่สูงสุดของโปรเจกต์ หรือปัญหาหลักที่กำลังแก้ไข
- ขอบเขตภาพรวมของงาน (Scope) ที่ตกลงกับ User ไว้

### 2. 📌 ข้อกำหนดสำคัญ (Key Requirements)
- Environment และ Tech Stack บังคับ (เช่น OS, Runtime, Database, Port, Framework)
- เงื่อนไขทางธุรกิจหรือเทคนิค (เช่น ไม่ใช้ Docker, ใช้ XAMPP MySQL, สแกนทุก 5 นาที, ค่า Confidence Threshold)
- มาตรฐานความปลอดภัย หรือข้อจำกัดที่ User กำชับเป็นพิเศษ

### 3. ⚖️ การตัดสินใจที่ผ่านมา (Past Decisions)
- การเลือกแนวทางเชิงสถาปัตยกรรม (Architectural & Design Choices) และเหตุผล
- การเลือกโครงสร้างตารางฐานข้อมูล, Indicator Logic, หรือโครงสร้างโฟลเดอร์
- ทางแยกสำคัญที่ User หรือทีมได้เลือกไปแล้ว เพื่อไม่ให้ย้อนกลับไปทำซ้ำหรือตัดสินใจขัดแย้ง

### 4. ✅ งานที่เสร็จแล้ว (Completed Work)
- รายการฟีเจอร์, ไฟล์, หรือสคริปต์ที่สร้างและทดสอบเสร็จสมบูรณ์แล้ว
- ผลลัพธ์เชิงประจักษ์ (Verification Results) เช่น จำนวนแถวข้อมูลที่บันทึก, ผลรัน Test, สัญญาณที่ตรวจพบ

### 5. ⏳ งานที่ยังค้าง (Pending Tasks)
- รายการงานที่ต้องทำต่อ เรียงตามลำดับความสำคัญ (Priority Order)
- สิ่งที่อยู่ระหว่างรอดำเนินการ (Next Steps)
- จุดที่ต้องทดสอบหรือเชื่อมต่อเพิ่มเติม

### 6. ⚠️ ปัญหาหรือข้อจำกัด (Issues & Constraints)
- บั๊ก, Error หรือพฤติกรรมผิดปกติที่พบและต้องเฝ้าระวัง
- ขีดจำกัดของระบบภายนอก (เช่น ข้อจำกัดของโบรกเกอร์, เวลาเปิด-ปิดของตลาดหุ้น/Forex, API Rate Limit)
- คำถามเปิด (Open Questions) หรือการตัดสินใจที่ยังรอ User ฟันธง

---

## 📝 ตัวอย่าง Checkpoint ที่ถูกต้อง (Example Output)

```markdown
# 📍 Conversation Checkpoint

### 1. 🎯 เป้าหมายหลัก (Core Goals)
- พัฒนาระบบ AI Trading Daemon สำหรับเทรดอัตโนมัติทั้งตลาดหุ้นสหรัฐและคู่เงิน Forex ผ่าน MetaTrader 5 (MT5) บัญชี Demo พร้อมเว็บแดชบอร์ดติดตามแบบ Real-time

### 2. 📌 ข้อกำหนดสำคัญ (Key Requirements)
- Runtime: Node.js (ES Module) บน Windows โดยไม่ใช้ Docker
- ฐานข้อมูล: XAMPP MySQL (พอร์ต 3306) ชื่อฐานข้อมูล `ai_trading_db`
- ความถี่การสแกน: วนรอบทุก 5 นาที (SCAN_INTERVAL_MINUTES=5)
- MT5 Integration: บัญชี XM Demo ($10,000 USD) ใช้ขนาดคำสั่งเริ่มต้น 0.01 lot สำหรับ Forex และ 0.1 lot สำหรับ Stock CFD

### 3. ⚖️ การตัดสินใจที่ผ่านมา (Past Decisions)
- ใช้ Python Bridge (`python/mt5_bridge.py`) เชื่อมต่อกับ MetaTrader5 API แบบ IPC รวดเร็วและไม่ค้าง
- ออกแบบตัวกรอง Forex 3 เสาหลัก (EMA 20/50/200 + ADX 14 >= 20 + RSI/MACD) เพื่อตัดตลาด Sideway
- ใช้พอร์ตและกระเป๋าเดียวกัน ($10,000 USD ใน XM MT5) สำหรับเทรดทั้งคู่เงินและหุ้นสหรัฐ CFD
- เปลี่ยน Timeframe การวิเคราะห์ Forex ระยะสั้นเป็น M5 พร้อมดึง Tick Volume จริง

### 4. ✅ งานที่เสร็จแล้ว (Completed Work)
- ย้ายระบบมาที่ `C:\xampp\htdocs\trade_bot` และรัน Web Dashboard ที่พอร์ต 3000 สำเร็จ
- เชื่อมต่อ MT5 Demo บัญชี `169315887` บนเซิร์ฟเวอร์ `XMGlobal-MT5 2` ติดสมบูรณ์
- พัฒนาระบบ Auto-Close ตรวจจับการชน Stop Loss (`CLOSED_SL`) และ Take Profit (`CLOSED_TP`)
- สร้างสคริปต์ `scripts/fetch_training_data.js` ดึงและเตรียมชุดข้อมูล ML รวม 70,509 แถว

### 5. ⏳ งานที่ยังค้าง (Pending Tasks)
- [ ] ทดสอบยิงออเดอร์หุ้น CFD ใน MT5 เมื่อตลาดสหรัฐเปิดทำการ (20:30 น. เวลาไทย)
- [ ] สังเกตการณ์ Trailing Stop Loss บนออเดอร์จริงใน MT5 เมื่อเกิดสัญญาณใหม่
- [ ] ปรับจูน Hyperparameters ของโมเดลด้วยชุดข้อมูล M5 ที่สกัดไว้

### 6. ⚠️ ปัญหาหรือข้อจำกัด (Issues & Constraints)
- ตลาดหุ้นสหรัฐเปิดทำการเวลา 20:30 - 03:00 น. (เวลาไทย) ออเดอร์หุ้นจะส่งได้เฉพาะช่วงเวลาตลาดเปิด
- MT5 จำเป็นต้องเปิดโปรแกรมและกดปุ่ม Algo Trading ให้เป็นสีเขียวทิ้งไว้เสมอ
```

---

## 🚫 ข้อห้ามสำคัญ (Anti-Patterns)
1. **ห้ามเล่าประวัติบทสนทนายืดยาว**: ห้ามเขียน "ผู้ใช้ถามว่า... จากนั้น AI ตอบว่า..."
2. **ห้ามใส่ Source Code ขนาดยาว**: ให้ระบุเฉพาะชื่อไฟล์ และหน้าที่โดยสังเขป
3. **ห้ามตกหล่นบั๊กหรือข้อจำกัด**: บั๊กที่ยังแก้ไม่จบ ต้องถูกบันทึกไว้ในหัวข้อที่ 6 เสมอ เพื่อป้องกันการลืมในบริบทถัดไป
