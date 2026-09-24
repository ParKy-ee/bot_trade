import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Grid,
  H1,
  H2,
  H3,
  LineChart,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

type VersionPoint = {
  version: string;
  date: string;
  samples: number;
  live?: number;
  observations?: number;
  aucBuy: number;
  aucSell: number;
  prBuy: number;
  prSell: number;
};

type ModelCardProps = {
  name: string;
  market: string;
  active: string;
  description: string;
  sampleLabel: string;
  points: VersionPoint[];
  note: string;
  noteTone: "success" | "warning" | "info";
};

const reportRange = "14–18 ก.ย. 2026 (version ที่มีใน registry)";
const source = "Source: python/models/*_registry.json";

const champion: VersionPoint[] = [
  { version: "v1.3.0", date: "14 ก.ย.", samples: 45529, live: 194, aucBuy: 0.7812, aucSell: 0.8071, prBuy: 0.1604, prSell: 0.3197 },
  { version: "v1.4.0", date: "15 ก.ย.", samples: 45619, live: 212, aucBuy: 0.78, aucSell: 0.803, prBuy: 0.1608, prSell: 0.3219 },
  { version: "v1.5.0", date: "17 ก.ย.", samples: 50169, live: 308, observations: 814, aucBuy: 0.7032, aucSell: 0.7441, prBuy: 0.1575, prSell: 0.2684 },
  { version: "v1.6.0", date: "17 ก.ย.", samples: 57094, live: 683, observations: 1824, aucBuy: 0.7236, aucSell: 0.6768, prBuy: 0.196, prSell: 0.163 },
];

const crypto: VersionPoint[] = [
  { version: "v1.0.0", date: "15 ก.ย.", samples: 8922, aucBuy: 0.7984, aucSell: 0.7748, prBuy: 0.2315, prSell: 0.2601 },
  { version: "v1.1.0", date: "16 ก.ย.", samples: 11107, live: 437, aucBuy: 0.6193, aucSell: 0.657, prBuy: 0.4124, prSell: 0.3443 },
  { version: "v1.2.0", date: "17 ก.ย.", samples: 11562, live: 528, aucBuy: 0.7586, aucSell: 0.9123, prBuy: 0.6382, prSell: 0.789 },
];

const challenger: VersionPoint[] = [
  { version: "challenger-v1.7.0", date: "18 ก.ย.", samples: 80529, live: 1152, observations: 4082, aucBuy: 0.8122, aucSell: 0.7838, prBuy: 0.2959, prSell: 0.2665 },
];

const rangeModel: VersionPoint[] = [
  { version: "range-v1.0.0", date: "15 ก.ย.", samples: 8853, aucBuy: 0.5223, aucSell: 0.5324, prBuy: 0.3926, prSell: 0.4326 },
];

function MetricChart({
  title,
  categories,
  series,
  suffix,
  yAxis,
  xAxis,
}: {
  title: string;
  categories: string[];
  series: { name: string; data: number[]; tone?: "success" | "danger" | "warning" | "info" | "neutral" }[];
  suffix?: string;
  yAxis: string;
  xAxis: string;
}) {
  const theme = useHostTheme();
  return (
    <Stack gap={4} style={{ minWidth: 0 }}>
      <Text weight="semibold">{title}</Text>
      <Text size="small" tone="tertiary">Y-axis: {yAxis}</Text>
      <LineChart categories={categories} series={series} height={190} valueSuffix={suffix} style={{ width: "100%", color: theme.text.secondary }} />
      <Text size="small" tone="tertiary" style={{ textAlign: "center" }}>X-axis: {xAxis}</Text>
    </Stack>
  );
}

