import { initDatabase } from '../config/database.js';
import { seedHistoricalData } from '../services/historicalSeeder.js';

async function run() {
  try {
    await initDatabase();
    const res = await seedHistoricalData();
    console.log('🎉 เสร็จสิ้นการ Seed ข้อมูล:', res);
    process.exit(0);
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในการ Seed ข้อมูล:', err);
    process.exit(1);
  }
}

run();
