/**
 * Mathematical helper to calculate the Simple Moving Average (SMA)
 * @param prices Array of numbers representing closing prices
 * @param period Number of periods to average over (e.g. 9 or 21)
 */
export function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) {
    return 0; // Not enough data points to compute SMA
  }
  const slice = prices.slice(prices.length - period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Mathematical helper to calculate the 14-Period Relative Strength Index (RSI)
 * @param prices Array of chronological closing prices
 * @param period The lookback period (default 14)
 */
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length <= period) {
    return 50; // Return middle-ground neutral RSI if insufficient data
  }

  let gains = 0;
  let losses = 0;

  // Calculate first average gain and average loss
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Apply smoothing multiplier to the remaining periods
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100; // Protect against division by zero if there are only gains
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export type TradingSignal = "BUY" | "SELL" | "HOLD";

export interface StrategyResult {
  signal: TradingSignal;
  reason: string;
  fastSma: number;
  slowSma: number;
  rsi?: number;
}

/**
 * Checks for a Moving Average Crossover filtered by a 14-Period RSI
 * @param prices Array of chronological closing prices (oldest to newest)
 * @param fastPeriod The fast SMA period (default 9)
 * @param slowPeriod The slow SMA period (default 21)
 */
export function analyzeMovingAverageCrossover(
  prices: number[],
  fastPeriod: number = 9,
  slowPeriod: number = 21
): StrategyResult {
  const minRequiredLength = slowPeriod + 1; // Need at least slowPeriod + 1 to check current AND previous bar for crossovers
  
  if (prices.length < minRequiredLength) {
    return {
      signal: "HOLD",
      reason: `Insufficient data: Need at least ${minRequiredLength} historical prices, currently have ${prices.length}.`,
      fastSma: 0,
      slowSma: 0,
    };
  }

  // Calculate current SMAs
  const currentFastSma = calculateSMA(prices, fastPeriod);
  const currentSlowSma = calculateSMA(prices, slowPeriod);

  // Calculate previous SMAs (by slicing off the very last price)
  const previousPrices = prices.slice(0, prices.length - 1);
  const previousFastSma = calculateSMA(previousPrices, fastPeriod);
  const previousSlowSma = calculateSMA(previousPrices, slowPeriod);

  // Calculate current RSI (14-period)
  const currentRsi = calculateRSI(prices, 14);

  // Debug log helpful for students
  const debugMessage = `Fast SMA: ${currentFastSma.toFixed(2)}, Slow SMA: ${currentSlowSma.toFixed(2)}, RSI: ${currentRsi.toFixed(2)}`;

  // 1. Golden Cross: Fast SMA crosses ABOVE Slow SMA
  if (
    currentFastSma > currentSlowSma &&
    previousFastSma <= previousSlowSma
  ) {
    // 🛡️ APPLY MOMENTUM FILTER: If stock is already overbought (RSI >= 70), ignore the buy signal!
    if (currentRsi >= 70) {
      return {
        signal: "HOLD",
        reason: `Golden Cross IGNORED! Stock is extremely overbought (RSI: ${currentRsi.toFixed(2)} >= 70). Risk of immediate pullback is high.`,
        fastSma: currentFastSma,
        slowSma: currentSlowSma,
        rsi: currentRsi,
      };
    }

    return {
      signal: "BUY",
      reason: `Golden Cross! Fast SMA (${currentFastSma.toFixed(2)}) crossed above Slow SMA (${currentSlowSma.toFixed(2)}) | RSI is supportive (${currentRsi.toFixed(2)} < 70).`,
      fastSma: currentFastSma,
      slowSma: currentSlowSma,
      rsi: currentRsi,
    };
  }

  // 2. Death Cross: Fast SMA crosses BELOW Slow SMA
  if (
    currentFastSma < currentSlowSma &&
    previousFastSma >= previousSlowSma
  ) {
    return {
      signal: "SELL",
      reason: `Death Cross! Fast SMA (${currentFastSma.toFixed(2)}) crossed below Slow SMA (${currentSlowSma.toFixed(2)}) | RSI: ${currentRsi.toFixed(2)}.`,
      fastSma: currentFastSma,
      slowSma: currentSlowSma,
      rsi: currentRsi,
    };
  }

  // 3. No Crossover
  return {
    signal: "HOLD",
    reason: `No crossover detected. ${debugMessage}`,
    fastSma: currentFastSma,
    slowSma: currentSlowSma,
    rsi: currentRsi,
  };
}
