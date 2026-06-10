export interface UpstoxBar {
  t: string; // Timestamp
  o: number; // Open
  h: number; // High
  l: number; // Low
  c: number; // Close
  v: number; // Volume
}

export type TradingSignal = "BUY" | "SELL" | "HOLD";

export interface StrategyResult {
  signal: TradingSignal;
  reason: string;
  fastSma: number;
  slowSma: number;
  rsi: number;
}

/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) {
    return 0;
  }
  const slice = prices.slice(prices.length - period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Calculates Relative Strength Index (RSI)
 */
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length <= period) {
    return 50; // Neutral middle-ground RSI
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Checks for a Moving Average Crossover filtered by RSI
 */
export function analyzeMovingAverageCrossover(
  prices: number[],
  fastPeriod: number = 9,
  slowPeriod: number = 21
): StrategyResult {
  const minRequiredLength = slowPeriod + 1;

  if (prices.length < minRequiredLength) {
    return {
      signal: "HOLD",
      reason: `Insufficient data: Need at least ${minRequiredLength} historical prices, currently have ${prices.length}.`,
      fastSma: 0,
      slowSma: 0,
      rsi: 50,
    };
  }

  const currentFastSma = calculateSMA(prices, fastPeriod);
  const currentSlowSma = calculateSMA(prices, slowPeriod);

  const previousPrices = prices.slice(0, prices.length - 1);
  const previousFastSma = calculateSMA(previousPrices, fastPeriod);
  const previousSlowSma = calculateSMA(previousPrices, slowPeriod);

  const currentRsi = calculateRSI(prices, 14);

  const debugMessage = `Fast SMA: ${currentFastSma.toFixed(2)}, Slow SMA: ${currentSlowSma.toFixed(2)}, RSI: ${currentRsi.toFixed(2)}`;

  // Golden Cross (Buy signal)
  if (currentFastSma > currentSlowSma && previousFastSma <= previousSlowSma) {
    if (currentRsi >= 70) {
      return {
        signal: "HOLD",
        reason: `Golden Cross IGNORED! Stock is extremely overbought (RSI: ${currentRsi.toFixed(2)} >= 70).`,
        fastSma: currentFastSma,
        slowSma: currentSlowSma,
        rsi: currentRsi,
      };
    }

    return {
      signal: "BUY",
      reason: `Golden Cross! Fast SMA (${currentFastSma.toFixed(2)}) crossed above Slow SMA (${currentSlowSma.toFixed(2)}) | RSI: ${currentRsi.toFixed(2)}.`,
      fastSma: currentFastSma,
      slowSma: currentSlowSma,
      rsi: currentRsi,
    };
  }

  // Death Cross (Sell signal)
  if (currentFastSma < currentSlowSma && previousFastSma >= previousSlowSma) {
    return {
      signal: "SELL",
      reason: `Death Cross! Fast SMA (${currentFastSma.toFixed(2)}) crossed below Slow SMA (${currentSlowSma.toFixed(2)}) | RSI: ${currentRsi.toFixed(2)}.`,
      fastSma: currentFastSma,
      slowSma: currentSlowSma,
      rsi: currentRsi,
    };
  }

  return {
    signal: "HOLD",
    reason: `No crossover detected. ${debugMessage}`,
    fastSma: currentFastSma,
    slowSma: currentSlowSma,
    rsi: currentRsi,
  };
}
