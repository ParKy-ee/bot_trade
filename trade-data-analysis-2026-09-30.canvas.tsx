import {
  BarChart,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

const snapshot = "30 ก.ย. 2026 เวลา 09:07 (Asia/Bangkok)";
const source = "Source: trading_bot.trade_results · valid closed trades · PnL ใช้ profit_loss";

const market7d = [
  ["Crypto · LIVE", "120", "120", "44 / 76", "36.7%", "-$10.80", "-$0.09", "0.78", "-258.1"],
  ["Forex · LIVE", "428", "418", "122 / 296", "29.2%", "-$142.06", "-$0.34", "0.24", "-1,527.3"],
  ["Forex · SHADOW", "2,333", "2,322", "909 / 1,413", "39.1%", "-$291.45", "-$0.13", "0.55", "-402.5"],
  ["Gold · LIVE", "57", "57", "31 / 26", "54.4%", "-$34.22", "-$0.60", "0.83", "-324.7"],
];

const dailyDates = ["23 ก.ย.", "24 ก.ย.", "25 ก.ย.", "26 ก.ย.", "27 ก.ย.", "28 ก.ย.", "29 ก.ย.", "30 ก.ย.*"];
const dailyOrders = [
  { name: "LIVE · all markets", data: [81, 159, 203, 0, 0, 76, 69, 17], tone: "info" as const },
  { name: "SHADOW · Forex", data: [125, 414, 669, 0, 0, 363, 568, 194], tone: "neutral" as const },
];
const dailyPnl = [
  { name: "Forex · LIVE", data: [-23.50, -27.73, -71.21, -14.21, 0, -10.10, -3.12, 0], tone: "danger" as const },
  { name: "Crypto · LIVE", data: [4.43, -11.14, -1.70, 0, 0, -3.80, 12.35, -5.67], tone: "info" as const },
  { name: "Gold · LIVE", data: [3.22, -33.63, -11.43, 8.63, 0, -8.54, 1.12, 3.19], tone: "success" as const },
];

const liveStrategyRows = [
  ["Crypto", "v2.1.0", "84", "32 / 52", "38.1%", "-$2.23", "-$0.03", "0.93"],
  ["Crypto", "v2.0.0", "32", "12 / 20", "37.5%", "-$5.38", "-$0.17", "0.62"],
  ["Forex", "challenger-v1.7.0", "297", "94 / 203", "31.6%", "-$101.24", "-$0.34", "0.27"],
  ["Forex", "challenger-v1.10.0", "81", "15 / 66", "18.5%", "-$33.29", "-$0.41", "0.13"],
  ["Forex", "challenger-v1.17.0", "40", "13 / 27", "32.5%", "-$7.53", "-$0.19", "0.23"],
  ["Gold", "gold-v1.0.0", "49", "26 / 23", "53.1%", "-$24.05", "-$0.49", "0.86"],
];

const forexPairRows = [
  ["USDCHF=X", "52", "12 / 40", "23.1%", "-$31.68", "-$0.61"],
  ["GBPUSD=X", "59", "18 / 41", "30.5%", "-$18.73", "-$0.32"],
  ["AUDUSD=X", "38", "8 / 30", "21.1%", "-$17.36", "-$0.46"],
  ["NZDUSD=X", "45", "9 / 36", "20.0%", "-$16.28", "-$0.36"],
  ["USDCAD=X", "46", "9 / 37", "19.6%", "-$13.73", "-$0.30"],
];

const shadowStrategyRows = [
  ["Pocket Explore", "challenger-v1.17.0", "702", "286 / 416", "40.7%", "-$87.53", "-$0.12", "0.57"],
  ["Pocket Explore", "challenger-v1.7.0", "617", "246 / 371", "39.9%", "-$58.52", "-$0.09", "0.65"],
  ["Pocket Prod", "challenger-v1.7.0", "317", "130 / 187", "41.0%", "-$33.67", "-$0.11", "0.61"],
  ["Pocket Prod", "challenger-v1.17.0", "256", "103 / 153", "40.2%", "-$29.29", "-$0.11", "0.57"],
  ["Range Shadow", "range-v1.0.0", "225", "105 / 120", "46.7%", "-$23.82", "-$0.11", "0.52"],
  ["Pocket Explore", "challenger-v1.10.0", "78", "10 / 68", "12.8%", "-$22.84", "-$0.29", "0.18"],
  ["Pocket Prod", "challenger-v1.10.0", "72", "12 / 60", "16.7%", "-$22.31", "-$0.31", "0.21"],
  ["Challenger Shadow", "challenger-v1.7.0", "34", "13 / 21", "38.2%", "-$9.58", "-$0.28", "0.25"],
];

const goldSetupRows = [
  ["Trend Momentum · Bearish", "32", "18 / 14", "56.3%", "-$36.36"],
  ["Trend Momentum · Bullish", "24", "12 / 12", "50.0%", "-$11.15"],
  ["Pullback tag", "1", "1 / 0", "100.0%", "+$13.29"],
];

const confluenceRows = [
  ["Pocket Explore · v1.7", "40–49", "53", "25 / 28", "47.2%", "-$4.10", "0.68"],
  ["Pocket Explore · v1.7", "60–69", "120", "50 / 70", "41.7%", "-$6.45", "0.76"],
  ["Pocket Explore · v1.17", "70–79", "410", "172 / 238", "42.0%", "-$33.58", "0.68"],
  ["Pocket Prod · v1.17", "70–79", "145", "57 / 88", "39.3%", "-$13.40", "0.58"],
  ["Pocket Prod · v1.7", "80–89", "40", "16 / 24", "40.0%", "-$0.80", "0.93"],
];

const forexExitRows = [
  ["CLOSED_SL", "173", "25 / 148", "14.5%", "-$117.41"],
  ["CLOSED_TIME_STOP", "124", "8 / 116", "6.5%", "-$51.29"],
  ["CLOSED_MICRO_SCALP", "37", "36 / 1", "97.3%", "+$11.62"],
  ["CLOSED_TP", "30", "30 / 0", "100.0%", "+$24.70"],
  ["CLOSED_STEPDOWN_PROFIT", "23", "18 / 5", "78.3%", "+$3.24"],
  ["CLOSED_PRESSURE_EARLY_CUT", "19", "0 / 19", "0.0%", "-$10.71"],
  ["CLOSED_PRESSURE_PROFIT_LOCK", "9", "2 / 7", "22.2%", "-$2.60"],
];
const cryptoExitRows = [
  ["CLOSED_SL", "75", "25 / 50", "33.3%", "-$35.65"],
  ["CLOSED_TP", "8", "8 / 0", "100.0%", "+$27.26"],
  ["CLOSED_TIME_STOP", "14", "0 / 14", "0.0%", "-$2.48"],
  ["CLOSED_AI_TREND_EXIT", "8", "0 / 8", "0.0%", "-$6.25"],
  ["CLOSED_MT5", "11", "8 / 3", "72.7%", "+$2.65"],
];
const goldExitRows = [
  ["CLOSED_TIME_STOP", "27", "11 / 16", "40.7%", "-$32.87"],
  ["CLOSED_SL", "14", "6 / 8", "42.9%", "-$93.42"],
  ["CLOSED_MICRO_SCALP", "12", "11 / 1", "91.7%", "+$88.02"],
];

const last30Rows = [
  ["Crypto · LIVE", "987", "504 / 483", "51.1%", "-$161.96", "0.77"],
  ["Forex · LIVE", "2,742", "727 / 2,015", "26.5%", "-$772.77", "0.30"],
  ["Forex · SHADOW*", "7,583", "3,973 / 3,610", "52.4%", "-$305.73", "0.78"],
  ["Gold · LIVE", "137", "58 / 79", "42.3%", "-$398.32", "0.52"],
  ["US stocks · LIVE", "241", "126 / 115", "52.3%", "+$468.48", "3.94"],
];
const frequencyRows = [
  ["Forex · LIVE", "2,799", "17", "164.6"],
  ["Forex · SHADOW (mode label)", "6,830", "15", "455.3"],
  ["Crypto · LIVE", "987", "17", "58.1"],
  ["Gold · LIVE", "137", "11", "12.5"],
  ["US stocks · LIVE", "241", "5", "48.2"],
];

function ExitCard({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <Card>
      <CardHeader>{title}</CardHeader>
      <CardBody>
        <Table
          headers={["Exit reason", "N", "W / L", "Win rate", "Net USD"]}
          rows={rows}
          columnAlign={["left", "right", "right", "right", "right"]}
          striped
          stickyHeader
        />
      </CardBody>
    </Card>
  );
}

export default function TradeDataAnalysisReport() {
  const theme = useHostTheme();
  return (
    <Stack gap={22} style={{ padding: 24, maxWidth: 1380, margin: "0 auto", color: theme.text.primary }}>
      <Stack gap={6}>
        <H1>สถิติการเทรดและผลงานแต่ละท่า</H1>
        <Text tone="secondary">วิเคราะห์ข้อมูลปัจจุบันจากผลเทรดจริงและ shadow แยกตามตลาด, รุ่นโมเดล, setup, วิธีปิด และความถี่รายวัน</Text>
        <Text size="small" tone="tertiary">Snapshot: {snapshot} · ช่วงหลัก 7 วันย้อนหลัง · ช่วงเปรียบเทียบ 30 วันย้อนหลัง · {source}</Text>
      </Stack>

      <Grid columns={4} gap={14}>
        <Stat value="11,694" label="รายการปิดครบในฐานข้อมูล" tone="info" />
        <Stat value="595" label="Live closes · 7 วัน" />
        <Stat value="33.1%" label="Live win rate · 197 ชนะ / 398 แพ้" tone="warning" />
        <Stat value="-$187.08" label="Live net PnL · 7 วัน (USD)" tone="warning" />
      </Grid>

      <Callout tone="warning" title="ภาพรวมที่เห็นชัด">
        <Text>Forex Live เป็นตัวขับการขาดทุนหลักใน 7 วัน: ปิด 418 ไม้ ชนะ 122 แพ้ 296, net -$142.06 และ PF 0.24. Crypto Live net -$10.80; Gold Live net -$34.22 แม้มี win rate 54.4% เพราะขนาดไม้ที่ขาดทุนกว่ากำไร. Forex Shadow เป็นผลจำลองแยกต่างหากและติดลบ -$291.45 จึงไม่รวมกับ Live.</Text>
      </Callout>

      <Stack gap={10}>
        <H2>ขั้นที่ 1 · ตรวจขอบเขตและคุณภาพข้อมูล</H2>
        <Table
          headers={["รายการ", "ผลตรวจ"]}
          rows={[
            ["ช่วงข้อมูลใน trade_results", "9 ก.ค. – 30 ก.ย. 2026 · 11,762 แถว ณ 09:07 น."],
            ["ผลปิดที่นำมาคำนวณ", "11,694 แถว มี exit price และ profit_loss ครบ"],
            ["ตัดออกจาก win/loss", "ไม่นับ OPEN, CLOSED_EXPIRED, CLOSED_HISTORICAL และแถวที่ไม่มีผลปิดครบ"],
            ["นิยาม Win / Loss", "ใช้ is_win ตามกติกาบอท; Live อิง net PnL, Shadow ต้องผ่านเกณฑ์ pips เพิ่ม"],
            ["นิยามกำไรและ PF", "Net USD ใช้ profit_loss; PF = ผลรวม PnL บวก ÷ ค่าสัมบูรณ์ของ PnL ลบ"],
          ]}
          columnAlign={["left", "left"]}
          striped
        />
      </Stack>

      <Stack gap={10}>
        <H2>ขั้นที่ 2 · ผลตามตลาดใน 7 วันล่าสุด</H2>
        <Table
          headers={["ตลาด / โหมด", "Orders", "Closed", "Wins / Losses", "Win rate", "Net USD", "เฉลี่ย / ไม้", "PF", "Net pips"]}
          rows={market7d}
          columnAlign={["left", "right", "right", "right", "right", "right", "right", "right", "right"]}
          striped
          stickyHeader
        />
        <Text size="small" tone="tertiary">Orders นับจาก entry_time; Closed ใช้เฉพาะผลปิดที่สมบูรณ์. Win rate ใช้ is_win ของบอท; PnL/PF คำนวณจาก profit_loss. Forex Shadow เป็น paper trades ไม่ใช่ผลเงินจริง. วันที่ 30 ก.ย. เป็นข้อมูลถึงเวลา snapshot.</Text>
      </Stack>

      <Grid columns={2} gap={16}>
        <Card size="lg">
          <CardHeader>จำนวนออเดอร์ใหม่ต่อวัน</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small" tone="tertiary">Y-axis: จำนวนออเดอร์ (ไม้) · X-axis: วันที่เปิดออเดอร์ (เวลา Bangkok)</Text>
              <BarChart categories={dailyDates} series={dailyOrders} height={250} style={{ width: "100%" }} />
              <Text size="small" tone="tertiary">Source: trade_results · entry rows ต่อวัน · 7 วันย้อนหลังถึง {snapshot}. *30 ก.ย. เป็นข้อมูลถึงเวลา snapshot.</Text>
            </Stack>
          </CardBody>
        </Card>
        <Card size="lg">
          <CardHeader>Net PnL ต่อวัน แยกตามตลาด</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small" tone="tertiary">Y-axis: realized net PnL (USD) · X-axis: วันที่ปิดออเดอร์ (เวลา Bangkok)</Text>
              <BarChart categories={dailyDates} series={dailyPnl} height={250} style={{ width: "100%" }} />
              <Text size="small" tone="tertiary">Source: trade_results · รวม profit_loss ตาม exit_time ใน 7 วันย้อนหลัง. วันที่ไม่มีรายการแสดงเป็น 0; 30 ก.ย. ยังไม่ครบวัน. Shadow แยกแสดงในแผงจำนวนออเดอร์ ไม่รวมเป็นเงินจริงในกราฟนี้.</Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Stack gap={10}>
        <H2>ขั้นที่ 3 · ท่าเข้า / รุ่นโมเดลที่ชนะหรือแพ้เด่น</H2>
        <Text tone="secondary">ใช้ decision_mode + model_version เป็นกลุ่ม “ท่า/เลน” เพราะ Forex ในช่วงนี้ใช้ strategy_version = ver.beta.6.0 เหมือนกัน. Win/Loss ใช้ is_win ตามนิยามของบอท; ค่าเฉลี่ย/ไม้ = net USD ÷ closed trades. ใช้ N ≥ 30 เป็นเกณฑ์ชี้กลุ่มเด่น.</Text>
        <H3>Live entries · จำนวนปิดอย่างน้อย 30 ไม้</H3>
        <Table
          headers={["ตลาด", "Model version", "Closed", "W / L", "Win rate", "Net USD", "เฉลี่ย / ไม้", "PF"]}
          rows={liveStrategyRows}
          columnAlign={["left", "left", "right", "right", "right", "right", "right", "right"]}
          striped
          stickyHeader
        />
        <Callout tone="warning" title="Forex Live: แพ้มากกว่าชนะทุก version ที่มีตัวอย่างพอ">
          <Text>challenger-v1.10.0 อ่อนสุดตาม win rate ในกลุ่ม Live ที่มีตัวอย่างพอ: แพ้ 66 จาก 81 ไม้, win 18.5%, PF 0.13 และเฉลี่ย -$0.41/ไม้. v1.7.0 สร้าง net loss รวมมากสุด (-$101.24) จาก 297 ไม้. v1.17.0 ขาดทุนต่อไม้น้อยกว่าแต่ยังติดลบ (-$0.19/ไม้; N=40).</Text>
        </Callout>
        <H3>Forex Live · คู่เงินที่ขาดทุนสุทธิสูงสุด</H3>
        <Table
          headers={["คู่เงิน", "Closed", "W / L", "Win rate", "Net USD", "เฉลี่ย / ไม้"]}
          rows={forexPairRows}
          columnAlign={["left", "right", "right", "right", "right", "right"]}
          striped
        />
        <Text size="small" tone="tertiary">ทั้ง 9 คู่ Forex Live ที่มีอย่างน้อย 5 ไม้ปิดเป็น net ติดลบในสัปดาห์นี้. ใน Crypto, SOLUSD แพ้ 17/17 ไม้ (-$7.05); BTCUSD และ ETHUSD ก็ยังติดลบเล็กน้อย.</Text>
        <H3>Forex Shadow lanes · ผลจำลอง</H3>
        <Table
          headers={["Lane", "Model version", "Closed", "W / L", "Win rate", "Net USD", "เฉลี่ย / ไม้", "PF"]}
          rows={shadowStrategyRows}
          columnAlign={["left", "left", "right", "right", "right", "right", "right", "right"]}
          striped
          stickyHeader
        />
        <Text size="small" tone="tertiary">กลุ่มต่ำกว่า 30 closes ที่ไม่ใช้สรุปว่าเด่น: Crypto v2.2.0 มี 4 closes, Gold v1.1.0 มี 8 และ Challenger Shadow v1.10.0 มี 21.</Text>
      </Stack>

      <Grid columns={2} gap={16}>
        <Stack gap={10}>
          <H2>Setup ที่บันทึกไว้ใน Gold</H2>
          <Table
            headers={["Setup", "N", "W / L", "Win rate", "Net USD"]}
            rows={goldSetupRows}
            columnAlign={["left", "right", "right", "right", "right"]}
            striped
          />
          <Callout tone="info" title="Win rate สูงไม่ได้แปลว่ากำไรสุทธิเป็นบวก">
            <Text>Gold Trend Momentum ฝั่ง Bearish ชนะ 56.3% แต่ net -$36.36; ฝั่ง Bullish ชนะ 50.0% แต่ net -$11.15. Pullback tag มีเพียง 1 ไม้ จึงยังสรุปไม่ได้.</Text>
          </Callout>
        </Stack>
        <Stack gap={10}>
          <H2>Forex Shadow · Confluence ที่บันทึกในเหตุผล</H2>
          <Table
            headers={["Lane / รุ่น", "Score", "N", "W / L", "Win rate", "Net USD", "PF"]}
            rows={confluenceRows}
            columnAlign={["left", "center", "right", "right", "right", "right", "right"]}
            striped
          />
          <Text size="small" tone="tertiary">แสดง bucket ที่มีอย่างน้อย 30 closes; ทุกกลุ่มในตารางยัง net ติดลบ และคะแนนสูงไม่ได้แปลว่ากำไรสูงขึ้นเป็นลำดับ. Pocket Explore v1.7 score 60–69 มี app win 41.7% แต่ net -$6.45.</Text>
        </Stack>
      </Grid>

      <Stack gap={10}>
        <H2>ขั้นที่ 4 · วิธีปิดออเดอร์ที่สัมพันธ์กับผลชัด</H2>
        <Grid columns={3} gap={14}>
          <ExitCard title="Forex · LIVE" rows={forexExitRows} />
          <ExitCard title="Crypto · LIVE" rows={cryptoExitRows} />
          <ExitCard title="Gold · LIVE" rows={goldExitRows} />
        </Grid>
        <Text size="small" tone="tertiary">แสดง exit reason ที่มีอย่างน้อย 8 closes; counts และ win rate ใช้ is_win ส่วน Net USD ใช้ profit_loss.</Text>
        <Callout tone="info" title="อ่าน Exit reason แบบพรรณนา ไม่ใช่เหตุและผล">
          <Text>Forex SL และ Time Stop รวมกัน 297 จาก 418 closes และขาดทุนรวม -$168.70; Micro Scalp, TP และ Stepdown รวมกำไร +$39.56. Crypto SL ขาดทุน -$35.65 เทียบ TP +$27.26. Gold SL ขาดทุน -$93.42 ขณะที่ Micro Scalp บวก +$88.02. เป็นความสัมพันธ์เชิงพรรณนา ไม่พิสูจน์ว่าการเปลี่ยนกฎออกไม้จะให้ผลแบบเดิม.</Text>
        </Callout>
      </Stack>

      <Grid columns={2} gap={16}>
        <Stack gap={10}>
          <H2>ขั้นที่ 5 · ภาพรวม 30 วัน</H2>
          <Table
            headers={["ตลาด / โหมด", "Closed", "W / L", "Win rate", "Net USD", "PF"]}
            rows={last30Rows}
            columnAlign={["left", "right", "right", "right", "right", "right"]}
            striped
          />
          <Text size="small" tone="tertiary">US stocks เป็นตลาดเดียวที่ net บวกในช่วง 30 วัน (+$468.48, PF 3.94) แต่ไม่มีรายการเข้าในช่วง 7 วันล่าสุด. *Forex Shadow มี 764 แถวที่ decision_mode ระบุ LIVE จึงต้องอ่านควบคู่กับหมายเหตุคุณภาพข้อมูล.</Text>
        </Stack>
        <Stack gap={10}>
          <H2>จำนวนออเดอร์เฉลี่ยต่อวันทำการของบอท</H2>
          <Table
            headers={["ตลาด / โหมด", "Orders · 30d", "วันที่มีออเดอร์", "Orders / วัน active"]}
            rows={frequencyRows}
            columnAlign={["left", "right", "right", "right"]}
            striped
          />
          <Text size="small" tone="tertiary">ตัวหารคือจำนวนวันปฏิทินที่มีออเดอร์อย่างน้อยหนึ่งรายการ ไม่ใช่ 30 วันเต็ม. Shadow มีหลาย lane จึงมีจำนวน order มากกว่า live.</Text>
        </Stack>
      </Grid>

      <Stack gap={10}>
        <H2>ขั้นที่ 6 · ข้อสังเกตด้านคุณภาพป้ายกำกับ</H2>
        <Callout tone="info" title="Shadow win flag ไม่เท่ากับ PnL บวกทุกกรณี">
          <Text>ใน Shadow บอทตั้งเกณฑ์ win เพิ่มจากกำไร: อย่างน้อย 1.8 pips สำหรับคู่หลัก หรือ 2.5 pips สำหรับ JPY. ช่วง 7 วันมี 909 ไม้ที่ is_win=1 แต่ 976 ไม้ที่ profit_loss เป็นบวก (ต่าง 67 ไม้ที่บวกน้อยกว่าเกณฑ์). รายงานจึงใช้ is_win ทำ win rate และ profit_loss ทำกำไร/PF แยกกัน.</Text>
        </Callout>
        <Callout tone="info" title="Shadow ไม่มีรายละเอียดต้นทุนโบรกเกอร์">
          <Text>ออเดอร์ Forex Shadow ทั้ง 2,322 ไม้ไม่มี gross_profit / commission / swap / fee แยกในฐานข้อมูล. PnL ของ Shadow เป็นค่าจำลอง จึงใช้ดูแนวโน้มภายในได้ แต่ไม่ควรตีความเป็นกำไรเงินจริงหรือเทียบตรงกับ Live.</Text>
        </Callout>
        <Callout tone="warning" title="มี 764 แถวใน Forex Shadow ที่ decision_mode ระบุเป็น LIVE">
          <Text>ในช่วง 30 วันมี 764 records ที่ market_type = forex_shadow แต่ decision_mode = LIVE (10–11 ก.ย.; net -$27.27). รายงานนี้ไม่ย้ายแถวเหล่านี้ไปปนกับ Live จริง. ใน 7 วันล่าสุดไม่พบความขัดแย้งนี้; ควรตรวจ label ต้นทางก่อนใช้การแบ่ง Live/Shadow อัตโนมัติ.</Text>
        </Callout>
        <Table
          headers={["ขั้นวิเคราะห์", "เกณฑ์ที่ใช้"]}
          rows={[
            ["1 · ตรวจข้อมูล", "ตัด OPEN, CLOSED_EXPIRED, CLOSED_HISTORICAL และแถวที่ไม่มี exit price หรือ PnL"],
            ["2 · แยกผล", "แยกตลาด Live และ Shadow ก่อนคำนวณ win/loss, win rate, PnL, pips และ PF"],
            ["3 · หา entry tactic", "เทียบ decision_mode / model_version; ใช้ชื่อ setup ของ Gold และ confluence ของ Forex Shadow เมื่อมี"],
            ["4 · หา exit pattern", "จัดกลุ่มด้วย exit_reason แล้วดูจำนวนไม้, W/L และ net USD"],
            ["5 · วัดความถี่", "นับ entry ต่อวัน และคำนวณ orders ต่อวันที่มีรายการใน 30 วัน"],
          ]}
          columnAlign={["left", "left"]}
          striped
        />
        <Row gap={8} align="center" wrap>
          <Pill size="sm" tone="info">เกณฑ์ highlight: ≥30 closes</Pill>
          <Text size="small" tone="tertiary">สรุปนี้เป็น descriptive analysis จากประวัติที่ผ่านมา; จำนวนไม้และสภาพตลาดต่างกัน จึงยังไม่ใช่การทดสอบยืนยันหรือคำสั่งให้เปลี่ยน config.</Text>
        </Row>
      </Stack>
    </Stack>
  );
}
