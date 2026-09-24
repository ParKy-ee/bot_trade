# Conversation Checkpoint

### 1. 🎯 เป้าหมายหลัก (Core Goals)
- ปรับปรุงระบบ AI Forex M5 ให้กรองสัญญาณและคำนวณ TP/SL ตาม volatility ได้เหมาะสม พร้อมป้องกันการ insert/order ซ้ำและตรวจผลจากข้อมูลจริง

### 2. 📌 ข้อกำหนดสำคัญ (Key Requirements)
- Runtime: Node.js ES Module บน Windows/XAMPP; ฐานข้อมูล XAMPP MySQL; broker source of truth คือ MT5
- Forex confidence live ปัจจุบัน `0.51`; cooldown 15 นาที; ห้ามบันทึก trade ถ้า MT5 ไม่ยืนยัน fill
- การทดสอบต้องใช้ข้อมูล M5 แบบไม่ look-ahead และจำลองชน SL ก่อน TP ในแท่งเดียวกันแบบ conservative

### 3. ⚖️ การตัดสินใจที่ผ่านมา (Past Decisions)
- เพิ่ม duplicate guard ทั้ง active_positions, MT5 open positions และ trade_results
- แก้ผลแพ้/ชนะให้ยึด broker net P&L เมื่อมีข้อมูล และแก้ placeholder closed trade ให้ sync ซ้ำได้
- ทำ dynamic TP/SL เป็น opt-in เท่านั้น เพราะ walk-forward ยังไม่สม่ำเสมอพอสำหรับ live

