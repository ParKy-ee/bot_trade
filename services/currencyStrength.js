/**
 * Currency Strength Meter (CSM) Engine
 * Evaluates relative strength across 8 major currencies (USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD)
 * in real-time from the 9-pair universe.
 */

const MAJOR_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];

/**
 * Calculates real-time Currency Strength Index from raw Forex bars.
 * @param {Object} rawData Map of symbol (e.g. 'EURUSD=X') -> array of bars
 * @param {number} lookback Lookback bars for momentum calculation (default: 12 bars = 1 hour on M5)
 * @returns {Object} { scores: Object, rankings: Array, spreads: Object }
 */
export function calculateCurrencyStrength(rawData, lookback = 12) {
  const scores = {};
  const counts = {};

  for (const c of MAJOR_CURRENCIES) {
    scores[c] = 0;
    counts[c] = 0;
  }

  // Evaluate pair performance
  for (const [symbol, bars] of Object.entries(rawData)) {
    if (!bars || bars.length < lookback + 1) continue;
    const cleanSym = symbol.replace('=X', '').toUpperCase();
    if (cleanSym.length !== 6) continue;

    const base = cleanSym.substring(0, 3);
    const quote = cleanSym.substring(3, 6);

    if (!MAJOR_CURRENCIES.includes(base) || !MAJOR_CURRENCIES.includes(quote)) continue;

    const n = bars.length;
    const currPrice = Number(bars[n - 1].close);
    const prevPrice = Number(bars[n - 1 - lookback].close);

    if (prevPrice <= 0 || !Number.isFinite(currPrice)) continue;

    // Relative change over lookback
    const ret = (currPrice - prevPrice) / prevPrice;

    // Base currency gained, quote currency lost
    scores[base] += ret;
    counts[base] += 1;

    scores[quote] -= ret;
    counts[quote] += 1;
  }

  // Average and scale (-10 to +10 range)
  let sumScore = 0;
  let activeCurrencies = 0;
  for (const c of MAJOR_CURRENCIES) {
    if (counts[c] > 0) {
      scores[c] = (scores[c] / counts[c]) * 1000; // Scaled to basis points
      sumScore += scores[c];
      activeCurrencies++;
    }
  }

  // Center around zero mean
  const meanScore = activeCurrencies > 0 ? sumScore / activeCurrencies : 0;
  for (const c of MAJOR_CURRENCIES) {
    scores[c] = Number((scores[c] - meanScore).toFixed(3));
  }

  // Create rankings (strongest to weakest)
  const rankings = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([curr, score], idx) => ({ rank: idx + 1, currency: curr, score }));

  return {
    scores,
    rankings,
    strongest: rankings[0]?.currency || 'USD',
    weakest: rankings[rankings.length - 1]?.currency || 'JPY'
  };
}

/**
 * Gets the CSM Spread (Base Strength - Quote Strength) for a specific pair.
 * Positive means Base is stronger than Quote (Bullish bias).
 * Negative means Base is weaker than Quote (Bearish bias).
 * @param {string} symbol e.g. 'EURUSD=X' or 'USDJPY'
 * @param {Object} csmScores Map of currency -> score from calculateCurrencyStrength
 * @returns {number} csmSpread
 */
export function getPairCsmSpread(symbol, csmScores) {
  if (!csmScores) return 0;
  const cleanSym = symbol.replace('=X', '').toUpperCase();
  if (cleanSym.length !== 6) return 0;

  const base = cleanSym.substring(0, 3);
  const quote = cleanSym.substring(3, 6);

  const baseScore = csmScores[base] ?? 0;
  const quoteScore = csmScores[quote] ?? 0;

  return Number((baseScore - quoteScore).toFixed(3));
}
