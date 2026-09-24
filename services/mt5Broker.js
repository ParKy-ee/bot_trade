import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { isTradingSandboxEnabled } from './tradingMode.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(ROOT_DIR, 'python', 'mt5_bridge.py');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

function runBridge(args, stdinPayload = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_PATH, [BRIDGE_SCRIPT, ...args], {
      cwd: ROOT_DIR,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      try {
        const text = stdout.trim();
        if (!text) {
          return resolve({ connected: false, error: stderr || `Exit code ${code}` });
        }
        const parsed = JSON.parse(text);
        resolve(parsed);
      } catch (err) {
        resolve({ connected: false, error: `JSON Parse error: ${stdout || stderr}` });
      }
    });

    if (stdinPayload) {
      child.stdin.write(JSON.stringify(stdinPayload));
      child.stdin.end();
    }
  });
}

/**
 * Check MT5 connection and retrieve Demo account info.
 */
export async function getAccountInfo() {
  return await runBridge(['--account']);
}

/**
 * Fetch short-term bars (M15 / M5 / H1) directly from MT5.
 */
export async function getRates(symbol = 'EURUSD', timeframe = 'M15', count = 100) {
  return await runBridge(['--rates', symbol, timeframe, String(count)]);
}

/**
 * Send real market order into MT5 Demo account.
 * @param {Object} opts { symbol, action, lot, sl, tp, comment }
 */
export async function placeOrder({ symbol, action, lot, volume, sl = 0.0, tp = 0.0, comment = 'AI Trade Bot', executionContext = 'main' }) {
  if (isTradingSandboxEnabled() && executionContext !== 'sandbox') {
    return { success: false, blocked: true, error: 'MAIN_LIVE_DISABLED_SANDBOX_MODE' };
  }
  const finalLot = lot !== undefined && lot !== null ? lot : (volume !== undefined && volume !== null ? volume : 0.01);
  const payload = { symbol, action, lot: finalLot, sl, tp, comment };
  return await runBridge(['--order'], payload);
}

/**
 * Modify Trailing Stop Loss on an active MT5 ticket.
 */
export async function modifyStopLoss(ticket, sl, tp = 0.0) {
  return await runBridge(['--modify', String(ticket), String(sl), String(tp)]);
}

/**
 * Close an active position on MT5 (supports optional partial volume).
 */
export async function closePosition(ticket, volume = null) {
  const args = ['--close', String(ticket)];
  if (volume !== null && volume !== undefined && Number(volume) > 0) {
    args.push(String(volume));
  }
  return await runBridge(args);
}

/**
 * Retrieve currently open positions from MT5.
 */
export async function getOpenPositions() {
  return await runBridge(['--positions']);
}

/**
 * Retrieve recently closed deals from MT5 history.
 */
export async function getClosedDeals() {
  return await runBridge(['--closed-deals']);
}

/**
 * Send pending order (BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP) into MT5 Demo account.
 * @param {Object} opts { symbol, type, price, lot, sl, tp, expirationMinutes, comment }
 */
export async function placePendingOrder({
  symbol,
  type,
  price,
  lot = 0.01,
  sl = 0.0,
  tp = 0.0,
  expirationMinutes = 45,
  comment = 'AI Pending Bot',
  executionContext = 'main'
}) {
  if (isTradingSandboxEnabled() && executionContext !== 'sandbox') {
    return { success: false, blocked: true, error: 'MAIN_LIVE_DISABLED_SANDBOX_MODE' };
  }
  const payload = { symbol, type, price, lot, sl, tp, expirationMinutes, comment };
  return await runBridge(['--pending-order'], payload);
}

/**
 * Retrieve currently active pending orders from MT5.
 */
export async function getPendingOrders() {
  return await runBridge(['--pending-list']);
}

/**
 * Cancel an active pending order on MT5.
 * @param {number|string} ticket
 */
export async function cancelPendingOrder(ticket) {
  return await runBridge(['--cancel-order', String(ticket)]);
}