### 4. ✅ งานที่เสร็จแล้ว (Completed Work)
- เพิ่ม `scripts/optimize_dynamic_exits.py` และผล `data/dynamic_exit_optimization.csv`, `data/dynamic_exit_recommendation.json`
- เพิ่ม `scripts/evaluate_entry_thresholds.py` และ `scripts/evaluate_walkforward.py` พร้อมผล CSV
- ผล optimize confidence 65%: validation 41 ไม้ +879.56 pips; test 57 ไม้ +182.50 pips, PF 1.308
- ผล walk-forward 5 folds: threshold 0.65 รวม +728.43 pips แต่ 3 folds แรกติดลบ; threshold 0.68 รวม +873.30 แต่ช่วงแรกยังติดลบ
- เพิ่ม dynamic exit branch ใน `services/forexEngine.js` และ config ใน `.env` โดยปิดไว้; syntax checks ผ่าน
- ปรับ `scripts/test-forex-optimizer.js` ให้คำนวณสูตรเดียวกับ live engine และเพิ่ม read-only dynamic diagnostic; MT5 diagnostic ผ่านครบ 9 คู่เงิน
- สร้าง `services/forexPatternEngine.js` แยก detector เป็น BOUNCE, REVERSAL, CONTINUATION, BREAKOUT พร้อม ABCD Classic/Extension, fingerprint และ ranking; smoke test MT5 ผ่านครบ 9 คู่เงิน
- ตรวจ signal ล่าสุดพบ 3 orders ใน scan เดียวกันภายใน ~30 วินาที: EURUSD SELL 52.69%, NZDUSD SELL 55.19%, GBPJPY BUY 58.36%; ทั้งหมดผ่าน threshold live 51% และ per-symbol guards
- อ่าน `trade_results` snapshot ของ 3 orders ล่าสุดแล้ว: พบ EMA/RSI/ADX/MACD/ATR และ `filter_reasons` ที่บันทึก ณ ตอนเข้า จึงใช้เป็นหลักฐานการตัดสินใจของระบบได้
- เพิ่ม `services/forexExitEngine.js` สำหรับ Dynamic TP/SL แบบ structure-aware: หา pivot จากแท่งที่ปิดแล้ว, จำกัด TP ด้วย swing ฝั่งตรงข้ามและ ATR, วาง SL หลัง invalidation swing และ skip เมื่อพื้นที่หรือ R:R ไม่พอ
- ต่อ Dynamic Exit ใหม่เข้า `services/forexEngine.js`, ปรับ diagnostic/optimizer ให้ใช้แนวคิดเดียวกัน และคง `FOREX_DYNAMIC_EXIT_ENABLED=false` ไว้ก่อน
- เพิ่ม `FOREX_TP_MULTIPLIER=0.5` ให้ TP สุดท้ายเหลือ 50% ของค่าที่คำนวณเดิมทั้ง fixed/ATR และ dynamic exit โดยไม่ลด SL; ตรวจ Node syntax ผ่านแล้ว
- ปิด Forex positions บน MT5 ครบ 11 tickets ที่เปิดอยู่ระหว่างรอบตรวจ (รวม 2 tickets ที่ service เปิดเพิ่มระหว่าง sync); ยืนยัน `positions=[]`, sync `trade_results` และไม่เหลือ Forex `active_positions` ที่มีสถานะ OPEN
- ผู้ใช้ยืนยันให้ปิดออเดอร์ก่อนเปิด service ใหม่; ปิด MT5 ครบ 6 tickets ล่าสุด และตรวจยืนยัน `positions=[]`, `pending_orders=0`, DB sync แล้วไม่มี Forex active position ค้าง
- เพิ่มระบบตรวจสอบเวลาเปิด-ปิดตลาดหุ้นสหรัฐ (NYSE/NASDAQ Regular Hours: 09:30 - 16:00 ET / ~20:30 - 03:00 น. เวลาไทย) ใน `services/tradingEngine.js` และ `server.js` พร้อม config `STOCK_MARKET_HOURS_ONLY=true` ใน `.env` หากตลาดปิดจะข้ามรอบสแกนหุ้นอัตโนมัติ ไม่เปลืองทรัพยากรและไม่ยิง API หุ้นนอกเวลา
- ขยาย `CRYPTO_UNIVERSE` เป็น High-Volume Basket 3 เหรียญหลัก (`BTCUSD`, `ETHUSD`, `SOLUSD`) พร้อมคำนวณ Min Lot และ SL Buffer ตามความผันผวนเฉพาะเหรียญใน `services/cryptoEngine.js`, ดึงแท่งเทียน M5/H1 จาก MT5 และบันทึกลง `market_bars` เรียบร้อย
- อัปเกรดระบบเข้าออเดอร์อัจฉริยะ (ver.beta.2):
  - สร้าง `services/forexPriceAction.js`: Overextended Guard ($> 1.8 \times \text{ATR}$ & RSI extreme), Compression Breakout Gate ($\ge 10$ แท่ง, ไส้ต้าน $< 30\%$), Rejection Wick Filter ($\ge 40\%$ Veto), และคำนวณ Pullback Limit Level
  - ขยาย `python/mt5_bridge.py` และ `services/mt5Broker.js`: รองรับ Pending Orders (`BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP`), `get_pending_orders()`, `cancel_order()`, และตั้ง Broker-Native Expiration (45 นาที)
  - ปรับปรุง `services/forexExitEngine.js`: คำนวณ Structural SL แยกโหมด Breakout ($1.0 \times \text{ATR}$ ขอบ Pattern) และ Pullback ($1.2 \times \text{ATR}$ เหนือ Swing High/Low) ป้องกันการย่อตัวทะลุ SL
  - ปรับปรุง `server.js`: ติดตั้ง Bar-Close Synchronization ซิงค์รอบสแกนที่วินาทีที่ 02 หลังจบแท่ง M5 ป้องกัน Time Lag และ Repainting
- ป้องกันสภาวะ EMA พันกัน และยกระดับ JPY Floor (ver.beta.3):
  - ติดตั้ง Anti-EMA Entanglement Filter ใน `services/forexFilter.js` สกัดสัญญาณ Sideway ที่ราคาพันกับเส้น EMA 50 ทิ้ง 100%
  - เพิ่มเกณฑ์ Floor ขั้นต่ำ `FOREX_GATING_MIN_ADX_JPY=24` เพื่อกรองตลาดไร้ทิศทางของคู่เงิน JPY Crosses
  - เพิ่ม Correlated Currency Exposure Guard จำกัดความเสี่ยงไม่ให้เปิดออเดอร์ทิศทางเดียวกันในสกุลเงินหลักเกินกำหนด
