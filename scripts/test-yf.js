import yahooFinance from 'yahoo-finance2';

async function test() {
  console.log('--- Testing Yahoo Finance API ---');
  try {
    const today = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(today.getFullYear() - 1);

    const result = await yahooFinance.historical('SPY', {
      period1: oneYearAgo.toISOString().split('T')[0],
      interval: '1d'
    });
    console.log(`Successfully fetched ${result.length} bars for SPY. Latest bar:`, result[result.length - 1]);
  } catch (err) {
    console.error('Yahoo Finance test failed:', err);
  }
}

test();
