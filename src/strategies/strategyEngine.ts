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

  console.log(`[INDICATORS]
Fast SMA: ${currentFastSma.toFixed(2)}
Slow SMA: ${currentSlowSma.toFixed(2)}
RSI: ${currentRsi.toFixed(2)}`);

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

// ─────────────────────────────────────────────────────────────────────────────
// Advanced Trading Strategy Indicators (ATR, ADX, EMA, Choppiness, BBW)
// ─────────────────────────────────────────────────────────────────────────────

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  let ema = calculateSMA(prices.slice(0, period), period);
  const k = 2 / (period + 1);
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * k + ema;
  }
  return ema;
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (highs.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  if (trs.length < period) return 0;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

export function calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (highs.length < period * 2) return 20; // Default safe fallback
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);

    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }

  if (trs.length < period) return 20;

  let trSmoothed = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMSmoothed = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMSmoothed = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxs: number[] = [];
  const calculateDXVal = (trS: number, pS: number, mS: number) => {
    if (trS === 0) return 0;
    const plusDI = (pS / trS) * 100;
    const minusDI = (mS / trS) * 100;
    const sum = plusDI + minusDI;
    if (sum === 0) return 0;
    return (Math.abs(plusDI - minusDI) / sum) * 100;
  };

  dxs.push(calculateDXVal(trSmoothed, plusDMSmoothed, minusDMSmoothed));

  for (let i = period; i < trs.length; i++) {
    trSmoothed = trSmoothed - (trSmoothed / period) + trs[i];
    plusDMSmoothed = plusDMSmoothed - (plusDMSmoothed / period) + plusDM[i];
    minusDMSmoothed = minusDMSmoothed - (minusDMSmoothed / period) + minusDM[i];
    dxs.push(calculateDXVal(trSmoothed, plusDMSmoothed, minusDMSmoothed));
  }

  if (dxs.length < period) return 20;

  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return adx;
}

export function calculateChoppiness(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (highs.length < period) return 50;
  let sumTR = 0;
  for (let i = highs.length - period; i < highs.length; i++) {
    const prevClose = i > 0 ? closes[i - 1] : closes[i];
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose)
    );
    sumTR += tr;
  }
  const highestHigh = Math.max(...highs.slice(highs.length - period));
  const lowestLow = Math.min(...lows.slice(lows.length - period));
  const range = highestHigh - lowestLow;
  if (range === 0) return 50;
  return 100 * Math.log10(sumTR / range) / Math.log10(period);
}

