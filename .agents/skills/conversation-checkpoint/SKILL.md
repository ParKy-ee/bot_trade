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

---

## 📚 Permanent Knowledge & Checkpoint Files in this Skill
- **Active System Checkpoint**: [`CHECKPOINT.md`](file:///c:/xampp/htdocs/trade_bot/.agents/skills/conversation-checkpoint/CHECKPOINT.md) — สถานะการทำงานจริงล่าสุด, งานที่เสร็จแล้ว, และแผนขั้นถัดไป
- **System Knowledge & Architecture Reference**: [`references/system_knowledge.md`](file:///c:/xampp/htdocs/trade_bot/.agents/skills/conversation-checkpoint/references/system_knowledge.md) — สถาปัตยกรรม Dual Daemon, Fast-Sync (2.5s), SSE Streaming, การแยกโมเดล ML และการแก้ Spread Trap
- **Stock Trading Knowledge Base**: [`references/stock_trading_knowledge.md`](file:///c:/xampp/htdocs/trade_bot/.agents/skills/conversation-checkpoint/references/stock_trading_knowledge.md) — องค์ความรู้การเทรดหุ้น (Minervini Trend Template, Stage Analysis, FinBERT/LLM News Catalyst, Chandelier Multi-Stage Exit)

---

## 📝 ตัวอย่าง Checkpoint ล่าสุดของระบบ (Live Multi-Asset Trading System)

```markdown
# 📍 Conversation Checkpoint: AI Multi-Asset Trading System (Live MT5 Demo)

### 1. 🎯 เป้าหมายหลัก (Core Goals)
- พัฒนาระบบ AI Autonomous Trading System ที่เทรดอัตโนมัติ 2 ตลาดคู่ขนาน: หุ้นสหรัฐ (Daily Swing) และ คู่เงิน Forex (M5 Scalping) ผ่าน MT5 Demo (XM Global)
- บันทึกฟีเจอร์และผลลัพธ์ลงตาราง `trade_results` ใน XAMPP MySQL เพื่อใช้สำหรับ Continuous Active Learning (Auto-Retrain)
- ติดตามผลตอบแทนแบบ Real-time บน Web Dashboard ด้วย SSE สตรีมและกราฟแยกตลาดเด็ดขาด

### 2. 📌 ข้อกำหนดสำคัญ (Key Requirements)
- Node.js ES Module บน Windows โดยไม่ใช้ Docker | XAMPP MySQL (Port 3306) `ai_trading_db` | พอร์ตเว็บ 3000
- Dual Engine: สแกนตลาดหุ้นและ Forex คู่ขนานกันทุก 5 นาที
- Fast-Sync: ตรวจสอบสถานะออเดอร์กับ MT5 ทุก 2.5 วินาที พร้อมส่ง SSE Telemetry (`/api/stream`)
- การแยกข้อมูล: แยกสถิติและผลลัพธ์ระหว่าง Forex (Pips) และ Stock (% Return) เด็ดขาด

### 3. ⚖️ การตัดสินใจที่ผ่านมา (Past Decisions)
- แก้ปัญหา Spread Trap: ปรับขยายระยะ SL เป็นระดับปลอดภัย (Majors min 14 pips, JPY min 24 pips)
- แยกโมเดล ML: หุ้นใช้ `dynamic_trailing_model.joblib`, Forex ใช้ `forex_m5_model.joblib` (LightGBM + Random Forest)
- Data-First Active Learning: รันเก็บ Data ตลาดจริงต่อเนื่อง 24 ชม. ก่อนเริ่ม Retrain โมเดล
- Sequential Stream Pipeline: ประมวลผลทีละสัญลักษณ์และยิงออเดอร์เข้า MT5 ทันทีที่พบสัญญาณ (Zero Latency)

### 4. ✅ งานที่เสร็จแล้ว (Completed Work)
- ติดตั้งระบบ Fast-Sync 2.5s และ SSE Streaming สดบน Dashboard UI สำเร็จ
- แยกข้อมูลในตาราง `trade_results` และ API (`?market=forex|stock|all`) สำเร็จ
- ซิงค์ประวัติหุ้น 5 รายการ (`MSFT`, `TSLA`, `AVGO`, `NVDA`, `NFLX`) เข้า `trade_results`
- กราฟ Live Canvas และ Static 4-Panel Plotter (`scripts/plot_trade_results.py`) แยกการแสดงผล Forex และ Stock สำเร็จ

### 5. ⏳ งานที่ยังค้าง (Pending Tasks)
- [ ] รันเก็บ Data จากการเทรดจริงบน MT5 Demo ต่อเนื่อง 1 วัน (24 ชม.)
- [ ] Retrain โมเดลหลังครบ 24 ชม. ด้วยสคริปต์ `scripts/retrain_from_trade_results.py`
- [ ] พัฒนา Session & Time-of-Day Feature และ Currency Strength Meter (CSM)

### 6. ⚠️ ปัญหาหรือข้อจำกัด (Issues & Constraints)
- ต้องเปิดโปรแกรม MT5 Terminal และเปิดปุ่ม `Algo Trading` (สีเขียว) บนเครื่องทิ้งไว้เสมอ
- ตลาดหุ้นสหรัฐเปิดทำการ 20:30 - 03:00 น. (เวลาไทย) ในขณะที่ Forex วิ่งตลอด 24 ชั่วโมง
```

---

## 🚫 ข้อห้ามสำคัญ (Anti-Patterns)
1. **ห้ามเล่าประวัติบทสนทนายืดยาว**: ห้ามเขียน "ผู้ใช้ถามว่า... จากนั้น AI ตอบว่า..."
2. **ห้ามใส่ Source Code ขนาดยาว**: ให้ระบุเฉพาะชื่อไฟล์ และหน้าที่โดยสังเขป
3. **ห้ามตกหล่นบั๊กหรือข้อจำกัด**: บั๊กที่ยังแก้ไม่จบ ต้องถูกบันทึกไว้ในหัวข้อที่ 6 เสมอ เพื่อป้องกันการลืมในบริบทถัดไป

