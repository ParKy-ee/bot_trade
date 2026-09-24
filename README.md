# 🤖 AI Swing Trading Bot Service (Node.js + XAMPP MySQL)

ระบบสแกนและประมวลผลสัญญาณสวิงเทรดด้วย AI Machine Learning บน **Node.js runtime** ทำงานร่วมกับ **XAMPP MySQL** โดยตรง ไม่ต้องพึ่งพา Docker

## Freqtrade → XM MT5 bridge

มี endpoint สำหรับรับ signal จาก strategy ภายนอกแล้วส่งเข้า MT5/XM ได้เฉพาะ `XAUUSD`, `EURUSD`, และ `BTCUSD`:

```http
POST /api/integrations/freqtrade-mt5/signal
Authorization: Bearer <FREQTRADE_MT5_WEBHOOK_TOKEN>
Content-Type: application/json

{
  "signalId": "unique-signal-id",
  "symbol": "XAUUSD",
  "action": "BUY",
  "lot": 0.01,
  "price": 3000.00,
  "sl": 2990.00,
  "tp": 3020.00,
  "confidence": 0.72,
  "strategyName": "MyFreqtradeStrategy",
  "strategyVersion": "v1"
}
```

ตั้ง `FREQTRADE_MT5_WEBHOOK_TOKEN` เป็น secret แบบสุ่มยาว และตรวจสอบ `GET /api/integrations/freqtrade-mt5/status` ก่อนใช้งานจริง. ค่าเริ่มต้น `FREQTRADE_MT5_EXECUTION_ENABLED=false` จะบันทึกเฉพาะ signal แบบ `SHADOW` และไม่ส่งคำสั่งเข้า MT5; เปิดเป็น `true` หลังทดสอบบัญชี demo แล้วเท่านั้น. แถวที่มาจาก bridge ถูกระบุด้วย `source_tag = 'freqtrade_mt5'` ในตาราง `signals`, `active_positions`, และ `trade_results`.

---

## 🌟 ฟีเจอร์หลัก (Features)

1. **สถาปัตยกรรมแบบ Node.js Runtime + XAMPP MySQL**:
   - เชื่อมต่อ MySQL ของ XAMPP (`127.0.0.1:3306`) ผ่าน `mysql2/promise` Connection Pool
   - สร้างและอัปเดต Database `ai_trading_db` และตาราง `signals`, `active_positions`, `market_bars` ให้อัตโนมัติ
2. **AI Swing Trading Engine**:
   - ดึงข้อมูลราคาหุ้น OHLCV รายวันจาก Yahoo Finance (Universe: `NVDA`, `AMD`, `TSLA`, `MSFT`, `AVGO`, `NFLX`, `AMZN`, `META`, `GOOGL`, `SPY`)
   - คำนวณ Technical Indicators & Relative Strength (RS 20d vs SPY, EMA 20/50/200, RSI, MACD, ATR, Bollinger Bands, ADX, RVOL)
   - เชื่อมต่อโมเดล Machine Learning (`dynamic_trailing_model.joblib`: LightGBM + Random Forest) เพื่อพยากรณ์ความมั่นใจ (Confidence Score)
   - ระบบ Dynamic ATR Trailing Stop-Loss สำหรับตำแหน่งที่กำลังถือ
3. **ระบบแจ้งเตือน Telegram**:
   - แจ้งเตือนเมื่อตรวจพบสัญญาณซื้อพร้อมจุดเข้า, Stop Loss, และ Take Profit (ตั้งค่าใน `.env`)
4. **Interactive Web Dashboard**:
   - เข้าดูสถานะการทำงาน, สัญญาณเทรด, ตำแหน่งที่กำลังถือ, กราฟราคาตลาด และข้อมูลดิบในตาราง MySQL ผ่าน Browser ได้ทันทีที่ `http://localhost:3000` หรือผ่าน XAMPP htdocs

---

## 🚀 วิธีการติดตั้งและเริ่มใช้งาน

### 1. เปิด XAMPP Control Panel
- สั่ง **Start** โมดูล **MySQL** (และ Apache หากต้องการ) ใน XAMPP

### 2. ตั้งค่าไฟล์คอนฟิก (.env)
ไฟล์ `.env` มีการตั้งค่าเริ่มต้นสำหรับ XAMPP ให้แล้ว:
```env
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ai_trading_db
DB_USER=root
DB_PASSWORD=

SCAN_INTERVAL_MINUTES=15
CONFIDENCE_THRESHOLD=0.38

# ใส่ Telegram Bot Token และ Chat ID หากต้องการแจ้งเตือน
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 3. สั่งรัน Service
เปิด Terminal ในโฟลเดอร์นี้ (`C:\xampp\htdocs\trade_bot`):
```bash
# เริ่มต้นบอทและเว็บ Dashboard
npm start
```
หรือหากต้องการรันแบบ Auto-reload เมื่อแก้ไขโค้ด:
```bash
npm run dev
```

### 4. เปิด Web Dashboard
เปิดเว็บเบราว์เซอร์ไปที่:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 📦 คำสั่งเสริม (Helper Scripts)

- **ทดสอบการเชื่อมต่อฐานข้อมูล**:
  ```bash
  npm run test-db
  ```
- **Seed ข้อมูลและสัญญาณย้อนหลัง 1 ปี (Historical Seeder)**:
  ```bash
  npm run seed
  ```
  *(หรือกดปุ่ม **"Seed ข้อมูลย้อนหลัง"** บน Web Dashboard)*

---

## 📁 โครงสร้างโปรเจกต์ (Directory Structure)

```
C:\xampp\htdocs\trade_bot\
├── .env                     # การตั้งค่าพอร์ตและ MySQL
├── package.json             # Node.js dependencies
├── server.js                # Express API + Background Daemon Scheduler
├── config/
│   └── database.js          # จัดการการเชื่อมต่อและ Schema ของ MySQL
├── services/
│   ├── marketData.js        # ดึงข้อมูลตลาดจาก Yahoo Finance
│   ├── indicators.js        # คำนวณ Indicator ทางเทคนิคทั้งหมด
│   ├── modelPredictor.js    # รัน AI Model Inference (LightGBM + RF)
│   ├── tradingEngine.js     # แกนหลักวิเคราะห์สัญญาณและ Trailing Stop
│   ├── telegramAlert.js     # ส่งการแจ้งเตือนทาง Telegram
│   └── historicalSeeder.js  # ดึงข้อมูลและสร้างสัญญาณย้อนหลัง
├── python/
│   ├── fetch_data.py        # สคริปต์ดึงข้อมูล Yahoo Finance พร้อม Session Cache
│   ├── predict_bridge.py    # สะพานเชื่อมการพยากรณ์โมเดล joblib
│   └── models/
│       └── dynamic_trailing_model.joblib # โมเดล AI จากโปรเจกต์เดิม
└── public/
    ├── index.html           # หน้า Web Dashboard
    ├── style.css            # ธีม Dark Mode
    └── app.js               # จัดการข้อมูลและการวาดกราฟบน Dashboard
```
