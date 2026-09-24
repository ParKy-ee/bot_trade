import dotenv from 'dotenv';

dotenv.config();

/**
 * Gemini LLM Trade Reviewer Service
 * Evaluates trade setups using Google Gemini (gemini-2.5-flash or gemini-1.5-flash)
 * Acts as an AI Senior Risk Manager to double-check signals before execution.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_ENABLED = process.env.GEMINI_ENABLED === 'true';

/**
 * Reviews an M5 Scalp trade setup using Gemini LLM.
 * @param {Object} setup Technical and macro trade context
 * @returns {Promise<Object>} Review verdict and reasoning
 */
export async function reviewTradeWithGemini(setup) {
  if (!GEMINI_ENABLED || !GEMINI_API_KEY) {
    // If not enabled or no API key, bypass review smoothly
    return {
      enabled: false,
      should_enter: true,
      confidence: setup.mlConfidence || 0.60,
      verdict: 'BYPASS_NO_KEY',
      risk_rating: 'MODERATE',
      reasoning: 'Gemini review bypassed (GEMINI_API_KEY not configured or GEMINI_ENABLED=false)',
      comment: 'ดำเนินการตามโมเดล ML สถิติ (ไม่ได้เปิดใช้งาน Gemini API)'
    };
  }

  const prompt = `
You are an Elite Institutional Forex Quant Trader & Chief Risk Officer.
Review the following M5 Scalp trade opportunity for currency pair ${setup.symbol}:

--- TRADE SETUP CONTEXT ---
- Pair: ${setup.cleanName || setup.symbol}
- Proposed Action: ${setup.action} (BUY or SELL)
- Current Price: ${setup.price}
- Volatility (ATR 14): ${setup.atr?.toFixed(5) || 'N/A'}
- Fast EMAs: EMA9=${setup.ema9?.toFixed(5)}, EMA21=${setup.ema21?.toFixed(5)}, EMA50=${setup.ema50?.toFixed(5)}
- Momentum (RSI 9): ${setup.rsi?.toFixed(1) || 'N/A'}
- Trend Strength (ADX 14): ${setup.adx?.toFixed(1) || 'N/A'}
- MACD Histogram: ${setup.macd_hist?.toFixed(6) || 'N/A'}
- Dollar Index (DXY) Macro Trend: ${setup.dxyTrend || 'NEUTRAL'}
- Proposed Stop Loss: ${setup.slPrice} (${setup.slPips} pips away)
- Proposed Take Profit: ${setup.tpPrice} (${setup.tpPips} pips away)
- Risk/Reward Ratio: 1 : ${setup.rrRatio || '1.5'}
- Statistical ML Model Confidence: ${(setup.mlConfidence * 100).toFixed(1)}%

--- YOUR MISSION ---
Evaluate this setup objectively:
1. Does the technical momentum and EMA structure genuinely support this ${setup.action}?
2. Is the Stop Loss distance (${setup.slPips} pips) safe from normal spread noise (XM spread is ~1.5 - 3 pips)?
3. Are there any signs of exhaustion, divergence, or chop?
4. Make a decisive call: APPROVE or REJECT.

Respond ONLY with this exact JSON schema:
{
  "should_enter": true | false,
  "confidence": 0.0 to 1.0,
  "verdict": "APPROVE" | "REJECT",
  "risk_rating": "LOW" | "MEDIUM" | "HIGH",
  "key_strengths": ["string", "string"],
  "key_risks": ["string"],
  "comment_th": "Brief 1-2 sentence executive assessment in Thai for the trader"
}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.15
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`⚠️ Gemini API error (${res.status}): ${errText}`);
      return {
        enabled: true,
        should_enter: true,
        confidence: setup.mlConfidence || 0.60,
        verdict: 'ERROR_FALLBACK',
        reasoning: `Gemini API returned status ${res.status}`,
        comment_th: 'ระบบเชื่อมต่อ Gemini ขัดข้อง ใช้การตัดสินใจของโมเดลสถิติเดิม'
      };
    }

    const data = await res.json();
    const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textOutput) {
      throw new Error('Empty response content from Gemini');
    }

    const parsed = JSON.parse(textOutput.trim());
    return {
      enabled: true,
      should_enter: Boolean(parsed.should_enter),
      confidence: Number(parsed.confidence || 0.5),
      verdict: parsed.verdict || (parsed.should_enter ? 'APPROVE' : 'REJECT'),
      risk_rating: parsed.risk_rating || 'MEDIUM',
      key_strengths: parsed.key_strengths || [],
      key_risks: parsed.key_risks || [],
      comment_th: parsed.comment_th || parsed.comment || 'ผ่านการรีวิวจาก Gemini'
    };
  } catch (err) {
    console.warn(`⚠️ Exception calling Gemini Reviewer: ${err.message}`);
    return {
      enabled: true,
      should_enter: true,
      confidence: setup.mlConfidence || 0.60,
      verdict: 'EXCEPTION_FALLBACK',
      reasoning: err.message,
      comment_th: 'เกิดข้อผิดพลาดในการเรียก Gemini API อนุโลมตามโมเดล ML'
    };
  }
}