- พัฒนา Multi-Track Confluence Engine & Data-Harvesting Unlock Mode (ver.beta.4 - 2026-09-09):
  - ติดตั้ง 3 แทร็กอินดิเคเตอร์: `TREND_RIDER` (Supertrend 10, 3.0), `SQUEEZE_BREAKOUT` (Bollinger Bands Bandwidth), `PULLBACK_DIP` (Stochastic 14,3,3) ใน `services/forexFilter.js` พร้อม Weighted Score 0–100
  - อนุญาตให้ `SQUEEZE_BREAKOUT` ที่ได้คะแนน $\ge 60$ ข้าม ADX และ CSM Gating เพื่อไม่ให้ตกรถ
  - ปลดล็อกโควต้าและขีดจำกัดความมั่นใจตามคำสั่ง Data-First (`FOREX_CORRELATED_GUARD_ENABLED=false`, `FOREX_CONFIDENCE_THRESHOLD=0.01`)
  - ปรับปรุง Rejection Wick Filter (`FOREX_REJECTION_WICK_THRESHOLD=50%`) และข้ามการเช็คแท่งเทียนเปิดใหม่ที่ยังไม่สมบูรณ์
  - สรุปผลเทรด 2026-09-09: 54 ออเดอร์ (ปิด 49, เปิด 5), **Win Rate 51.02%**, **+112.6 Pips**, **+$1.17 Net PnL** (พลิกจาก -353.1 pips ในวันก่อนหน้า) บันทึกลง `2026-09-09_summary.md` และ `2026-09-09_patch.md`
- เปิดตัว Unified Tri-Hybrid Architecture & Dual-Tier Data Harvesting (ver.beta.5 - 2026-09-10T09:15:00+07:00):
  - รวมจุดเด่น 3 Patch: Dynamic Gating + Time-Decay (ver.beta.0.1), Anti-EMA Entanglement + Correlated Guard (ver.beta.3), และ Multi-Track Confluence 3 แทร็ก (ver.beta.4)
  - ติดตั้งระบบ **Dual-Tier Execution**:
    - **Tier 1 (Live MT5)**: เทรดจริงด้วย AI Confidence $\ge 0.52$ และผ่าน Guard ครบถ้วน เพื่อผลกำไรและ Win Rate สูงสุด
    - **Tier 2 (Shadow Paper Harvesting)**: บันทึกสัญญาณเกรด B/C (Confluence Score $\ge 55$) ลง `trade_results` เป็น `forex_shadow` พร้อมจำลองการชน TP/SL เสมือนแบบ Real-time เก็บข้อมูลตัวอย่าง ML ตลอด 24 ชม. โดยไร้ความเสี่ยง
  - ติดตั้ง **Macro DXY Directional Bias Calibration** ใน `services/forexFilter.js`: ปลดล็อกฝั่งตามเทรนด์ใหญ่ DXY ให้เข้าได้คล่องตัว ($\ge 55$) และคุมเข้มฝั่งสวนเทรนด์ ($\ge 70$ + Stoch Oversold) แก้ปัญหา BUY แพ้ซ้ำซาก
  - กระชับ **Fast Break-Even Lock** ใน `services/forexEngine.js`: ปรับเกณฑ์ขยับ SL สู่จุดคุ้มทุน ($+1.5$ pips) เร็วขึ้นเมื่อกำไรแตะ $+1.0 \times \text{ATR}$ พร้อมยิงคำสั่ง `modifyStopLoss` ไปยัง MT5
  - จัดสมดุล Correlated Currency Exposure Guard: เปิดใช้งานจริงพร้อมขยายเพดาน `FOREX_MAX_CORRELATED_EXPOSURE=2`
  - ปรับปรุงการตั้งค่าใน `.env` และ `.env.example`, สร้าง `2026-09-10_patch.md`, และอัปเดตประวัติใน `patch.md` เรียบร้อย
