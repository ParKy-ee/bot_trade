import { placeOrder, getAccountInfo, getOpenPositions } from '../services/mt5Broker.js';

async function testBuy() {
  console.log('='.repeat(60));
  console.log('🛒 ทดสอบการส่งคำสั่งซื้อ (BUY Order) คู่เงิน EURUSD ผ่าน MT5 API');
  console.log('='.repeat(60));

  console.log('[1] ตรวจสอบสถานะบัญชีก่อนส่งคำสั่ง...');
  const acc = await getAccountInfo();
  if (!acc.connected) {
    console.error('❌ ไม่สามารถเชื่อมต่อ MT5 ได้:', acc.error);
    return;
  }
  console.log(`✅ บัญชี MT5: ${acc.login} (${acc.server}) Balance: $${acc.balance} Equity: $${acc.equity}`);
  console.log(`• Trade Allowed: ${acc.tradeAllowed}, Trade Expert: ${acc.tradeExpert}`);

  console.log('\n[2] กำลังส่งคำสั่งซื้อ BUY EURUSD 0.01 lot...');
  // For EURUSD ask ~1.1633: SL at 1.1600 (33 pips), TP at 1.1700 (67 pips)
  const orderPayload = {
    symbol: 'EURUSD',
    action: 'BUY',
    lot: 0.01,
    sl: 1.1600,
    tp: 1.1700,
    comment: 'API Test BUY'
  };

  const orderResult = await placeOrder(orderPayload);
  console.log('ผลลัพธ์คำสั่งซื้อ (Order Result):', orderResult);

  if (orderResult.success) {
    console.log(`\n🎉 ส่งคำสั่งซื้อสำเร็จ! Ticket #${orderResult.ticket}`);
    console.log(`• Symbol: ${orderResult.symbol}`);
    console.log(`• Volume: ${orderResult.volume} lot`);
    console.log(`• Executed Price: ${orderResult.price}`);
  } else {
    console.error(`\n❌ ส่งคำสั่งไม่สำเร็จ: ${orderResult.error}`);
  }

  console.log('\n[3] ตรวจสอบรายการ Open Positions ปัจจุบันบน MT5:');
  const positions = await getOpenPositions();
  console.log(positions);
}

testBuy();
