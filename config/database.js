import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'ai_trading_db';

let pool = null;

export async function getPool() {
  if (pool) return pool;

  // First connect to MySQL server to ensure database exists
  try {
    const rootConn = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
    });
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await rootConn.end();
  } catch (err) {
    console.error(`⚠️ ไม่สามารถตรวจสอบ/สร้าง Database '${DB_NAME}':`, err.message);
  }

  // Create pool
  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+07:00',
    decimalNumbers: true
  });

  return pool;
}

export async function initDatabase() {
  console.log(`[*] ตรวจสอบการเชื่อมต่อ MySQL ที่ ${DB_HOST}:${DB_PORT}/${DB_NAME}...`);
  const p = await getPool();

  try {
    // 1. Table: signals
    await p.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        time DATETIME NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        price DECIMAL(12, 4) NOT NULL,
        ai_confidence DECIMAL(6, 4) NOT NULL,
        sl_price DECIMAL(12, 4) NOT NULL,
        tp_price DECIMAL(12, 4) NOT NULL,
        action VARCHAR(20) NOT NULL,
        source_tag VARCHAR(64) NOT NULL DEFAULT 'legacy',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_symbol_time (symbol, time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. Table: active_positions
    await p.query(`
      CREATE TABLE IF NOT EXISTS active_positions (
        symbol VARCHAR(20) PRIMARY KEY,
        entry_date DATETIME NOT NULL,
        entry_price DECIMAL(12, 4) NOT NULL,
        highest_price DECIMAL(12, 4) NOT NULL,
        sl_price DECIMAL(12, 4) NOT NULL,
        tp_price DECIMAL(12, 4) NOT NULL,
        status_note VARCHAR(50) DEFAULT 'INITIAL_SL',
        source_tag VARCHAR(64) NOT NULL DEFAULT 'legacy',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. Table: market_bars
    await p.query(`
      CREATE TABLE IF NOT EXISTS market_bars (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        time DATETIME NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        open DECIMAL(12, 4),
        high DECIMAL(12, 4),
        low DECIMAL(12, 4),
        close DECIMAL(12, 4),
        volume BIGINT,
        rsi DECIMAL(6, 2),
        atr DECIMAL(12, 4),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_symbol_time (symbol, time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Safe migration: check last_scanned_at in market_bars
    const [cols] = await p.execute(
      `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'market_bars' AND COLUMN_NAME = 'last_scanned_at'`,
      [DB_NAME]
    );
    if (cols[0].count === 0) {
      await p.query(`
        ALTER TABLE market_bars
        ADD COLUMN last_scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP AFTER created_at
      `);
      console.log("[+] เพิ่มคอลัมน์ last_scanned_at ใน market_bars แล้ว");
    }

    // Safe migration: add market_type to signals, active_positions, market_bars
    const tablesWithMarketType = ['signals', 'active_positions', 'market_bars'];
    for (const t of tablesWithMarketType) {
      const [colCheck] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'market_type'`,
        [DB_NAME, t]
      );
      if (colCheck[0].count === 0) {
        await p.query(`ALTER TABLE \`${t}\` ADD COLUMN market_type VARCHAR(10) NOT NULL DEFAULT 'stock'`);
        console.log(`[+] เพิ่มคอลัมน์ market_type ใน ${t} เรียบร้อยแล้ว`);
      }
    }

    // Safe migration: add mt5_ticket to signals and active_positions
    const tablesWithTicket = ['signals', 'active_positions'];
    for (const t of tablesWithTicket) {
      const [ticketCheck] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'mt5_ticket'`,
        [DB_NAME, t]
      );
      if (ticketCheck[0].count === 0) {
        await p.query(`ALTER TABLE \`${t}\` ADD COLUMN mt5_ticket BIGINT DEFAULT NULL`);
        console.log(`[+] เพิ่มคอลัมน์ mt5_ticket ใน ${t} เรียบร้อยแล้ว`);
      }
    }

    // Retain the origin of every integration without overloading market_type.
    const tablesWithSourceTag = ['signals', 'active_positions'];
    for (const t of tablesWithSourceTag) {
      const [sourceTagCheck] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'source_tag'`,
        [DB_NAME, t]
      );
      if (sourceTagCheck[0].count === 0) {
        await p.query(`ALTER TABLE \`${t}\` ADD COLUMN source_tag VARCHAR(64) NOT NULL DEFAULT 'legacy'`);
        console.log(`[+] เพิ่มคอลัมน์ source_tag ใน ${t} เรียบร้อยแล้ว`);
      }
      const indexName = `idx_${t}_source_tag`;
      const [sourceTagIndex] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [DB_NAME, t, indexName]
      );
      if (sourceTagIndex[0].count === 0) {
        await p.query(`ALTER TABLE \`${t}\` ADD INDEX ${indexName} (source_tag)`);
      }
    }

    // 4. Table: trade_results (Complete Feature & Outcome Log for ML Research)
    await p.query(`
      CREATE TABLE IF NOT EXISTS trade_results (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        mt5_ticket BIGINT DEFAULT NULL,
        symbol VARCHAR(20) NOT NULL,
        market_type VARCHAR(10) NOT NULL DEFAULT 'forex',
        source_tag VARCHAR(64) NOT NULL DEFAULT 'legacy',
        action VARCHAR(10) NOT NULL,
        lot_size DECIMAL(8, 2) DEFAULT 0.01,
        entry_time DATETIME NOT NULL,
        entry_price DECIMAL(12, 5) NOT NULL,
        ai_confidence DECIMAL(6, 4) DEFAULT NULL,
        sl_price DECIMAL(12, 5) DEFAULT NULL,
        tp_price DECIMAL(12, 5) DEFAULT NULL,
        ema9 DECIMAL(12, 5) DEFAULT NULL,
        ema21 DECIMAL(12, 5) DEFAULT NULL,
        ema50 DECIMAL(12, 5) DEFAULT NULL,
        rsi DECIMAL(6, 2) DEFAULT NULL,
        adx DECIMAL(6, 2) DEFAULT NULL,
        macd_hist DECIMAL(12, 6) DEFAULT NULL,
        atr DECIMAL(12, 5) DEFAULT NULL,
        filter_reasons TEXT DEFAULT NULL,
        exit_time DATETIME DEFAULT NULL,
        exit_price DECIMAL(12, 5) DEFAULT NULL,
        exit_reason VARCHAR(30) DEFAULT 'OPEN',
        pips DECIMAL(10, 2) DEFAULT NULL,
        profit_loss DECIMAL(12, 2) DEFAULT NULL,
        return_pct DECIMAL(8, 4) DEFAULT NULL,
        is_win TINYINT(1) DEFAULT NULL,
        hold_duration_minutes INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ticket (mt5_ticket),
        INDEX idx_symbol_action (symbol, action),
        INDEX idx_exit_reason (exit_reason),
        INDEX idx_is_win (is_win)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Append-only learning observations.  This is deliberately separate from
    // trade_results and dataset_forex_m5.csv so legacy training data remains
    // unchanged and auditable.
    await p.query(`
      CREATE TABLE IF NOT EXISTS forex_ml_observations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        bar_time DATETIME NOT NULL,
        observed_at DATETIME NOT NULL,
        data_source VARCHAR(16) NOT NULL DEFAULT 'unknown',
        feature_version VARCHAR(32) NOT NULL DEFAULT 'forex13-v1',
        sample_kind VARCHAR(24) NOT NULL DEFAULT 'NO_TRADE',
        candidate_action VARCHAR(10) DEFAULT NULL,
        active_track VARCHAR(32) NOT NULL DEFAULT 'NONE',
        qualified TINYINT(1) NOT NULL DEFAULT 0,
        model_signal TINYINT(1) NOT NULL DEFAULT 0,
        confluence_score DECIMAL(6,2) NOT NULL DEFAULT 0,
        champion_confidence DECIMAL(6,4) DEFAULT NULL,
        challenger_confidence DECIMAL(6,4) DEFAULT NULL,
        entry_price DECIMAL(12,5) DEFAULT NULL,
        sl_price DECIMAL(12,5) DEFAULT NULL,
        tp_price DECIMAL(12,5) DEFAULT NULL,
        ret_1 DECIMAL(14,8) NOT NULL,
        ret_5 DECIMAL(14,8) NOT NULL,
        rsi_14 DECIMAL(8,4) NOT NULL,
        atr_pct DECIMAL(14,8) NOT NULL,
        adx_14 DECIMAL(8,4) NOT NULL,
        ema_spread_20_50 DECIMAL(14,8) NOT NULL,
        macd_hist DECIMAL(14,8) NOT NULL,
        csm_spread DECIMAL(12,6) NOT NULL,
        h1_trend_slope DECIMAL(14,8) NOT NULL,
        is_jpy TINYINT(1) NOT NULL DEFAULT 0,
        time_sin_hour DECIMAL(10,7) NOT NULL,
        time_cos_hour DECIMAL(10,7) NOT NULL,
        spread_to_atr DECIMAL(14,8) NOT NULL,
        session_name VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
        filter_reasons TEXT DEFAULT NULL,
        outcome_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        target_buy TINYINT(1) DEFAULT NULL,
        target_sell TINYINT(1) DEFAULT NULL,
        label_method VARCHAR(32) DEFAULT NULL,
        labeled_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_forex_ml_observation (symbol, bar_time, feature_version),
        INDEX idx_forex_ml_outcome (outcome_status, bar_time),
        INDEX idx_forex_ml_source (data_source, sample_kind),
        INDEX idx_forex_ml_session (session_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [tradeSourceTagCheck] = await p.execute(
      `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trade_results' AND COLUMN_NAME = 'source_tag'`,
      [DB_NAME]
    );
    if (tradeSourceTagCheck[0].count === 0) {
      await p.query("ALTER TABLE trade_results ADD COLUMN source_tag VARCHAR(64) NOT NULL DEFAULT 'legacy'");
      console.log('[+] เพิ่มคอลัมน์ source_tag ใน trade_results เรียบร้อยแล้ว');
    }
    const [tradeSourceTagIndex] = await p.execute(
      `SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trade_results' AND INDEX_NAME = 'idx_trade_results_source_tag'`,
      [DB_NAME]
    );
    if (tradeSourceTagIndex[0].count === 0) {
      await p.query('ALTER TABLE trade_results ADD INDEX idx_trade_results_source_tag (source_tag)');
    }

    // Safe migration: provenance fields let Champion and Challenger results
    // coexist in the same table and keep model/strategy identity immutable.
    const tradeProvenanceColumns = [
      ['pair_id', 'VARCHAR(64) DEFAULT NULL AFTER market_type'],
      ['model_source', "VARCHAR(64) NOT NULL DEFAULT 'unknown' AFTER pair_id"],
      ['model_version', "VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER model_source"],
      ['strategy_version', "VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER model_version"],
      ['config_hash', 'VARCHAR(64) DEFAULT NULL AFTER strategy_version'],
      ['decision_mode', "VARCHAR(24) NOT NULL DEFAULT 'LIVE' AFTER config_hash"],
      ['prediction_meta', 'TEXT DEFAULT NULL AFTER decision_mode']
    ];
    for (const [columnName, definition] of tradeProvenanceColumns) {
      const [columnCheck] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trade_results' AND COLUMN_NAME = ?`,
        [DB_NAME, columnName]
      );
      if (columnCheck[0].count === 0) {
        await p.query(`ALTER TABLE trade_results ADD COLUMN ${columnName} ${definition}`);
        console.log(`[+] เพิ่มคอลัมน์ ${columnName} ใน trade_results แล้ว`);
      }
    }

    // Preserve broker outcome components so a TP hit can be distinguished
    // from a positive net result after commission, swap, and fees.
    const tradeOutcomeCostColumns = [
      ['gross_profit', 'DECIMAL(12, 2) DEFAULT NULL AFTER profit_loss'],
      ['commission_cost', 'DECIMAL(12, 2) DEFAULT NULL AFTER gross_profit'],
      ['swap_cost', 'DECIMAL(12, 2) DEFAULT NULL AFTER commission_cost'],
      ['fee_cost', 'DECIMAL(12, 2) DEFAULT NULL AFTER swap_cost'],
      ['cost_pips', 'DECIMAL(10, 2) DEFAULT NULL AFTER fee_cost'],
      ['net_is_win', 'TINYINT(1) DEFAULT NULL AFTER is_win']
    ];
    for (const [columnName, definition] of tradeOutcomeCostColumns) {
      const [columnCheck] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trade_results' AND COLUMN_NAME = ?`,
        [DB_NAME, columnName]
      );
      if (columnCheck[0].count === 0) {
        await p.query(`ALTER TABLE trade_results ADD COLUMN ${columnName} ${definition}`);
        console.log(`[+] Added trade outcome cost column ${columnName}`);
      }
    }

    // A broker ticket must map to one result row within a market. Keep the
    // market in the key because legacy broker history can reuse ticket values
    // across market adapters, while NULL tickets remain allowed.
    const [cryptoTicketIndexCheck] = await p.execute(
      `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trade_results'
         AND INDEX_NAME = 'uq_trade_results_market_ticket'`,
      [DB_NAME]
    );
    if (cryptoTicketIndexCheck[0].count === 0) {
      await p.query(
        'ALTER TABLE trade_results ADD UNIQUE INDEX uq_trade_results_market_ticket (market_type, mt5_ticket)'
      );
      console.log('[+] เพิ่ม unique ticket guard ใน trade_results แล้ว');
    }

    const provenanceIndexes = [
      ['idx_trade_model_version', '(model_source, model_version)'],
      ['idx_trade_shadow_identity', '(symbol, market_type, model_source, exit_reason)'],
      ['idx_trade_pair_id', '(pair_id)']
    ];
    for (const [indexName, columns] of provenanceIndexes) {
      const [indexCheck] = await p.execute(
        `SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trade_results' AND INDEX_NAME = ?`,
        [DB_NAME, indexName]
      );
      if (indexCheck[0].count === 0) {
        await p.query(`ALTER TABLE trade_results ADD INDEX ${indexName} ${columns}`);
        console.log(`[+] เพิ่มดัชนี ${indexName} ใน trade_results แล้ว`);
      }
    }

    console.log("✅ ฐานข้อมูล XAMPP MySQL พร้อมใช้งานสมบูรณ์!");
  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาดในการตั้งค่าฐานข้อมูล:", err);
    throw err;
  }
}
