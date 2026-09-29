import fs from 'fs';

const logPath = 'C:/Users/GF/.gemini/antigravity-cli/brain/15c3d84b-364f-4f67-a9d8-21ef1efa6af8/.system_generated/tasks/task-1838.log';
const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

console.log(`Total log lines: ${lines.length}`);

// Extract all lines matching key gating/decisions
const interesting = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (
    line.includes('FOREX MODEL DECISION') ||
    line.includes('Crypto Gating') ||
    line.includes('Crypto Exit Geometry') ||
    line.includes('Crypto Raw Conviction Guard') ||
    line.includes('Crypto Counter-Pressure') ||
    line.includes('Gold Gating') ||
    line.includes('Gold Guard') ||
    line.includes('Gold Raw Conviction Guard') ||
    line.includes('Gold Rejection') ||
    line.includes('PRODUCTION GUARD') ||
    line.includes('COUNTER-PRESSURE VETO') ||
    line.includes('เริ่มรอบการสแกน')
  ) {
    interesting.push(line.trim());
  }
}

console.log(`Matched ${interesting.length} lines:`);
// Group by scan cycle
let currentCycle = '';
const cycleMap = {};

for (const line of interesting) {
  if (line.includes('เริ่มรอบการสแกน')) {
    const timeMatch = line.match(/\[(.*?)\]/);
    currentCycle = timeMatch ? timeMatch[1] : line;
    if (!cycleMap[currentCycle]) cycleMap[currentCycle] = [];
  } else if (currentCycle) {
    if (!cycleMap[currentCycle]) cycleMap[currentCycle] = [];
    cycleMap[currentCycle].push(line);
  }
}

for (const [cycle, logs] of Object.entries(cycleMap)) {
  const locTime = new Date(cycle).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
  console.log(`\n=================== CYCLE ${locTime} (${cycle}) ===================`);
  for (const l of logs) {
    console.log('  ' + l);
  }
}
