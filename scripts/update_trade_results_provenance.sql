-- Champion–Challenger provenance migration for ai_trading_db.
-- Run once in phpMyAdmin/MySQL against the trade_bot database.

ALTER TABLE trade_results
  ADD COLUMN pair_id VARCHAR(64) DEFAULT NULL AFTER market_type,
  ADD COLUMN model_source VARCHAR(64) NOT NULL DEFAULT 'unknown' AFTER pair_id,
  ADD COLUMN model_version VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER model_source,
  ADD COLUMN strategy_version VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER model_version,
  ADD COLUMN config_hash VARCHAR(64) DEFAULT NULL AFTER strategy_version,
  ADD COLUMN decision_mode VARCHAR(24) NOT NULL DEFAULT 'LIVE' AFTER config_hash,
  ADD COLUMN prediction_meta TEXT DEFAULT NULL AFTER decision_mode;

ALTER TABLE trade_results
  ADD INDEX idx_trade_model_version (model_source, model_version),
  ADD INDEX idx_trade_shadow_identity (symbol, market_type, model_source, exit_reason),
  ADD INDEX idx_trade_pair_id (pair_id);

-- Optional verification:
-- SELECT id, pair_id, symbol, action, model_source, model_version, strategy_version,
--        decision_mode, ai_confidence, exit_reason, is_win
-- FROM trade_results
-- ORDER BY id DESC LIMIT 20;

-- Pair comparison after shadow results are collected:
-- SELECT pair_id, symbol, action,
--   MAX(CASE WHEN model_source = 'forex_champion' THEN model_version END) AS champion_version,
--   MAX(CASE WHEN model_source = 'forex_champion' THEN exit_reason END) AS champion_exit,
--   MAX(CASE WHEN model_source = 'forex_champion' THEN is_win END) AS champion_win,
--   MAX(CASE WHEN model_source = 'forex_challenger' THEN model_version END) AS challenger_version,
--   MAX(CASE WHEN model_source = 'forex_challenger' THEN exit_reason END) AS challenger_exit,
--   MAX(CASE WHEN model_source = 'forex_challenger' THEN is_win END) AS challenger_win
-- FROM trade_results
-- WHERE pair_id IS NOT NULL
-- GROUP BY pair_id, symbol, action
-- HAVING COUNT(DISTINCT model_source) = 2
-- ORDER BY pair_id DESC;