- เปิดตัว AI Model Versioning Registry & Smart HTF Pullback Limit Mode (ver.beta.5.1 - 2026-09-10T10:00:00+07:00):
  - สร้างระบบ **MLOps Model Registry** (`python/models/model_registry.json` และ `scripts/model_registry.py`):
    - ติดตามสเปกและพารามิเตอร์โมเดลอย่างเป็นระบบ (Dataset breakdown, Hyperparameters, Constituent weights, 13 features)
    - คำนวณ 10 Standard Classification Metrics ตามมาตรฐาน Scikit-Learn Model Evaluation & DataRockie
    - เพิ่มคำสั่งลัด Terminal: `npm run model:list`, `npm run model:compare`, `python scripts/model_registry.py --show <v>`, `--activate <v>`
    - เชื่อมต่อ Auto-Versioning เข้ากับ `npm run model:retrain` (`scripts/retrain_from_trade_results.py`) ปรับเวอร์ชันอัตโนมัติพร้อมบันทึกสเปกลง Registry
  - ติดตั้ง **Smart Adaptive HTF Pullback Limit Mode** ใน `services/forexEngine.js`:
    - เมื่อสัญญาณ M5 สวนทางเทรนด์ใหญ่ H1 (`h1TrendSlope`) บอทจะไม่แบนออเดอร์ (ป้องกันบอทกลัวที่จะเข้าเทรด) แต่จะเปลี่ยนโหมดเป็น `BUY_LIMIT` / `SELL_LIMIT` ที่แนวรับ M5 EMA9/EMA21 (ย่อลง 0.35 ATR) พร้อมเวลาหมดอายุ 45 นาที
    - สัญญาณตามเทรนด์ H1 ยังคงส่ง `Market Order` ทันที ป้องกันปัญหาตกรถ
  - แก้ไข **Duration Timezone Calculation (+420 นาที)** ใน `services/tradeResultTracker.js`:
    - ปรับเวลาเป็น `Asia/Bangkok` (`getBangkokDateTimeStr`) ให้ตรงกับ MySQL `timezone: '+07:00'` และคำนวณ `hold_duration_minutes` อย่างถูกต้องตรงตามความเป็นจริง
