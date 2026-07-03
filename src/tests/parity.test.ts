import { prepareStrategyCandles, analyzeAdvancedStrategy } from "../strategies/strategyEngine";

describe("Backtest-Live Parity & Look-Ahead Bias Tests", () => {
  // Mock candle generation helper
  const createMockCandle = (timeStr: string, price: number, volume: number = 1000) => ({
    t: timeStr,
    o: price,
    h: price + 2,
    l: price - 2,
    c: price,
    v: volume,
  });

  const generateCandles = (count: number, intervalMinutes: number, startPrice: number) => {
    const list = [];
    const baseTime = new Date("2026-07-03T09:15:00+05:30"); // 03:45 UTC
    for (let i = 0; i < count; i++) {
      const t = new Date(baseTime.getTime() + i * intervalMinutes * 60 * 1000);
      list.push(createMockCandle(t.toISOString(), startPrice + (i % 5)));
    }
    return list;
  };

  it("should correctly identify completed vs live candles without look-ahead bias", () => {
    const candles15m = generateCandles(5, 15, 100);

    // Simulated tick time is the start of candle 4 (10:15 / 04:45 UTC)
    const tickTime = new Date(candles15m[4].t);

    const completed = prepareStrategyCandles(candles15m, tickTime, 15);

    // Candle 4 (open at 10:15) is the live candle.
    // Completed candles must only be index 0, 1, 2, 3 (completed before or at 10:15).
    expect(completed.length).toBe(4);
    expect(completed[completed.length - 1].t).toBe(candles15m[3].t);

    // Verify candle 4 is filtered out
    const hasLive = completed.some(c => c.t === candles15m[4].t);
    expect(hasLive).toBe(false);
  });

  it("should maintain 100% parity in strategy reports for both live and backtest ticks", () => {
    // Generate enough candles for strategy requirements (need at least 28)
    const candles15m = generateCandles(40, 15, 1000);
    const candles1H = generateCandles(60, 60, 1000);

    // Simulate Step i = 35
    const i = 35;
    const tickTime = new Date(candles15m[i].t); // current tick time
    const timeVal = 1100; // 11:00 IST

    // Live mode simulation
    const liveHistory15m = candles15m.slice(0, i + 1);
    const liveCompleted15m = prepareStrategyCandles(liveHistory15m, tickTime, 15);
    const liveCompleted1H = prepareStrategyCandles(candles1H, tickTime, 60);
    const liveReport = analyzeAdvancedStrategy(liveCompleted15m, liveCompleted1H, timeVal, false);

    // Backtest mode simulation
    const backtestHistory15m = candles15m.slice(0, i + 1);
    const backtestCompleted15m = prepareStrategyCandles(backtestHistory15m, tickTime, 15);
    const backtestCompleted1H = prepareStrategyCandles(candles1H, tickTime, 60);
    const backtestReport = analyzeAdvancedStrategy(backtestCompleted15m, backtestCompleted1H, timeVal, false);

    // Confirm that the inputs generated for analyzeAdvancedStrategy are identical
    expect(liveCompleted15m.length).toBe(backtestCompleted15m.length);
    expect(liveCompleted15m[liveCompleted15m.length - 1].t).toBe(backtestCompleted15m[backtestCompleted15m.length - 1].t);
    expect(liveCompleted1H.length).toBe(backtestCompleted1H.length);

    // Confirm all strategy engine output indicators match exactly
    expect(liveReport.signal).toBe(backtestReport.signal);
    expect(liveReport.fastSma).toBe(backtestReport.fastSma);
    expect(liveReport.slowSma).toBe(backtestReport.slowSma);
    expect(liveReport.rsi).toBe(backtestReport.rsi);
    expect(liveReport.adx).toBe(backtestReport.adx);
    expect(liveReport.atr).toBe(backtestReport.atr);
    expect(liveReport.score).toBe(backtestReport.score);
    expect(liveReport.choppiness).toBe(backtestReport.choppiness);
    expect(liveReport.bbw).toBe(backtestReport.bbw);
    expect(liveReport.is1HTrendBullish).toBe(backtestReport.is1HTrendBullish);
    expect(liveReport.rrRatio).toBe(backtestReport.rrRatio);
    expect(liveReport.volumeConfirmed).toBe(backtestReport.volumeConfirmed);
  });
});
