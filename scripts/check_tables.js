import { getPool } from '../config/database.js';

async function main() {
  const pool = await getPool();
  const [tables] = await pool.query('SHOW TABLES');
  for (const row of tables) {
    const tableName = Object.values(row)[0];
    const [count] = await pool.query(`SELECT count(*) as c FROM \`${tableName}\``);
    console.log(`${tableName}: ${count[0].c}`);
  }
  
  // Check distinct symbols and market_types in trade_results
  const [types] = await pool.query(`SELECT market_type, COUNT(*) as c FROM trade_results GROUP BY market_type`);
  console.log('\ntrade_results market_types:', types);

  const [symbols] = await pool.query(`SELECT symbol, market_type, COUNT(*) as c FROM trade_results GROUP BY symbol, market_type`);
  console.log('\ntrade_results symbols:', symbols);

  // Check signals
  const [signals] = await pool.query(`SELECT market_type, COUNT(*) as c FROM signals GROUP BY market_type`);
  console.log('\nsignals market_types:', signals);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