- เปิดตัว Crypto Decoupling & Autonomous Trading Engine (ver.beta.5.2 - 2026-09-10T10:40:00+07:00):
  - แยก Dataset ของ Crypto ออกจาก Forex 100%: สร้าง `scripts/fetch_crypto_binance_data.py` ดึงข้อมูล M5 จาก Binance Public REST API (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`) รวม 8,922 แถว จัดเก็บแยกที่ `data/dataset_crypto_m5.csv`
  - เทรนโมเดล Tri-Ensemble สำหรับ Crypto โดยเฉพาะ: สร้าง `scripts/train_crypto_m5_model.py` (LightGBM 40% + XGBoost 35% + Random Forest 25%) ได้ ROC-AUC BUY 79.8% และ SELL 77.5% จัดเก็บที่ `python/models/crypto_m5_model.joblib`
  - สร้าง `python/models/crypto_model_registry.json` และปรับปรุง `scripts/model_registry.py` ให้รองรับคำสั่ง `npm run crypto:model:list`
  - ปลดล็อก 3 บั๊กใน `services/cryptoEngine.js`: แก้ Open-Bar Volume Trap (ตรวจแท่ง `bars[n-2]` ที่ปิดแล้ว), แก้ Bollinger Squeeze Paradox (ตรวจบีบตัวล่วงหน้า 1-3 แท่ง), และเพิ่ม 3 Confluence Tracks (Squeeze Expansion, Trend Rider, Pullback Dip)
  - ปรับปรุง `minSlBuffer` ป้องกัน MT5 XM Crypto Spread Rejection (Invalid stops) และต่อ Python AI Bridge (`predict_crypto_bridge.py`)
  - ทดสอบสดและส่งคำสั่งจริงบน MT5 สำเร็จ: **Ticket #2308080850 (SOLUSD SELL @ 101.43)** พร้อมระบบป้องกันเปิดไม้ซ้ำ (`ALREADY_OPEN`)
- ปลดล็อก DXY Stochastic Veto & CSM Gating (ver.beta.5.3 - 2026-09-10T20:15:00+07:00):
  - แก้ไขปัญหา DXY Veto ค้างสภาวะ BEARISH บล็อคคู่เงินหลัก 7 คู่ให้กลายเป็น Score: 0/100 ใน `services/forexFilter.js`
  - ผ่อนปรน CSM Gating ให้ไม้ที่ AI Confidence >= 70% ผ่านเข้าเทรดได้ใน `services/forexEngine.js`
  - เปิดออเดอร์สดสำเร็จบน MT5 ทันที: **Ticket #2309023320 (EURUSD SELL 0.01 @ 1.15998)**
  - Correlation Guard ทำงานสมบูรณ์แบบ (ป้องกันการเปิด GBPUSD SELL ซ้ำซ้อนกับ EURUSD)
- Retrain Forex M5 สำเร็จเป็น **Model `v1.2.0`** (2026-09-11T11:27:02+07:00) และถูกตั้งเป็น Active:
  - เก็บ archive ที่ `python/models/versions/forex_m5_model_v1.2.0.joblib`; โมเดลใช้งานจริงอยู่ที่ `python/models/forex_m5_model.joblib`
  - ใช้ข้อมูล 45,029 แถว: historical 44,559 แถว และ realized live trades 94 ไม้ (ถ่วงน้ำหนัก 5×)
  - Registry validation เทียบ `v1.1.0`: ROC-AUC BUY **79.71% → 81.14%**, SELL **79.75% → 82.36%**; Precision BUY **14.20% → 21.58%**, SELL **25.19% → 34.48%**; F0.5 BUY **0.1652 → 0.1987**, SELL **0.2905 → 0.3598**
  - Live verification ณ เวลาประเมิน: 96 ไม้ปิดแล้ว, Win Rate 40.62%, PF 0.47, Expectancy -4.62 pips/ไม้ — จึงยืนยันเฉพาะคุณภาพการจัดอันดับจาก validation ยังไม่ใช่หลักฐานว่า live strategy ทำกำไรได้แล้ว
- เพิ่มระบบ **Champion–Challenger Shadow Pairing** (2026-09-11): Champion `forex_champion / v1.2.0` ยังคงเป็นตัวเดียวที่ส่งคำสั่ง MT5; Challenger `forex_challenger / challenger-v1.0.0` ใช้ GradientBoosting แยกและบันทึกเป็น paper order เท่านั้น
  - Challenger train จาก `data/dataset_forex_m5.csv` เดิม 44,559 แถว: validation AUC BUY **0.8231**, SELL **0.8325**; artifact อยู่ที่ `python/models/forex_challenger_model.joblib`
  - เพิ่ม provenance fields ใน `trade_results`: `pair_id`, `model_source`, `model_version`, `strategy_version`, `config_hash`, `decision_mode`, `prediction_meta`; Champion/Challenger ใน scan เดียวกันใช้ `pair_id` เดียวกัน
  - Retrain Forex M5 สำเร็จเป็น **Model `v1.4.0`** และ Challenger เป็น **`challenger-v1.2.0`** (2026-09-15T08:40:00+07:00):
  - รวมข้อมูลประวัติ 44,559 แถว + Realized Live DB Trades 212 ไม้ (ถ่วงน้ำหนัก 5×) รวมทั้งสิ้น 45,619 ตัวอย่าง
  - Champion `v1.4.0`: ROC-AUC BUY 80.43%, SELL 80.29%, Recall BUY 43.23%, Recall SELL 90.04%
  - Challenger `challenger-v1.2.0`: Specificity BUY 98.02%, Precision BUY 23.18%, SELL F0.5 0.3309
  - อัปเดตไฟล์โมเดลและ `.env` เป็น `FOREX_MODEL_VERSION=v1.4.0` และ `FOREX_CHALLENGER_MODEL_VERSION=challenger-v1.2.0`
- ติดตั้งระบบ **Multi-Tier Profit Ratchet & Momentum Stall Harvester** ใน `services/forexEngine.js` (2026-09-15):
  - **Tier 1 (50% TP / 1.0 ATR)**: ล็อก Break-Even $+1.5$ pips ทันที
  - **Tier 2 (70% TP)**: ล็อกกำไรขั้นบันได $+50\%$ ของ TP ป้องกันการปล่อยให้กำไรไหลกลับ
  - **Tier 3 (85% TP)**: ล็อกกำไร $+70\%$ ของ TP
  - **Momentum Stall Harvester**: ตรวจจับกราฟที่วิ่งแตะ $\ge 70\%$ TP แต่ยืนนิ่งค้าง $\ge 15$ นาทีและเริ่มหมดแรงย่อตัว $\ge 0.30 \times \text{ATR}$ บอทจะสั่งปิด Market Order เก็บกำไรทันที (`CLOSED_STALL_HARVEST`)
  - **One-Way Ratchet Rule**: บังคับ SL เลื่อนไปในทิศทางกำไรได้อย่างเดียว ห้าม Time-Decay ดึง SL ถอยหลังไปในแดนลบ
  - รองรับทั้ง Live MT5 Execution และ Shadow Paper Harvesting 100% โดยไม่กระทบ Dataset หรือโครงสร้างฟีเจอร์เดิม

- ปรับโหมดการทำงานสู่ **Full Autonomous Demo Exploration Mode** ตามข้อกำหนดใน [AGENT.md](file:///C:/xampp/htdocs/trade_bot/AGENT.md) (2026-09-15):
  - บันทึกข้อตกลงว่าระบบทำงานบนบัญชี **XM MT5 Demo** จึงอนุญาตให้ AI ออกออเดอร์ได้อย่างอิสระเต็มที่โดยไม่ต้องกังวลเรื่องเงินทุนจริง
  - ปลดล็อค/ผ่อนปรน Guard ใน `.env` (`FOREX_CORRELATED_GUARD_ENABLED=false`, `FOREX_SESSION_GUARD_ENABLED=false`, `FOREX_CONFIDENCE_THRESHOLD=0.45`, `FOREX_REJECTION_FILTER_ENABLED=false`) เพื่อให้โมเดล AI ได้เก็บข้อมูลดิบและเรียนรู้จากสภาวะตลาดจริง 24 ชม.
  - รักษาความสมบูรณ์ของ Dataset ประวัติศาสตร์เดิม (`dataset_forex_m5.csv` และ `dataset_crypto_m5.csv`) ให้คงเดิม 100% โดยการบันทึกผลเทรดจริงจะนำไป Retrain ร่วมกันได้ทันทีแบบไม่มีข้อขัดแย้ง

- เปิดใช้งาน **Forex Ultra-Short Micro-Scalper (0.5 – 1.5 Pips Quick Grab)** (2026-09-15T12:47:00+07:00):
  - **ลดระยะเป้าหมาย TP/SL ให้สั้นกระชับ**:
    - คู่ Major (EURUSD, GBPUSD, etc.): TP เหลือ **2.0 pips** (เน็ต $+1.2$ pips หลัง Spread) และ SL **4.0 pips**
    - คู่ JPY (EURJPY, GBPJPY, etc.): TP เหลือ **3.5 pips** (เน็ต $+2.0$ pips หลัง Spread) และ SL **6.0 pips**
  - **ติดตั้ง Instant Micro-Scalp Harvester (`CLOSED_MICRO_SCALP`)**: ปิดรวบกำไรที่ราคาตลาดทันทีเมื่อกำไรแตะ $+1.0$ pip (Major) / $+1.8$ pips (JPY)
  - **ติดตั้ง Ultra-Fast Break-Even Lock**: เลื่อน SL ล็อกทุน $+0.2$ pips ทันทีเมื่อกำไรแตะ $+0.5$ pips
  - **ติดตั้ง Step-Down Fast Exit (`CLOSED_STEPDOWN_PROFIT`)**: ถือครบ 10 นาทีแล้วกำไรเป็นบวก $\ge +0.4$ pips สั่งปิดล็อกกำไรทันที
  - อัปเดตทั้ง Live MT5 Execution และ Shadow Paper Harvesting ใน `services/forexEngine.js` และ `.env` โดยไม่มีผลกระทบต่อ Dataset ชุดเดิม

### 5. ⏳ งานที่ยังค้าง (Pending Tasks)
- [ ] สังเกตการณ์สถานะไม้ EURUSD (#2309023320), SOLUSD (#2308080850) และ AMD (#2305979154) บน MT5
- [ ] ติดตามผลการทำงานของ Break-Even Lock บน MT5 Terminal เมื่อราคาขยายกำไร
- [ ] สังเกตการณ์การสแกนและส่งคำสั่งใหม่ของ Forex และ Crypto ตลอดช่วงคืนนี้
- [ ] สะสมผล Champion/Challenger Shadow อย่างน้อย 100–200 closed pairs ก่อนตัดสินใจ promote Challenger
- [ ] ก่อน retrain รอบถัดไป ให้กรอง/แก้การบันทึก BTCUSD/ETHUSD ที่ปะปนใน `market_type='forex'`

### 6. ⚠️ ปัญหาหรือข้อจำกัด (Issues & Constraints)
- ในช่วงเช้า (Asian Session 09:00–13:30 น.) ตลาด Forex มักอยู่ในสภาวะ Sideway การที่บอทยังไม่เปิดออเดอร์จริงใน 1–2 ชม. แรกถือเป็นพฤติกรรมปกติของตัวกรอง Anti-Entanglement และ Dynamic Gating ที่ช่วยปกป้องทุน
- สำหรับตลาด Crypto ค่า Spread ของโบรกเกอร์ MT5 (XM) ค่อนข้างกว้างกว่าปกติ (เช่น SOLUSD spread ~66 points = $0.66) จึงจำเป็นต้องตั้ง `minSlBuffer` ไม่ต่ำกว่า $1.50 เพื่อป้องกันไม่ให้คำสั่งถูกปฏิเสธด้วยรหัส 10016 (Invalid stops)
# 📍 Checkpoint — Freqtrade-to-XM MT5 bridge (2026-09-12)

### 1. 🎯 เป้าหมายหลัก (Core Goals)
- รับ signal จาก Freqtrade/strategy ภายนอกเข้า Node runtime แล้วส่งคำสั่งผ่าน MT5/XM แบบควบคุมความเสี่ยงได้

### 2. 📌 ข้อกำหนดสำคัญ (Key Requirements)
- รองรับเฉพาะ `XAUUSD`, `EURUSD`, `BTCUSD`; เก็บแหล่งที่มาด้วย `source_tag = 'freqtrade_mt5'` ในทุกตารางที่เกี่ยวข้อง
- ต้องใช้ bearer token และการส่งคำสั่งจริงเป็น opt-in ด้วย `FREQTRADE_MT5_EXECUTION_ENABLED=true`

### 3. ⚖️ การตัดสินใจที่ผ่านมา (Past Decisions)
- ใช้ REST signal bridge แยกจาก endpoint manual order เดิม เพื่อรักษา authentication และ audit trail เป็นอิสระ
- เริ่มเป็น Shadow mode เสมอ; ป้องกันการเพิ่ม exposure หาก DB หรือ MT5 มี position ของ underlying เดียวกันอยู่

### 4. ✅ งานที่เสร็จแล้ว (Completed Work)
- เพิ่ม `services/freqtradeMt5Bridge.js`, API status/signal, schema migration และ XM alias `XAUUSD → GOLD`
- migration และ MySQL connection test ผ่าน; JavaScript/Python syntax checks ผ่าน

### 5. ⏳ งานที่ยังค้าง (Pending Tasks)
- ตั้ง webhook token ใน `.env`, ทดสอบ signal แบบ Shadow จาก Freqtrade strategy, แล้วจึงทดสอบ MT5 demo ก่อนเปิด execution จริง

### 6. ⚠️ ปัญหาหรือข้อจำกัด (Issues & Constraints)
- Freqtrade เองเป็น crypto framework; signal สำหรับ XAUUSD/EURUSD ต้องมาจาก strategy/producer ภายนอก ไม่ใช่ Freqtrade exchange adapter โดยตรง
- ห้ามเปิด `FREQTRADE_MT5_EXECUTION_ENABLED` บัญชีจริงก่อนทดสอบ broker symbol, lot step, SL/TP และ webhook authentication บน demo
