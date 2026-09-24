import dotenv from 'dotenv';

dotenv.config();

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const configuredMt5Enabled = envFlag('MT5_ENABLED', false);

/** Global execution mode for the main engines. */
export function isTradingSandboxEnabled() {
  return envFlag('TRADING_SANDBOX_ENABLED', false);
}

// Make the existing engines' MT5 checks fail closed globally. This lets their
// built-in paper/shadow paths run without requiring every market engine to
// duplicate the sandbox condition.
if (isTradingSandboxEnabled()) {
  process.env.MT5_ENABLED = 'false';
}

export function isMainLiveExecutionEnabled() {
  return envFlag('MT5_ENABLED', false) && !isTradingSandboxEnabled();
}

export function getTradingMode() {
  if (isTradingSandboxEnabled()) return 'SANDBOX_SHADOW';
  return envFlag('MT5_ENABLED') ? 'LIVE' : 'SHADOW';
}

export function getTradingModeStatus() {
  return {
    mode: getTradingMode(),
    sandboxEnabled: isTradingSandboxEnabled(),
    mainLiveExecutionEnabled: isMainLiveExecutionEnabled(),
    mt5Enabled: envFlag('MT5_ENABLED', false),
    mt5ConfiguredEnabled: configuredMt5Enabled
  };
}
