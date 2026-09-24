import dotenv from 'dotenv';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

/**
 * Send Markdown formatted alert to Telegram.
 * @param {string} message
 */
export async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('ℹ️ [Telegram Alert Skipped - Token/ChatID not set]:\n', message);
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    const result = await res.json();
    if (!result.ok) {
      console.warn('⚠️ Telegram API error:', result.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('❌ Failed to send Telegram alert:', err.message);
    return false;
  }
}