export function calculateBBW(prices: number[], period: number = 20): number {
  if (prices.length < period) return 0.1;
  const slice = prices.slice(prices.length - period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stddev = Math.sqrt(variance);
  if (sma === 0) return 0.1;
  return (stddev * 4) / sma;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable candle preprocessing function to eliminate look-ahead bias
// ─────────────────────────────────────────────────────────────────────────────
export function prepareStrategyCandles(
  candles: UpstoxBar[],
  currentTime: Date,
  timeframeMinutes: number
): UpstoxBar[] {
  const cutoffTime = currentTime.getTime();
  return candles.filter(c => {
    const candleOpenTime = new Date(c.t).getTime();
    return candleOpenTime + timeframeMinutes * 60 * 1000 <= cutoffTime;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Advanced Trading Strategy Logic
// ─────────────────────────────────────────────────────────────────────────────

export interface AdvancedStrategyResult extends StrategyResult {
  adx: number;
  atr: number;
  score: number;
  choppiness: number;
  bbw: number;
  is1HTrendBullish: boolean;
  rrRatio: number;
  volumeConfirmed: boolean;
}

export function analyzeAdvancedStrategy(
  rawCandles15m: UpstoxBar[],
  rawCandles1H: UpstoxBar[],
  timeVal: number,
  isManagingPosition: boolean
): AdvancedStrategyResult {
  const completed15m = rawCandles15m;


  const minRequiredLength = 28; // Require sufficient history for indicators
  if (completed15m.length < minRequiredLength) {
    return {
      signal: "HOLD",
      reason: `Insufficient data: Need at least ${minRequiredLength} historical 15m candles, currently have ${completed15m.length}.`,
      fastSma: 0,
      slowSma: 0,
      rsi: 50,
      adx: 20,
      atr: 0,
      score: 0,
      choppiness: 50,
      bbw: 0.1,
      is1HTrendBullish: true,
      rrRatio: 0,
      volumeConfirmed: false,
    };
  }

  const closes15m = completed15m.map(c => c.c);
  const highs15m = completed15m.map(c => c.h);
  const lows15m = completed15m.map(c => c.l);
  const volumes15m = completed15m.map(c => c.v);

  const currentFastSma = calculateSMA(closes15m, 9);
  const currentSlowSma = calculateSMA(closes15m, 21);
  const previousFastSma = calculateSMA(closes15m.slice(0, -1), 9);
  const previousSlowSma = calculateSMA(closes15m.slice(0, -1), 21);

  const currentRsi = calculateRSI(closes15m, 14);
  const currentAdx = calculateADX(highs15m, lows15m, closes15m, 14);
  const currentAtr = calculateATR(highs15m, lows15m, closes15m, 14);
  const choppiness = calculateChoppiness(highs15m, lows15m, closes15m, 14);
  const bbw = calculateBBW(closes15m, 20);

  const avgVolume = calculateSMA(volumes15m, 20);
  const lastVolume = volumes15m[volumes15m.length - 1];

  // 1H Timeframe Trend Filter
  let is1HTrendBullish = true;
  if (rawCandles1H.length >= 50) {
    const closes1H = rawCandles1H.map(c => c.c);
    const ema50_1H = calculateEMA(closes1H, 50);
    const lastClose1H = closes1H[closes1H.length - 1];
    is1HTrendBullish = lastClose1H > ema50_1H;
  }

  // Sideways market check
  const isSideways = currentAdx < 25 || choppiness > 61.8 || bbw < 0.01;

  // Entry crossover check
  const isGoldenCross = currentFastSma > currentSlowSma && previousFastSma <= previousSlowSma;
  const isDeathCross = currentFastSma < currentSlowSma && previousFastSma >= previousSlowSma;

  // Risk/Reward evaluation
  const stopDistance = 2 * currentAtr;
  const resistance = Math.max(...highs15m.slice(-20));
  const entryPrice = closes15m[closes15m.length - 1];
  const rrRatio = stopDistance > 0 ? (resistance - entryPrice) / stopDistance : 0;

  // Filter validations
  const isTimeOk = isManagingPosition || !((timeVal >= 915 && timeVal <= 930) || (timeVal >= 1500 && timeVal <= 1530));
  const isAdxOk = currentAdx >= 25;
  const isRsiOk = currentRsi > 55 && currentRsi < 70;
  const isVolumeOk = lastVolume > avgVolume;
  const isRiskRewardOk = rrRatio >= 2.0;
  const isSidewaysOk = !isSideways;

  // Scoring matrix
  let score = 0;
  if (is1HTrendBullish && currentFastSma > currentSlowSma) score += 30;
  else if (is1HTrendBullish || currentFastSma > currentSlowSma) score += 15;

  if (currentAdx >= 40) score += 20;
  else if (currentAdx >= 25) score += 15;

  if (currentRsi >= 55 && currentRsi <= 65) score += 15;
  else if (currentRsi > 65 && currentRsi < 70) score += 10;

  if (lastVolume > 1.5 * avgVolume) score += 15;
  else if (lastVolume > avgVolume) score += 10;

  if (rrRatio >= 3.0) score += 20;
  else if (rrRatio >= 2.0) score += 15;

  // Evaluate exits first if managing position
  if (isManagingPosition) {
    if (isDeathCross) {
      return {
        signal: "SELL",
        reason: `Death Cross exit triggered! Fast SMA crossed below Slow SMA.`,
        fastSma: currentFastSma,
        slowSma: currentSlowSma,
        rsi: currentRsi,
        adx: currentAdx,
        atr: currentAtr,
        score,
        choppiness,
        bbw,
        is1HTrendBullish,
        rrRatio,
        volumeConfirmed: isVolumeOk,
      };
    }
    return {
      signal: "HOLD",
      reason: `Managing position. Death Cross not triggered.`,
      fastSma: currentFastSma,
      slowSma: currentSlowSma,
      rsi: currentRsi,
      adx: currentAdx,
      atr: currentAtr,
      score,
      choppiness,
      bbw,
      is1HTrendBullish,
      rrRatio,
      volumeConfirmed: isVolumeOk,
    };
  }

  // Evaluate entries
  if (isGoldenCross) {
    const failures: string[] = [];
    if (!isTimeOk) failures.push("Market volatility hours (9:15-9:30 / 15:00-15:30)");
    if (!isAdxOk) failures.push(`Low trend strength (ADX ${currentAdx.toFixed(1)} < 25)`);
    if (!isRsiOk) failures.push(`RSI out of range (RSI ${currentRsi.toFixed(1)} must be between 55 and 70)`);
    if (!isVolumeOk) failures.push(`Low volume confirmation (Volume ${lastVolume} <= 20 SMA ${avgVolume.toFixed(0)})`);
    if (!is1HTrendBullish) failures.push("Higher timeframe (1H) trend is Bearish (below 50 EMA)");
    if (!isSidewaysOk) failures.push(`Sideways market detected (ADX < 25 or Choppiness > 61.8 or BBW < 1%)`);
    if (!isRiskRewardOk) failures.push(`Risk/Reward too low (R/R ${rrRatio.toFixed(2)} < 2.0)`);
    if (score < 60) failures.push(`Low Trade Quality Score (${score}/100 < 60/100)`);

    if (failures.length === 0) {
      return {
        signal: "BUY",
        reason: `All signals aligned! Golden Cross Crossover | Score: ${score}/100 | RSI: ${currentRsi.toFixed(1)} | ADX: ${currentAdx.toFixed(1)} | R/R: ${rrRatio.toFixed(2)}.`,
        fastSma: currentFastSma,
        slowSma: currentSlowSma,
        rsi: currentRsi,
        adx: currentAdx,
        atr: currentAtr,
        score,
        choppiness,
        bbw,
        is1HTrendBullish,
        rrRatio,
        volumeConfirmed: true,
      };
    } else {
      return {
        signal: "HOLD",
        reason: `Golden Cross ignored due to: ${failures.join("; ")}.`,
        fastSma: currentFastSma,
        slowSma: currentSlowSma,
        rsi: currentRsi,
        adx: currentAdx,
        atr: currentAtr,
        score,
        choppiness,
        bbw,
        is1HTrendBullish,
        rrRatio,
        volumeConfirmed: isVolumeOk,
      };
    }
  }

  return {
    signal: "HOLD",
    reason: `No crossover detected. Fast SMA: ${currentFastSma.toFixed(2)}, Slow SMA: ${currentSlowSma.toFixed(2)}, RSI: ${currentRsi.toFixed(2)} | ADX: ${currentAdx.toFixed(1)} | Choppiness: ${choppiness.toFixed(1)}.`,
    fastSma: currentFastSma,
    slowSma: currentSlowSma,
    rsi: currentRsi,
    adx: currentAdx,
    atr: currentAtr,
    score,
    choppiness,
    bbw,
    is1HTrendBullish,
    rrRatio,
    volumeConfirmed: isVolumeOk,
  };
}
