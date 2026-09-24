import { initDatabase, getPool } from '../config/database.js';

async function test() {
  console.log('--- Testing MySQL Connection ---');
  try {
    await initDatabase();
    const pool = await getPool();
    const [tables] = await pool.query('SHOW TABLES;');
    console.log('ตารางทั้งหมดในฐานข้อมูล:', tables.map(r => Object.values(r)[0]));
    console.log('✅ ทดสอบเชื่อมต่อ MySQL สำเร็จ!');
    process.exit(0);
  } catch (err) {
    console.error('❌ ทดสอบเชื่อมต่อ MySQL ล้มเหลว:', err);
    process.exit(1);
  }
}

test();