function ModelCard({ name, market, active, description, sampleLabel, points, note, noteTone }: ModelCardProps) {
  const categories = points.map((point) => `${point.version} (${point.date})`);
  const singlePoint = points.length === 1;
  return (
    <Card size="lg">
      <CardHeader trailing={<Pill size="sm" tone={singlePoint ? "warning" : "success"} active>{active}</Pill>}>{name}</CardHeader>
      <CardBody>
        <Stack gap={12}>
          <Row gap={8} align="center" wrap>
            <Pill size="sm" tone="info">{market}</Pill>
            <Text size="small" tone="secondary">{description}</Text>
          </Row>
          <Grid columns={2} gap={18}>
            <MetricChart title={`การเติบโตของข้อมูล — ${name}`} categories={categories} yAxis={sampleLabel} xAxis="Model version ตามลำดับเวลา" series={[{ name: sampleLabel, data: points.map((point) => point.samples), tone: "info" }]} />
            <MetricChart
              title={`คุณภาพการจำแนก — ${name}`}
              categories={categories}
              yAxis="ROC-AUC (%)"
              xAxis="Model version ตามลำดับเวลา"
              suffix="%"
              series={[
                { name: "Buy ROC-AUC", data: points.map((point) => Number((point.aucBuy * 100).toFixed(1))), tone: "success" },
                { name: "Sell ROC-AUC", data: points.map((point) => Number((point.aucSell * 100).toFixed(1))), tone: "warning" },
              ]}
            />
          </Grid>
          <Callout tone={noteTone} title={singlePoint ? "ยังไม่มีเส้นแนวโน้มหลาย version" : "อ่านแนวโน้ม"}>
            <Text size="small">{note}</Text>
          </Callout>
          <Text size="small" tone="tertiary">{source} · ช่วงข้อมูล: {reportRange}</Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

const releaseRows = [
  ["จันทร์ 14 ก.ย.", "Forex Champion", "v1.3.0", "45,529 samples · 194 live trades"],
  ["อังคาร 15 ก.ย.", "Champion · Range · Crypto", "v1.4.0 · range-v1.0.0 · v1.0.0", "เริ่มสาย Range และ Crypto โดยเฉพาะ"],
  ["พุธ 16 ก.ย.", "Crypto", "v1.1.0", "11,107 samples · 437 trade results"],
  ["พฤหัส 17 ก.ย.", "Champion · Crypto", "v1.5.0 · v1.6.0 · v1.2.0", "เพิ่ม observations 814 → 1,824 และ Crypto 11,562 samples"],
  ["ศุกร์ 18 ก.ย.", "Forex Challenger", "challenger-v1.7.0", "80,529 total samples · 1,152 live/shadow trades · 4,082 observations"],
];

const detailRows = [
  ["14 ก.ย.", "Forex Champion", "v1.3.0", "45,529", "78.1% / 80.7%", "16.0% / 32.0%"],
  ["15 ก.ย.", "Forex Champion", "v1.4.0", "45,619", "78.0% / 80.3%", "16.1% / 32.2%"],
  ["15 ก.ย.", "Forex Range", "range-v1.0.0", "8,853", "52.2% / 53.2%", "39.3% / 43.3%"],
  ["15 ก.ย.", "Crypto", "v1.0.0", "8,922", "79.8% / 77.5%", "23.2% / 26.0%"],
  ["16 ก.ย.", "Crypto", "v1.1.0", "11,107", "61.9% / 65.7%", "41.2% / 34.4%"],
  ["17 ก.ย.", "Forex Champion", "v1.5.0", "50,169", "70.3% / 74.4%", "15.8% / 26.8%"],
  ["17 ก.ย.", "Forex Champion", "v1.6.0", "57,094", "72.4% / 67.7%", "19.6% / 16.3%"],
  ["17 ก.ย.", "Crypto", "v1.2.0", "11,562", "75.9% / 91.2%", "63.8% / 78.9%"],
  ["18 ก.ย.", "Forex Challenger", "challenger-v1.7.0", "80,529", "81.2% / 78.4%", "29.6% / 26.7%"],
];

export default function ModelGrowthWeekReport() {
  const theme = useHostTheme();
  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1240, margin: "0 auto", color: theme.text.primary }}>
      <Stack gap={6}>
        <H1>สรุปการพัฒนา Model ประจำสัปดาห์</H1>
        <Text tone="secondary">ติดตามตั้งแต่วันจันทร์ 14 ก.ย. ถึง version ล่าสุดที่ถูกสร้างใน registry วันศุกร์ 18 ก.ย. 2026</Text>
        <Text size="small" tone="tertiary">{source} · เวลาใน registry แสดงตาม timestamp ของระบบ · รายงานจัดทำวันที่ 20 ก.ย. 2026</Text>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat value="9" label="versions ที่สร้างในช่วงนี้" tone="info" />
        <Stat value="4" label="สายโมเดลที่ถูกพัฒนา" />
        <Stat value="+25.4%" label="Champion samples: v1.3 → v1.6" tone="success" />
        <Stat value="+29.6%" label="Crypto samples: v1.0 → v1.2" tone="success" />
      </Grid>

      <Callout tone="info" title="ภาพรวมสั้น ๆ">
        <Text>สัปดาห์นี้มีการเพิ่ม version ต่อเนื่อง 5 วัน: Champion ถูก retrain หลายรอบและขยายข้อมูลจาก 45,529 เป็น 57,094 samples, Crypto พัฒนาจาก baseline ไปถึง v1.2.0, ขณะที่ Challenger v1.7.0 มี dataset ใหญ่ที่สุด 80,529 samples. จุดที่ต้องตรวจต่อคือ Champion Sell ROC-AUC ลดลงถึง 13.0 percentage points แม้ข้อมูลเพิ่มขึ้น และ Range ยังมีเพียง baseline เดียว.</Text>
      </Callout>

      <Stack gap={10}>
        <H2>Release timeline</H2>
        <Card>
          <CardBody>
            <Stack gap={12}>
              {releaseRows.map(([date, model, version, detail]) => (
                <Row key={`${date}-${version}`} gap={12} align="start" style={{ borderBottom: `1px solid ${theme.stroke.tertiary}`, paddingBottom: 10 }}>
                  <Text weight="semibold" style={{ width: 108, flexShrink: 0 }}>{date}</Text>
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Row gap={8} align="center" wrap>
                      <Text weight="semibold">{model}</Text>
                      <Pill size="sm" tone="info">{version}</Pill>
                    </Row>
                    <Text size="small" tone="secondary">{detail}</Text>
                  </Stack>
                </Row>
              ))}
            </Stack>
          </CardBody>
        </Card>
      </Stack>

      <Stack gap={10}>
        <H2>กราฟเส้นการเติบโตแยกตาม Model</H2>
        <Text tone="secondary">กราฟซ้ายวัดขนาดข้อมูลที่ใช้ train/eligible ส่วนกราฟขวาวัด ROC-AUC ของ Buy และ Sell; version เรียงตาม created_at.</Text>
        <Grid columns={2} gap={16}>
          <ModelCard name="Forex Champion" market="Forex · Live candidate" active="active registry: v1.6.0" description="Tri-Ensemble: LightGBM + XGBoost + CatBoost + Random Forest" sampleLabel="Total samples" points={champion} note="จำนวนข้อมูลโต 25.4% และ live trades โตจาก 194 เป็น 683 (+252.1%). อย่างไรก็ดี ROC-AUC Sell ลดจาก 80.7% เป็น 67.7% จึงควรแยกตรวจผลตาม regime และทำ validation เพิ่มก่อนยึด v1.6.0 เป็น baseline ใหม่." noteTone="warning" />
          <ModelCard name="Crypto" market="Crypto · M5" active="active registry: v1.2.0" description="Tri-Ensemble จาก BTC, ETH และ SOL พร้อม trade results" sampleLabel="Total samples" points={crypto} note="การเติบโตของข้อมูล 29.6% มาพร้อมคุณภาพฝั่ง Sell ที่ดีขึ้นชัดเจน: ROC-AUC 77.5% → 91.2% และ PR-AUC 26.0% → 78.9% ใน v1.2.0; ควรตรวจ out-of-sample ต่อเพราะจำนวน live samples ยังไม่มาก." noteTone="success" />
          <ModelCard name="Forex Challenger" market="Forex · Shadow / harvesting" active="active registry: v1.7.0" description="Dual GradientBoosting สำหรับ BUY และ SELL" sampleLabel="Total samples" points={challenger} note="ในช่วงเวลานี้ registry มีข้อมูลของ Challenger เพียง v1.7.0 จึงยังวาดเส้นการเติบโตข้าม version ไม่ได้. จุดล่าสุดมี ROC-AUC Buy 81.2% และ Sell 78.4% จาก 80,529 samples, 1,152 live/shadow trades และ 4,082 observations." noteTone="info" />
          <ModelCard name="Forex Range" market="Forex · Mean-reversion" active="active registry: range-v1.0.0" description="Dual Random Forest สำหรับตลาด sideway / range" sampleLabel="Eligible samples" points={rangeModel} note="มีเพียง range-v1.0.0 ที่สร้างในสัปดาห์นี้ จึงเป็น baseline ยังไม่มี trend. ROC-AUC อยู่ราว 52–53% และใน .env ปัจจุบัน RANGE_LIVE_ENABLED=false จึงควรเก็บข้อมูล shadow และประเมินเพิ่มก่อนเปิด live." noteTone="warning" />
        </Grid>
      </Stack>

      <Stack gap={10}>
        <H2>รายละเอียดทุก version</H2>
        <H3>ตัวเลขในวงเล็บเป็น Buy / Sell</H3>
        <Table headers={["วันที่", "Model", "Version", "Samples / eligible", "ROC-AUC", "PR-AUC"]} rows={detailRows} columnAlign={["left", "left", "left", "right", "right", "right"]} striped stickyHeader />
        <Text size="small" tone="tertiary">PR-AUC เป็น metric ที่ควรดูคู่กับ ROC-AUC เพราะ label ของ trade มีความไม่สมดุล; ตัวเลขทั้งหมดเป็นค่า test metric ที่บันทึกใน registry ไม่ใช่ผลกำไร live โดยตรง.</Text>
      </Stack>

      <Callout tone="warning" title="Operational note">
        <Text>registry ล่าสุดระบุ Champion v1.6.0 และ Challenger v1.7.0 แต่ค่าใน .env ที่ตรวจพบยังตั้ง FOREX_MODEL_VERSION=v1.3.0 และ FOREX_CHALLENGER_MODEL_VERSION=challenger-v1.1.0. ก่อน deploy หรือสรุปว่า version ล่าสุดกำลังรันจริง ควรตรวจ runtime config และ process ที่ใช้งานอยู่ให้ตรงกัน.</Text>
      </Callout>
    </Stack>
  );
}
