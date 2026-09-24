import { getAccountInfo, getOpenPositions } from '../services/mt5Broker.js';

async function test() {
  console.log('='.repeat(60));
  console.log('🔌 ทดสอบการเชื่อมต่อ MetaTrader 5 (MT5 Bridge Test)');
  console.log('='.repeat(60));

  console.log('[*] กำลังตรวจสอบสถานะ MT5 Terminal...');
  const account = await getAccountInfo();
  console.log('Account Status:', account);

  if (account.connected) {
    console.log('\n✅ เชื่อมต่อ MT5 สำเร็จ!');
    console.log(`• บัญชี (Login): ${account.login} (${account.name || 'Demo'})`);
    console.log(`• เซิร์ฟเวอร์: ${account.server}`);
    console.log(`• ยอดเงิน (Balance): $${Number(account.balance).toLocaleString()} ${account.currency}`);
    console.log(`• ยอดเงินสุทธิ (Equity): $${Number(account.equity).toLocaleString()} ${account.currency}`);
    console.log(`• เลเวอเรจ (Leverage): 1:${account.leverage}`);
    console.log(`• โบรกเกอร์: ${account.company}`);

    const positions = await getOpenPositions();
    console.log(`\n• จำนวนออเดอร์ที่เปิดค้างบน MT5: ${Array.isArray(positions) ? positions.length : 0} รายการ`);
  } else {
    console.log('\nℹ️ [คำแนะนำสำหรับการเริ่มเทรด Demo]:');
    console.log('1. เปิดโปรแกรม MetaTrader 5 (หรือ XM MT5) บนเครื่องคอมพิวเตอร์ของคุณ');
    console.log('2. ล็อกอินเข้าบัญชี Demo ทิ้งไว้');
    console.log('3. เมื่อเปิด MT5 ค้างไว้ สคริปต์ของบอทจะเชื่อมต่อเพื่อยิง Order ได้ทันทีโดยอัตโนมัติ!');
  }
}

test();
