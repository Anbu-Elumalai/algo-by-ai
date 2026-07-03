// src/scripts/trade_replay_audit.ts
// ─────────────────────────────────────────────────────────────────────────────
//  PAPER TRADE REPLAY AUDIT — Full Entry/Exit Condition Verification
//  Principal Rules:
//  1. Every BUY re-evaluated against all 8 conditions using COMPLETED candles
//     only (no live candle contamination) at the exact trade timestamp.
//  2. If ANY condition was not met → FALSE ENTRY.
//  3. False Exits, False Stops, Late Entries, Late Exits, Missed Entries
//     all identified from candle history.
//  4. Old vs New strategy full performance comparison with improvement %.
//  DO NOT ESTIMATE. Calculate everything from actual MongoDB + Upstox data.
// ─────────────────────────────────────────────────────────────────────────────

import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import axios from "axios";
import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { upstoxConfig } from "../config/upstox";
import {
  calculateSMA,
  calculateRSI,
  calculateATR,
  calculateADX,
  calculateEMA,
  calculateChoppiness,
  calculateBBW,
  analyzeMovingAverageCrossover,
} from "../strategies/strategyEngine";

// ─── Types ───────────────────────────────────────────────────────────────────

interface UpstoxBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface ConditionResult {
  pass: boolean;
  value: string;
}

interface EntryConditions {
  goldenCross: ConditionResult;
  rsi: ConditionResult;
  adx: ConditionResult;
  volume: ConditionResult;
  trend1H: ConditionResult;
  atr: ConditionResult;
  riskReward: ConditionResult;
  tradeScore: ConditionResult;
  time: ConditionResult;
  sideways: ConditionResult;
  allPass: boolean;
  failedConditions: string[];
  score: number;
}

interface ReplayedTrade {
  // From MongoDB
  symbol: string;
  action: "BUY" | "SELL";
  price: number;
  qty: number;
  buyTime: Date;
  sellTime?: Date;
  sellPrice?: number;
  signalReason: string;
  // Computed
  grossProfit?: number;
  netProfit?: number;
  fees: number;
  holdingMinutes?: number;
  // Audit
  conditions?: EntryConditions;
  isFalseEntry: boolean;
  isFalseExit: boolean;
  isFalseStop: boolean;
  isLateEntry: boolean;
  isLateExit: boolean;
  auditNotes: string[];
}

interface BacktestReport {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  winRate: number;
  profitFactor: number | string;
  expectancy: number;
  maxDrawdownRs: number;
  maxDrawdownPct: number;
  avgWin: number;
  avgLoss: number;
  avgHoldingMin: number;
  falseSignalsBlocked?: number;
}

// ─── Candle cache to minimize API calls ──────────────────────────────────────
const candleCache15m: Record<string, UpstoxBar[]> = {};
const candleCache1H: Record<string, UpstoxBar[]> = {};

async function fetchAllCandles(
  symbol: string,
  fromDate: Date,
  toDate: Date
): Promise<{ candles15m: UpstoxBar[]; candles1H: UpstoxBar[] }> {
  const cacheKey = `${symbol}_${fromDate.toISOString().split("T")[0]}_${toDate.toISOString().split("T")[0]}`;
  if (candleCache15m[cacheKey] && candleCache1H[cacheKey]) {
    return { candles15m: candleCache15m[cacheKey], candles1H: candleCache1H[cacheKey] };
  }

  const token = upstoxConfig.getInstrumentToken(symbol);
  const toStr = toDate.toISOString().split("T")[0];
  const fromStr = fromDate.toISOString().split("T")[0];

  const headers = {
    Authorization: `Bearer ${upstoxConfig.accessToken}`,
    Accept: "application/json",
  };

  // Fetch 15m candles
  const url15m = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/minutes/15/${toStr}/${fromStr}`;
  const res15m = await axios.get(url15m, { headers, timeout: 15000 });
  const raw15m = res15m.data?.data?.candles || [];
  const candles15m: UpstoxBar[] = raw15m
    .map((c: any) => ({
      t: c[0],
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      v: parseInt(c[5] || 0),
    }))
    .reverse();

  // Fetch 1H candles
  const url1H = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/minutes/60/${toStr}/${fromStr}`;
  const res1H = await axios.get(url1H, { headers, timeout: 15000 });
  const raw1H = res1H.data?.data?.candles || [];
  const candles1H: UpstoxBar[] = raw1H
    .map((c: any) => ({
      t: c[0],
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      v: parseInt(c[5] || 0),
    }))
    .reverse();

  candleCache15m[cacheKey] = candles15m;
  candleCache1H[cacheKey] = candles1H;

  return { candles15m, candles1H };
}

// ─── Get candles UP TO a specific timestamp (exclusive) ──────────────────────
// Returns only COMPLETED candles: candles whose close time is <= tradeTimeMs
function getCandlesUpToTime(
  candles: UpstoxBar[],
  tradeTimeMs: number,
  intervalMs: number
): UpstoxBar[] {
  // A candle at time T covers [T, T+intervalMs). It is "completed" when T+intervalMs <= tradeTimeMs.
  return candles.filter((c) => {
    const candleStartMs = new Date(c.t).getTime();
    const candleEndMs = candleStartMs + intervalMs;
    return candleEndMs <= tradeTimeMs;
  });
}

// ─── Evaluate all entry conditions at exact trade time ────────────────────────
function evaluateEntryConditions(
  completedCandles15m: UpstoxBar[],
  completedCandles1H: UpstoxBar[],
  tradeTime: Date
): EntryConditions {
  const timeMs = tradeTime.getTime();
  const ist = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  const timeVal = ist.getUTCHours() * 100 + ist.getUTCMinutes();

  const closes = completedCandles15m.map((c) => c.c);
  const highs = completedCandles15m.map((c) => c.h);
  const lows = completedCandles15m.map((c) => c.l);
  const volumes = completedCandles15m.map((c) => c.v);

  const n = completedCandles15m.length;

  // ── Golden Cross (SMA9 vs SMA21) ──
  const fastSma = calculateSMA(closes, 9);
  const slowSma = calculateSMA(closes, 21);
  const prevFastSma = n >= 10 ? calculateSMA(closes.slice(0, -1), 9) : 0;
  const prevSlowSma = n >= 22 ? calculateSMA(closes.slice(0, -1), 21) : 0;
  const isGoldenCross =
    fastSma > slowSma && prevFastSma <= prevSlowSma;

  // ── RSI (must be 55–70) ──
  const rsi = calculateRSI(closes, 14);
  const isRsiOk = rsi > 55 && rsi < 70;

  // ── ADX (>= 25) ──
  const adx = n >= 28 ? calculateADX(highs, lows, closes, 14) : 20;
  const isAdxOk = adx >= 25;

  // ── Volume (last > 20-SMA of volume) ──
  const avgVol = calculateSMA(volumes, 20);
  const lastVol = volumes[volumes.length - 1] ?? 0;
  const isVolumeOk = lastVol > avgVol;

  // ── 1H Trend (close > EMA50 on 1H) ──
  let is1HTrendBullish = true; // default to pass when insufficient data
  let ema50_1H = 0;
  let lastClose1H = 0;
  if (completedCandles1H.length >= 51) {
    const closes1H = completedCandles1H.map((c) => c.c);
    ema50_1H = calculateEMA(closes1H, 50);
    lastClose1H = closes1H[closes1H.length - 1];
    is1HTrendBullish = lastClose1H > ema50_1H;
  }

  // ── ATR (must be > 0) ──
  const atr = n >= 15 ? calculateATR(highs, lows, closes, 14) : 0;
  const isAtrOk = atr > 0;

  // ── Risk/Reward (>= 2.0) ──
  const stopDistance = 2 * atr;
  const resistance = highs.length >= 20 ? Math.max(...highs.slice(-20)) : 0;
  const entryPrice = closes[closes.length - 1] ?? 0;
  const rrRatio = stopDistance > 0 ? (resistance - entryPrice) / stopDistance : 0;
  const isRiskRewardOk = rrRatio >= 2.0;

  // ── Sideways filter ──
  const choppiness = n >= 14 ? calculateChoppiness(highs, lows, closes, 14) : 50;
  const bbw = n >= 20 ? calculateBBW(closes, 20) : 0.1;
  const isSideways = adx < 25 || choppiness > 61.8 || bbw < 0.01;
  const isSidewaysOk = !isSideways;

  // ── Time filter ──
  const isTimeOk =
    !((timeVal >= 915 && timeVal <= 930) || (timeVal >= 1500 && timeVal <= 1530));

  // ── Trade Score ──
  let score = 0;
  if (is1HTrendBullish && fastSma > slowSma) score += 30;
  else if (is1HTrendBullish || fastSma > slowSma) score += 15;
  if (adx >= 40) score += 20;
  else if (adx >= 25) score += 15;
  if (rsi >= 55 && rsi <= 65) score += 15;
  else if (rsi > 65 && rsi < 70) score += 10;
  if (lastVol > 1.5 * avgVol) score += 15;
  else if (lastVol > avgVol) score += 10;
  if (rrRatio >= 3.0) score += 20;
  else if (rrRatio >= 2.0) score += 15;

  const isScoreOk = score >= 60;

  // ── Collect failures ──
  const failedConditions: string[] = [];
  if (!isGoldenCross) failedConditions.push(`Golden Cross MISSING (FastSMA=${fastSma.toFixed(2)}, SlowSMA=${slowSma.toFixed(2)}, prevFast=${prevFastSma.toFixed(2)}, prevSlow=${prevSlowSma.toFixed(2)})`);
  if (!isRsiOk) failedConditions.push(`RSI ${rsi.toFixed(1)} not in [55, 70)`);
  if (!isAdxOk) failedConditions.push(`ADX ${adx.toFixed(1)} < 25`);
  if (!isVolumeOk) failedConditions.push(`Volume ${lastVol} <= AvgVol ${avgVol.toFixed(0)}`);
  if (!is1HTrendBullish) failedConditions.push(`1H trend Bearish (close=${lastClose1H.toFixed(2)}, EMA50=${ema50_1H.toFixed(2)})`);
  if (!isAtrOk) failedConditions.push(`ATR = 0 (insufficient data)`);
  if (!isRiskRewardOk) failedConditions.push(`R/R ${rrRatio.toFixed(2)} < 2.0`);
  if (!isSidewaysOk) failedConditions.push(`Sideways market (ADX=${adx.toFixed(1)}, Choppiness=${choppiness.toFixed(1)}, BBW=${bbw.toFixed(3)})`);
  if (!isTimeOk) failedConditions.push(`Restricted time window (${timeVal})`);
  if (!isScoreOk) failedConditions.push(`Trade score ${score}/100 < 60`);

  return {
    goldenCross: { pass: isGoldenCross, value: `FastSMA=${fastSma.toFixed(2)}, SlowSMA=${slowSma.toFixed(2)}` },
    rsi: { pass: isRsiOk, value: rsi.toFixed(1) },
    adx: { pass: isAdxOk, value: adx.toFixed(1) },
    volume: { pass: isVolumeOk, value: `${lastVol} vs AvgVol ${avgVol.toFixed(0)}` },
    trend1H: { pass: is1HTrendBullish, value: completedCandles1H.length >= 51 ? `Close=${lastClose1H.toFixed(2)}, EMA50=${ema50_1H.toFixed(2)}` : "Insufficient 1H data (default PASS)" },
    atr: { pass: isAtrOk, value: atr.toFixed(4) },
    riskReward: { pass: isRiskRewardOk, value: rrRatio.toFixed(2) },
    tradeScore: { pass: isScoreOk, value: `${score}/100` },
    time: { pass: isTimeOk, value: String(timeVal) },
    sideways: { pass: isSidewaysOk, value: `ADX=${adx.toFixed(1)}, Choppiness=${choppiness.toFixed(1)}, BBW=${bbw.toFixed(3)}` },
    allPass: failedConditions.length === 0,
    failedConditions,
    score,
  };
}

// ─── FIFO Trade Pairing ───────────────────────────────────────────────────────
interface PairedTrade {
  symbol: string;
  buyPrice: number;
  sellPrice: number;
  qty: number;
  buyFees: number;
  sellFees: number;
  grossProfit: number;
  netProfit: number;
  buyTime: Date;
  sellTime: Date;
  holdingMs: number;
  buySignalReason: string;
  sellSignalReason: string;
}

function pairTradesFIFO(allLogs: TradeLog[]): PairedTrade[] {
  const sorted = [...allLogs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const buyQueues: Record<string, { log: TradeLog; remaining: number }[]> = {};
  const paired: PairedTrade[] = [];

  for (const log of sorted) {
    const sym = log.symbol.toUpperCase();

    if (log.action === "BUY") {
      if (!buyQueues[sym]) buyQueues[sym] = [];
      buyQueues[sym].push({ log, remaining: log.qty });
    } else if (log.action === "SELL") {
      if (!buyQueues[sym] || buyQueues[sym].length === 0) {
        console.warn(`  ⚠️  ORPHANED SELL: ${sym} qty=${log.qty} at ${log.createdAt}`);
        continue;
      }

      let remainSell = log.qty;
      const totalSellFees = log.transactionFees ?? 0;

      while (remainSell > 0 && buyQueues[sym].length > 0) {
        const buyEntry = buyQueues[sym][0];
        const matchQty = Math.min(remainSell, buyEntry.remaining);

        const sellFeesPortion = (matchQty / log.qty) * totalSellFees;
        const buyFeesPortion = (matchQty / buyEntry.log.qty) * (buyEntry.log.transactionFees ?? 0);

        const grossPnl = (log.price - buyEntry.log.price) * matchQty;
        const netPnl = grossPnl - buyFeesPortion - sellFeesPortion;

        paired.push({
          symbol: sym,
          buyPrice: buyEntry.log.price,
          sellPrice: log.price,
          qty: matchQty,
          buyFees: Number(buyFeesPortion.toFixed(2)),
          sellFees: Number(sellFeesPortion.toFixed(2)),
          grossProfit: Number(grossPnl.toFixed(2)),
          netProfit: Number(netPnl.toFixed(2)),
          buyTime: new Date(buyEntry.log.createdAt),
          sellTime: new Date(log.createdAt),
          holdingMs: new Date(log.createdAt).getTime() - new Date(buyEntry.log.createdAt).getTime(),
          buySignalReason: buyEntry.log.signalReason || "",
          sellSignalReason: log.signalReason || "",
        });

        buyEntry.remaining -= matchQty;
        remainSell -= matchQty;

        if (buyEntry.remaining <= 0) {
          buyQueues[sym].shift();
        }
      }
    }
  }

  return paired;
}

// ─── Drawdown calculation ─────────────────────────────────────────────────────
function calcMaxDrawdown(
  pnlList: number[],
  startingCapital: number
): { maxDrawdownRs: number; maxDrawdownPct: number; finalEquity: number } {
  let equity = startingCapital;
  let peak = startingCapital;
  let maxDd = 0;

  for (const pnl of pnlList) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const maxDdPct = peak > 0 ? (maxDd / peak) * 100 : 0;
  return {
    maxDrawdownRs: Number(maxDd.toFixed(2)),
    maxDrawdownPct: Number(maxDdPct.toFixed(2)),
    finalEquity: Number(equity.toFixed(2)),
  };
}

// ─── Old strategy simulation ──────────────────────────────────────────────────
function runOldStrategy(candles15m: UpstoxBar[]): {
  trades: PairedTrade[];
  pnlList: number[];
  equityCurve: number[];
} {
  const STARTING_CAPITAL = 100000;
  let cash = STARTING_CAPITAL;
  const pnlList: number[] = [];
  const equityCurve: number[] = [STARTING_CAPITAL];
  const syntheticTrades: PairedTrade[] = [];
  let activeEntry: { price: number; qty: number; peakPrice: number; trailStop: number; entryIdx: number } | null = null;

  for (let i = 22; i < candles15m.length; i++) {
    const price = candles15m[i].c;

    if (activeEntry) {
      // Trail stop
      if (price > activeEntry.peakPrice) {
        activeEntry.peakPrice = price;
        activeEntry.trailStop = price * 0.98;
      }
      if (price <= activeEntry.trailStop) {
        const fees = 80;
        const pnl = (price - activeEntry.price) * activeEntry.qty - fees;
        pnlList.push(pnl);
        cash += activeEntry.qty * price - 40;
        syntheticTrades.push({
          symbol: "SIMULATION",
          buyPrice: activeEntry.price,
          sellPrice: price,
          qty: activeEntry.qty,
          buyFees: 40,
          sellFees: 40,
          grossProfit: (price - activeEntry.price) * activeEntry.qty,
          netProfit: pnl,
          buyTime: new Date(candles15m[activeEntry.entryIdx].t),
          sellTime: new Date(candles15m[i].t),
          holdingMs: new Date(candles15m[i].t).getTime() - new Date(candles15m[activeEntry.entryIdx].t).getTime(),
          buySignalReason: "Old Golden Cross",
          sellSignalReason: "Trail stop",
        });
        activeEntry = null;
        equityCurve.push(Number(cash.toFixed(2)));
        continue;
      }
    }

    const closes = candles15m.slice(0, i + 1).map((c) => c.c);
    // Old strategy uses RAW candles including live candle (as was the bug)
    const result = analyzeMovingAverageCrossover(closes, 9, 21);

    if (result.signal === "BUY" && !activeEntry) {
      const qty = 10;
      const cost = qty * price + 40;
      if (cash >= cost) {
        cash -= cost;
        activeEntry = {
          price,
          qty,
          peakPrice: price,
          trailStop: price * 0.98,
          entryIdx: i,
        };
      }
    }

    const posVal = activeEntry ? activeEntry.qty * price : 0;
    equityCurve.push(Number((cash + posVal).toFixed(2)));
  }

  // Close any open position at last price
  if (activeEntry) {
    const lastPrice = candles15m[candles15m.length - 1].c;
    const fees = 80;
    const pnl = (lastPrice - activeEntry.price) * activeEntry.qty - fees;
    pnlList.push(pnl);
  }

  return { trades: syntheticTrades, pnlList, equityCurve };
}

// ─── New strategy simulation ──────────────────────────────────────────────────
function runNewStrategy(
  candles15m: UpstoxBar[],
  candles1H: UpstoxBar[]
): {
  trades: PairedTrade[];
  pnlList: number[];
  equityCurve: number[];
  falseSignalsBlocked: number;
} {
  const STARTING_CAPITAL = 100000;
  let cash = STARTING_CAPITAL;
  let equity = STARTING_CAPITAL;
  const pnlList: number[] = [];
  const equityCurve: number[] = [STARTING_CAPITAL];
  const syntheticTrades: PairedTrade[] = [];
  let falseSignalsBlocked = 0;
  let lastProcessedTime = "";

  let activeEntry: {
    price: number;
    qty: number;
    peakPrice: number;
    trailStop: number;
    stopOffset: number;
    entryIdx: number;
  } | null = null;

  for (let i = 30; i < candles15m.length; i++) {
    const price = candles15m[i].c;

    // Use only COMPLETED candles (exclude live candle at index i)
    const completed15m = candles15m.slice(0, i);
    const lastCompleted = completed15m[completed15m.length - 1];

    const tickTimeMs = new Date(candles15m[i].t).getTime();
    const completed1H = candles1H.filter(
      (c) => new Date(c.t).getTime() + 60 * 60 * 1000 <= tickTimeMs
    );

    const ist = new Date(tickTimeMs + 5.5 * 3600000);
    const timeVal = ist.getUTCHours() * 100 + ist.getUTCMinutes();

    // Manage open position
    if (activeEntry) {
      if (price > activeEntry.peakPrice) {
        activeEntry.peakPrice = price;
        activeEntry.trailStop = Math.max(
          activeEntry.trailStop,
          price - activeEntry.stopOffset
        );
      }
      if (price <= activeEntry.trailStop) {
        const fees = 80;
        const pnl = (price - activeEntry.price) * activeEntry.qty - fees;
        pnlList.push(pnl);
        cash += activeEntry.qty * price - 40;
        syntheticTrades.push({
          symbol: "SIMULATION",
          buyPrice: activeEntry.price,
          sellPrice: price,
          qty: activeEntry.qty,
          buyFees: 40,
          sellFees: 40,
          grossProfit: (price - activeEntry.price) * activeEntry.qty,
          netProfit: pnl,
          buyTime: new Date(candles15m[activeEntry.entryIdx].t),
          sellTime: new Date(candles15m[i].t),
          holdingMs: new Date(candles15m[i].t).getTime() - new Date(candles15m[activeEntry.entryIdx].t).getTime(),
          buySignalReason: "New strategy BUY",
          sellSignalReason: "ATR trail stop",
        });
        activeEntry = null;
        equityCurve.push(Number(cash.toFixed(2)));
        continue;
      }
    }

    // Deduplicate: only evaluate once per completed candle
    if (lastCompleted && lastCompleted.t === lastProcessedTime) {
      const posVal = activeEntry ? activeEntry.qty * price : 0;
      equity = cash + posVal;
      equityCurve.push(Number(equity.toFixed(2)));
      continue;
    }
    if (lastCompleted) lastProcessedTime = lastCompleted.t;

    if (completed15m.length < 28) {
      equityCurve.push(Number(equity.toFixed(2)));
      continue;
    }

    // Evaluate conditions on completed candles
    const conditions = evaluateEntryConditions(completed15m, completed1H, new Date(candles15m[i].t));

    // Death Cross exit
    const closes15m = completed15m.map((c) => c.c);
    const fastSma = calculateSMA(closes15m, 9);
    const slowSma = calculateSMA(closes15m, 21);
    const prevFastSma = calculateSMA(closes15m.slice(0, -1), 9);
    const prevSlowSma = calculateSMA(closes15m.slice(0, -1), 21);
    const isDeathCross = fastSma < slowSma && prevFastSma >= prevSlowSma;

    if (activeEntry && isDeathCross) {
      const fees = 80;
      const pnl = (price - activeEntry.price) * activeEntry.qty - fees;
      pnlList.push(pnl);
      cash += activeEntry.qty * price - 40;
      syntheticTrades.push({
        symbol: "SIMULATION",
        buyPrice: activeEntry.price,
        sellPrice: price,
        qty: activeEntry.qty,
        buyFees: 40,
        sellFees: 40,
        grossProfit: (price - activeEntry.price) * activeEntry.qty,
        netProfit: pnl,
        buyTime: new Date(candles15m[activeEntry.entryIdx].t),
        sellTime: new Date(candles15m[i].t),
        holdingMs: new Date(candles15m[i].t).getTime() - new Date(candles15m[activeEntry.entryIdx].t).getTime(),
        buySignalReason: "New strategy BUY",
        sellSignalReason: "Death Cross exit",
      });
      activeEntry = null;
    }

    // BUY entry
    if (!activeEntry && conditions.allPass && conditions.goldenCross.pass) {
      const highs = completed15m.map((c) => c.h);
      const lows = completed15m.map((c) => c.l);
      const atr = calculateATR(highs, lows, closes15m, 14);
      const stopDistance = 2 * atr;

      const maxRisk = equity * 0.01;
      const qtyRisk = stopDistance > 0 ? Math.floor(maxRisk / stopDistance) : 0;
      const qtyCapLimit = Math.floor((equity * 0.1) / price);
      const qty = Math.min(qtyRisk, qtyCapLimit || 1);

      if (qty > 0 && cash >= qty * price + 40) {
        cash -= qty * price + 40;
        activeEntry = {
          price,
          qty,
          peakPrice: price,
          trailStop: price - 2 * atr,
          stopOffset: 1.5 * atr,
          entryIdx: i,
        };
      }
    } else if (!activeEntry) {
      // Old strategy would have entered but new strategy filtered it
      const oldResult = analyzeMovingAverageCrossover(closes15m, 9, 21);
      if (oldResult.signal === "BUY") falseSignalsBlocked++;
    }

    const posVal = activeEntry ? activeEntry.qty * price : 0;
    equity = cash + posVal;
    equityCurve.push(Number(equity.toFixed(2)));
  }

  // Close any open position at last price
  if (activeEntry) {
    const lastPrice = candles15m[candles15m.length - 1].c;
    const fees = 80;
    const pnl = (lastPrice - activeEntry.price) * activeEntry.qty - fees;
    pnlList.push(pnl);
  }

  return { trades: syntheticTrades, pnlList, equityCurve, falseSignalsBlocked };
}

// ─── Compile BacktestReport from pnlList + equityCurve ───────────────────────
function compileReport(
  label: string,
  pnlList: number[],
  equityCurve: number[],
  holdingMsArr: number[],
  falseSignalsBlocked?: number
): BacktestReport {
  const wins = pnlList.filter((p) => p > 0);
  const losses = pnlList.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netProfit = grossProfit - grossLoss;
  const winRate = pnlList.length > 0 ? wins.length / pnlList.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? "∞" : "N/A";
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const avgHoldingMin = holdingMsArr.length > 0 ? holdingMsArr.reduce((a, b) => a + b, 0) / holdingMsArr.length / 60000 : 0;

  let peak = 100000;
  let maxDd = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDdPct = peak > 0 ? (maxDd / peak) * 100 : 0;

  return {
    strategy: label,
    trades: pnlList.length,
    wins: wins.length,
    losses: losses.length,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    winRate: Number((winRate * 100).toFixed(2)),
    profitFactor,
    expectancy: Number(expectancy.toFixed(2)),
    maxDrawdownRs: Number(maxDd.toFixed(2)),
    maxDrawdownPct: Number(maxDdPct.toFixed(2)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    avgHoldingMin: Number(avgHoldingMin.toFixed(1)),
    falseSignalsBlocked,
  };
}

// ─── Print separator ──────────────────────────────────────────────────────────
function hr(c = "─", n = 80) {
  return c.repeat(n);
}

function fmt(n: number) {
  return `₹${n.toFixed(2)}`;
}

function pct(n: number) {
  return `${n.toFixed(2)}%`;
}

function pass(b: boolean) {
  return b ? "✅ PASS" : "❌ FAIL";
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(hr("=", 80));
  console.log("  PAPER TRADE REPLAY AUDIT — FULL ENTRY/EXIT CONDITION VERIFICATION");
  console.log(`  Generated: ${new Date().toISOString()}`);
  console.log(hr("=", 80));

  await AppDataSource.initialize();
  console.log("✅ Connected to MongoDB\n");

  const tradeRepo = AppDataSource.getMongoRepository(TradeLog);
  const allTrades = await tradeRepo.find();

  const buyLogs = allTrades.filter((t) => t.action === "BUY").sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const sellLogs = allTrades.filter((t) => t.action === "SELL").sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const pairedTrades = pairTradesFIFO(allTrades);
  pairedTrades.sort((a, b) => a.sellTime.getTime() - b.sellTime.getTime());

  console.log(`Raw BUY logs:        ${buyLogs.length}`);
  console.log(`Raw SELL logs:       ${sellLogs.length}`);
  console.log(`Paired (completed):  ${pairedTrades.length}`);
  console.log(`Open (unmatched):    ${Math.max(0, buyLogs.length - sellLogs.length)}`);
  console.log();

  if (buyLogs.length === 0) {
    console.log("⚠️  No BUY trades found in MongoDB. Nothing to replay.");
    await AppDataSource.destroy();
    return;
  }

  // ─── Determine candle fetch range ──────────────────────────────────────────
  const CANDLE_LOOKBACK_DAYS = 30;
  const symbols = [...new Set(allTrades.map((t) => t.symbol.toUpperCase()))];
  const globalToDate = new Date();
  globalToDate.setDate(globalToDate.getDate() + 1);
  const globalFromDate = new Date();
  globalFromDate.setDate(globalFromDate.getDate() - CANDLE_LOOKBACK_DAYS);

  // ─── Load candles for all symbols ─────────────────────────────────────────
  const candlesBySymbol: Record<string, { candles15m: UpstoxBar[]; candles1H: UpstoxBar[] }> = {};

  console.log(hr("─", 80));
  console.log(`LOADING HISTORICAL CANDLES (last ${CANDLE_LOOKBACK_DAYS} days)`);
  console.log(hr("─", 80));

  for (const sym of symbols) {
    try {
      console.log(`  ⏳ Fetching candles for ${sym}...`);
      const result = await fetchAllCandles(sym, globalFromDate, globalToDate);
      candlesBySymbol[sym] = result;
      console.log(`  ✅ ${sym}: ${result.candles15m.length} x 15m candles, ${result.candles1H.length} x 1H candles`);
    } catch (err: any) {
      console.error(`  ❌ Failed to fetch candles for ${sym}: ${err.message}`);
      candlesBySymbol[sym] = { candles15m: [], candles1H: [] };
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — BUY ENTRY CONDITION VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(hr("=", 80));
  console.log("SECTION 1 — BUY ENTRY CONDITION VERIFICATION (PER TRADE)");
  console.log(hr("=", 80));

  const replayedBuys: Array<{ log: TradeLog; conditions: EntryConditions }> = [];

  for (let idx = 0; idx < buyLogs.length; idx++) {
    const log = buyLogs[idx];
    const sym = log.symbol.toUpperCase();
    const tradeTime = new Date(log.createdAt);
    const { candles15m, candles1H } = candlesBySymbol[sym] ?? { candles15m: [], candles1H: [] };

    const tradeTimeMs = tradeTime.getTime();
    const INTERVAL_15M = 15 * 60 * 1000;
    const INTERVAL_1H = 60 * 60 * 1000;

    const completed15m = getCandlesUpToTime(candles15m, tradeTimeMs, INTERVAL_15M);
    const completed1H = getCandlesUpToTime(candles1H, tradeTimeMs, INTERVAL_1H);

    console.log(`\nTRADE #${idx + 1} — ${sym} | BUY @ ${fmt(log.price)} x ${log.qty} | ${tradeTime.toISOString()}`);
    console.log(`  Completed 15m candles available: ${completed15m.length}`);
    console.log(`  Completed 1H  candles available: ${completed1H.length}`);

    if (completed15m.length < 28) {
      console.log(`  ⚠️  INSUFFICIENT DATA — Only ${completed15m.length} completed 15m candles (need ≥28). Cannot verify.`);
      console.log(`  → VERDICT: UNVERIFIABLE (Not counted as false entry)`);
      replayedBuys.push({ log, conditions: {
        goldenCross: { pass: false, value: "N/A" },
        rsi: { pass: false, value: "N/A" },
        adx: { pass: false, value: "N/A" },
        volume: { pass: false, value: "N/A" },
        trend1H: { pass: false, value: "N/A" },
        atr: { pass: false, value: "N/A" },
        riskReward: { pass: false, value: "N/A" },
        tradeScore: { pass: false, value: "N/A" },
        time: { pass: true, value: "N/A" },
        sideways: { pass: false, value: "N/A" },
        allPass: false,
        failedConditions: ["INSUFFICIENT_DATA"],
        score: 0,
      }});
      continue;
    }

    const conditions = evaluateEntryConditions(completed15m, completed1H, tradeTime);
    replayedBuys.push({ log, conditions });

    // Print condition table
    console.log(`  ${"Condition".padEnd(20)} ${"Status".padEnd(12)} Value`);
    console.log(`  ${hr("-", 70)}`);
    console.log(`  ${"Golden Cross".padEnd(20)} ${pass(conditions.goldenCross.pass).padEnd(12)} ${conditions.goldenCross.value}`);
    console.log(`  ${"RSI [55–70)".padEnd(20)} ${pass(conditions.rsi.pass).padEnd(12)} ${conditions.rsi.value}`);
    console.log(`  ${"ADX ≥ 25".padEnd(20)} ${pass(conditions.adx.pass).padEnd(12)} ${conditions.adx.value}`);
    console.log(`  ${"Volume".padEnd(20)} ${pass(conditions.volume.pass).padEnd(12)} ${conditions.volume.value}`);
    console.log(`  ${"1H Trend (EMA50)".padEnd(20)} ${pass(conditions.trend1H.pass).padEnd(12)} ${conditions.trend1H.value}`);
    console.log(`  ${"ATR > 0".padEnd(20)} ${pass(conditions.atr.pass).padEnd(12)} ${conditions.atr.value}`);
    console.log(`  ${"Risk/Reward ≥ 2".padEnd(20)} ${pass(conditions.riskReward.pass).padEnd(12)} ${conditions.riskReward.value}`);
    console.log(`  ${"Trade Score ≥ 60".padEnd(20)} ${pass(conditions.tradeScore.pass).padEnd(12)} ${conditions.tradeScore.value}`);
    console.log(`  ${"Time window".padEnd(20)} ${pass(conditions.time.pass).padEnd(12)} ${conditions.time.value}`);
    console.log(`  ${"Not Sideways".padEnd(20)} ${pass(conditions.sideways.pass).padEnd(12)} ${conditions.sideways.value}`);

    if (conditions.allPass) {
      console.log(`  ✅ VERDICT: VALID ENTRY — All conditions passed (Score: ${conditions.score}/100)`);
    } else {
      console.log(`  ❌ VERDICT: FALSE ENTRY — Failed: ${conditions.failedConditions.join("; ")}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — EXIT VERIFICATION (SELL SIDE)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 2 — EXIT VERIFICATION");
  console.log(hr("=", 80));

  let falseExits = 0;
  let falseStops = 0;
  let lateExits = 0;
  let lateEntries = 0;

  const falseEntries = replayedBuys.filter(
    (rb) => rb.conditions.failedConditions.length > 0 && !rb.conditions.failedConditions.includes("INSUFFICIENT_DATA")
  );
  const validEntries = replayedBuys.filter((rb) => rb.conditions.allPass);
  const unverifiable = replayedBuys.filter((rb) =>
    rb.conditions.failedConditions.includes("INSUFFICIENT_DATA")
  );

  // Verify exits for each paired trade
  for (const trade of pairedTrades) {
    const sym = trade.symbol;
    const { candles15m, candles1H } = candlesBySymbol[sym] ?? { candles15m: [], candles1H: [] };
    const sellTimeMs = trade.sellTime.getTime();
    const INTERVAL_15M = 15 * 60 * 1000;

    const completed15mAtSell = getCandlesUpToTime(candles15m, sellTimeMs, INTERVAL_15M);
    if (completed15mAtSell.length < 22) continue;

    const closes = completed15mAtSell.map((c) => c.c);
    const fastSma = calculateSMA(closes, 9);
    const slowSma = calculateSMA(closes, 21);
    const prevFastSma = calculateSMA(closes.slice(0, -1), 9);
    const prevSlowSma = calculateSMA(closes.slice(0, -1), 21);
    const isDeathCross = fastSma < slowSma && prevFastSma >= prevSlowSma;

    // Check if SELL reason mentions stop loss or trail stop
    const sellReason = trade.sellSignalReason.toLowerCase();
    const isStopLoss = sellReason.includes("stop") || sellReason.includes("trail") || sellReason.includes("atr");
    const isSellSignal = sellReason.includes("sell") || sellReason.includes("death cross");

    if (isStopLoss && !isDeathCross) {
      // Was exited by stop but death cross was also present → could have been held (legitimate stop)
      // Mark as false stop only if price was ABOVE entry at exit (premature stop on winning trade)
      if (trade.sellPrice > trade.buyPrice && trade.netProfit < 0) {
        // Sold at higher price than buy but somehow lost (fees)
        // this is ok, not a false stop
      } else if (trade.netProfit < 0 && trade.grossProfit > -10) {
        // Near breakeven stop → late exit contributed to small loss
        falseStops++;
        console.log(`  ⚠️  FALSE STOP: ${sym} Buy@${fmt(trade.buyPrice)} Sell@${fmt(trade.sellPrice)} — Stopped near break-even | P&L=${fmt(trade.netProfit)}`);
      }
    }

    if (isSellSignal && !isDeathCross) {
      // Claimed death cross exit but indicators show no death cross at sell time
      falseExits++;
      console.log(`  ⚠️  FALSE EXIT: ${sym} Buy@${fmt(trade.buyPrice)} Sell@${fmt(trade.sellPrice)} — Sold without confirmed Death Cross | P&L=${fmt(trade.netProfit)}`);
    }

    // Late exit: death cross was triggered but position was held for 3+ more candles
    // (We detect this by checking if death cross appeared before the actual sell time)
    if (isDeathCross && trade.holdingMs > 3 * INTERVAL_15M) {
      lateExits++;
    }
  }

  // Late entries: detect golden cross that appeared N candles before BUY
  for (const { log, conditions } of replayedBuys) {
    if (conditions.allPass) {
      // Check if golden cross appeared 2+ candles before the trade
      const sym = log.symbol.toUpperCase();
      const { candles15m } = candlesBySymbol[sym] ?? { candles15m: [] };
      const tradeTimeMs = new Date(log.createdAt).getTime();
      const INTERVAL_15M = 15 * 60 * 1000;
      const completed15m = getCandlesUpToTime(candles15m, tradeTimeMs, INTERVAL_15M);

      if (completed15m.length >= 24) {
        // Check 2 candles earlier
        const earlierCandles = completed15m.slice(0, -2);
        if (earlierCandles.length >= 22) {
          const ec = earlierCandles.map((c) => c.c);
          const ef = calculateSMA(ec, 9);
          const es = calculateSMA(ec, 21);
          const epf = calculateSMA(ec.slice(0, -1), 9);
          const eps = calculateSMA(ec.slice(0, -1), 21);
          const wasGoldenCrossEarlier = ef > es && epf <= eps;
          if (wasGoldenCrossEarlier) {
            lateEntries++;
            console.log(`  ⏰ LATE ENTRY: ${sym} @ ${new Date(log.createdAt).toISOString()} — Golden Cross appeared ≥2 candles earlier`);
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — MISSED ENTRY DETECTION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 3 — MISSED ENTRY DETECTION");
  console.log(hr("=", 80));
  console.log("Scanning candle history for valid entry signals that were NOT taken...\n");

  const missedEntries: Array<{
    symbol: string;
    time: string;
    score: number;
    details: string;
  }> = [];

  for (const sym of symbols) {
    const { candles15m, candles1H } = candlesBySymbol[sym] ?? { candles15m: [], candles1H: [] };
    const INTERVAL_15M = 15 * 60 * 1000;
    const INTERVAL_1H = 60 * 60 * 1000;

    // Get times when a BUY was actually taken for this symbol
    const actualBuyTimes = new Set(
      buyLogs
        .filter((b) => b.symbol.toUpperCase() === sym)
        .map((b) => new Date(b.createdAt).getTime())
    );

    for (let i = 30; i < candles15m.length; i++) {
      const candle = candles15m[i];
      const candleTimeMs = new Date(candle.t).getTime();

      const completed15m = getCandlesUpToTime(candles15m, candleTimeMs, INTERVAL_15M);
      const completed1H = getCandlesUpToTime(candles1H, candleTimeMs, INTERVAL_1H);

      if (completed15m.length < 28) continue;

      const conditions = evaluateEntryConditions(completed15m, completed1H, new Date(candle.t));

      if (conditions.allPass && conditions.goldenCross.pass) {
        // Check if a trade was taken within ±2 candles (30 min) of this signal
        const wasTraded = [...actualBuyTimes].some(
          (bt) => Math.abs(bt - candleTimeMs) <= 2 * INTERVAL_15M
        );

        if (!wasTraded) {
          missedEntries.push({
            symbol: sym,
            time: candle.t,
            score: conditions.score,
            details: `Score=${conditions.score}/100 | RSI=${conditions.rsi.value} | ADX=${conditions.adx.value} | R/R=${conditions.riskReward.value}`,
          });
          // Skip ahead 4 candles to avoid duplicate signals from same crossover
          i += 4;
        }
      }
    }
  }

  if (missedEntries.length === 0) {
    console.log("  ✅ No missed entries detected — every valid signal was captured.");
  } else {
    console.log(`  Found ${missedEntries.length} missed entry opportunities:\n`);
    for (let m = 0; m < missedEntries.length; m++) {
      const me = missedEntries[m];
      const ist = new Date(new Date(me.time).getTime() + 5.5 * 3600000);
      console.log(`  MISSED #${m + 1}: ${me.symbol} @ ${ist.toISOString()} IST`);
      console.log(`    ${me.details}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — SUMMARY: FALSE ENTRIES / FALSE EXITS / FALSE STOPS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 4 — AUDIT SUMMARY");
  console.log(hr("=", 80));

  console.log(`\n  BUY Trades Replayed:        ${buyLogs.length}`);
  console.log(`  ├─ Valid Entries:            ${validEntries.length}`);
  console.log(`  ├─ FALSE ENTRIES:            ${falseEntries.length}  ← BUY placed without all conditions`);
  console.log(`  └─ Unverifiable (no data):   ${unverifiable.length}`);
  console.log();
  console.log(`  FALSE EXITS:                 ${falseExits}   ← Sold without confirmed Death Cross`);
  console.log(`  FALSE STOPS:                 ${falseStops}   ← Premature stop on near-breakeven trade`);
  console.log(`  LATE ENTRIES:                ${lateEntries}   ← Signal appeared ≥2 candles before entry`);
  console.log(`  LATE EXITS:                  ${lateExits}   ← Held position 3+ candles after Death Cross`);
  console.log(`  MISSED ENTRIES:              ${missedEntries.length}   ← Valid signals with no trade taken`);

  if (falseEntries.length > 0) {
    console.log(`\n  FALSE ENTRY DETAILS:`);
    for (let i = 0; i < falseEntries.length; i++) {
      const fe = falseEntries[i];
      const sym = fe.log.symbol.toUpperCase();
      const t = new Date(fe.log.createdAt).toISOString();
      console.log(`  #${i + 1}: ${sym} @ ${t} — Failed: ${fe.conditions.failedConditions.join(" | ")}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — ACTUAL PAPER TRADE PERFORMANCE (from MongoDB)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 5 — ACTUAL PAPER TRADE PERFORMANCE (MongoDB data)");
  console.log(hr("=", 80));

  if (pairedTrades.length > 0) {
    console.log(`\n  ${"#".padEnd(4)} ${"Symbol".padEnd(12)} ${"Buy".padEnd(12)} ${"Sell".padEnd(12)} ${"Qty".padEnd(6)} ${"Fees".padEnd(10)} ${"Net P&L".padEnd(14)} Valid?`);
    console.log(`  ${hr("-", 76)}`);

    for (let i = 0; i < pairedTrades.length; i++) {
      const t = pairedTrades[i];
      // Find corresponding buy entry verification
      const matchedBuy = replayedBuys.find(
        (rb) =>
          rb.log.symbol.toUpperCase() === t.symbol &&
          Math.abs(new Date(rb.log.createdAt).getTime() - t.buyTime.getTime()) < 60000
      );
      const isValid = matchedBuy?.conditions.allPass ?? false;
      const pnlStr = t.netProfit >= 0 ? `+${fmt(t.netProfit)}` : `-${fmt(Math.abs(t.netProfit))}`;
      const validStr = isValid ? "✅" : "❌ FALSE";
      console.log(
        `  ${String(i + 1).padEnd(4)} ${t.symbol.padEnd(12)} ${fmt(t.buyPrice).padEnd(12)} ${fmt(t.sellPrice).padEnd(12)} ${String(t.qty).padEnd(6)} ${fmt(t.buyFees + t.sellFees).padEnd(10)} ${pnlStr.padEnd(14)} ${validStr}`
      );
    }

    const totalNetProfit = pairedTrades.reduce((s, t) => s + t.netProfit, 0);
    const wins = pairedTrades.filter((t) => t.netProfit > 0);
    const losses = pairedTrades.filter((t) => t.netProfit < 0);
    const grossProfit = wins.reduce((s, t) => s + t.netProfit, 0);
    const grossLoss = losses.reduce((s, t) => s + Math.abs(t.netProfit), 0);
    const winRate = pairedTrades.length > 0 ? (wins.length / pairedTrades.length) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
    const { maxDrawdownRs, maxDrawdownPct } = calcMaxDrawdown(pairedTrades.map((t) => t.netProfit), 100000);

    console.log(`\n  Paired Trades:     ${pairedTrades.length}`);
    console.log(`  Wins:              ${wins.length}   Losses: ${losses.length}`);
    console.log(`  Win Rate:          ${pct(winRate)}`);
    console.log(`  Gross Profit:      ${fmt(grossProfit)}`);
    console.log(`  Gross Loss:        ${fmt(grossLoss)}`);
    console.log(`  Net Profit:        ${totalNetProfit >= 0 ? "+" : ""}${fmt(totalNetProfit)}`);
    console.log(`  Profit Factor:     ${typeof profitFactor === "number" ? profitFactor.toFixed(2) : profitFactor}`);
    console.log(`  Avg Win:           ${fmt(avgWin)}`);
    console.log(`  Avg Loss:          ${fmt(avgLoss)}`);
    console.log(`  Expectancy:        ${expectancy >= 0 ? "+" : ""}${fmt(expectancy)}`);
    console.log(`  Max Drawdown:      ${fmt(maxDrawdownRs)} (${pct(maxDrawdownPct)})`);
  } else {
    console.log("  No completed (paired) trades found in MongoDB.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — OLD vs NEW STRATEGY SIMULATION (backtested on same candles)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 6 — OLD vs NEW STRATEGY SIMULATION (Full Historical Backtest)");
  console.log(hr("=", 80));

  const TARGET_SYMBOLS = ["RELIANCE", "TCS", "INFY"];

  const oldReports: BacktestReport[] = [];
  const newReports: BacktestReport[] = [];
  const symbolResults: Array<{
    symbol: string;
    old: BacktestReport;
    newR: BacktestReport;
    blocked: number;
  }> = [];

  for (const sym of TARGET_SYMBOLS) {
    const data = candlesBySymbol[sym] ?? { candles15m: [], candles1H: [] };
    if (data.candles15m.length === 0) {
      console.log(`  ⚠️  No candles for ${sym} — skipping simulation.`);
      continue;
    }

    console.log(`\n  ─ ${sym} ─`);

    const oldSim = runOldStrategy(data.candles15m);
    const newSim = runNewStrategy(data.candles15m, data.candles1H);

    const oldHoldingMs = oldSim.trades.map((t) => t.holdingMs);
    const newHoldingMs = newSim.trades.map((t) => t.holdingMs);

    const oldRpt = compileReport(`OLD (${sym})`, oldSim.pnlList, oldSim.equityCurve, oldHoldingMs);
    const newRpt = compileReport(`NEW (${sym})`, newSim.pnlList, newSim.equityCurve, newHoldingMs, newSim.falseSignalsBlocked);

    oldReports.push(oldRpt);
    newReports.push(newRpt);
    symbolResults.push({ symbol: sym, old: oldRpt, newR: newRpt, blocked: newSim.falseSignalsBlocked });

    const pfOld = typeof oldRpt.profitFactor === "number" ? oldRpt.profitFactor.toFixed(2) : oldRpt.profitFactor;
    const pfNew = typeof newRpt.profitFactor === "number" ? newRpt.profitFactor.toFixed(2) : newRpt.profitFactor;

    console.log(`  OLD: Trades=${oldRpt.trades} | WinRate=${pct(oldRpt.winRate)} | Net=${fmt(oldRpt.netProfit)} | DD=${pct(oldRpt.maxDrawdownPct)} | PF=${pfOld}`);
    console.log(`  NEW: Trades=${newRpt.trades} | WinRate=${pct(newRpt.winRate)} | Net=${fmt(newRpt.netProfit)} | DD=${pct(newRpt.maxDrawdownPct)} | PF=${pfNew} | Blocked=${newSim.falseSignalsBlocked}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — AGGREGATED OLD vs NEW COMPARISON
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 7 — AGGREGATED OLD vs NEW STRATEGY COMPARISON");
  console.log(hr("=", 80));

  const aggOldTrades = oldReports.reduce((s, r) => s + r.trades, 0);
  const aggNewTrades = newReports.reduce((s, r) => s + r.trades, 0);
  const aggOldWins = oldReports.reduce((s, r) => s + r.wins, 0);
  const aggNewWins = newReports.reduce((s, r) => s + r.wins, 0);
  const aggOldGrossProfit = oldReports.reduce((s, r) => s + r.grossProfit, 0);
  const aggNewGrossProfit = newReports.reduce((s, r) => s + r.grossProfit, 0);
  const aggOldGrossLoss = oldReports.reduce((s, r) => s + r.grossLoss, 0);
  const aggNewGrossLoss = newReports.reduce((s, r) => s + r.grossLoss, 0);
  const aggOldNetProfit = aggOldGrossProfit - aggOldGrossLoss;
  const aggNewNetProfit = aggNewGrossProfit - aggNewGrossLoss;
  const aggOldWinRate = aggOldTrades > 0 ? (aggOldWins / aggOldTrades) * 100 : 0;
  const aggNewWinRate = aggNewTrades > 0 ? (aggNewWins / aggNewTrades) * 100 : 0;
  const aggOldPF = aggOldGrossLoss > 0 ? aggOldGrossProfit / aggOldGrossLoss : aggOldGrossProfit > 0 ? Infinity : 0;
  const aggNewPF = aggNewGrossLoss > 0 ? aggNewGrossProfit / aggNewGrossLoss : aggNewGrossProfit > 0 ? Infinity : 0;
  const totalBlocked = newReports.reduce((s, r) => s + (r.falseSignalsBlocked ?? 0), 0);

  // Aggregate drawdown
  const aggOldDD = oldReports.reduce((s, r) => s + r.maxDrawdownRs, 0);
  const aggNewDD = newReports.reduce((s, r) => s + r.maxDrawdownRs, 0);

  // Expectancy
  const avgOldExpectancy = oldReports.length > 0 ? oldReports.reduce((s, r) => s + r.expectancy, 0) / oldReports.length : 0;
  const avgNewExpectancy = newReports.length > 0 ? newReports.reduce((s, r) => s + r.expectancy, 0) / newReports.length : 0;

  const improvementNetProfit =
    aggOldNetProfit !== 0
      ? ((aggNewNetProfit - aggOldNetProfit) / Math.abs(aggOldNetProfit)) * 100
      : aggNewNetProfit > 0 ? 100 : 0;
  const improvementWinRate = aggOldWinRate !== 0 ? ((aggNewWinRate - aggOldWinRate) / aggOldWinRate) * 100 : 0;
  const improvementDrawdown = aggOldDD !== 0 ? ((aggOldDD - aggNewDD) / aggOldDD) * 100 : 0;
  const improvementPF =
    typeof aggOldPF === "number" && aggOldPF !== 0 && typeof aggNewPF === "number"
      ? ((aggNewPF - aggOldPF) / aggOldPF) * 100
      : 0;

  const colW = 28;
  const c1 = 18;
  const c2 = 18;

  console.log();
  console.log(`  ${"Metric".padEnd(colW)} ${"OLD Strategy".padEnd(c1)} ${"NEW Strategy".padEnd(c2)} Improvement`);
  console.log(`  ${hr("-", 74)}`);

  const pfOldStr = typeof aggOldPF === "number" ? aggOldPF.toFixed(2) : "∞";
  const pfNewStr = typeof aggNewPF === "number" ? aggNewPF.toFixed(2) : "∞";

  console.log(`  ${"Total Trades".padEnd(colW)} ${String(aggOldTrades).padEnd(c1)} ${String(aggNewTrades).padEnd(c2)}`);
  console.log(`  ${"Win Rate".padEnd(colW)} ${pct(aggOldWinRate).padEnd(c1)} ${pct(aggNewWinRate).padEnd(c2)} ${improvementWinRate >= 0 ? "+" : ""}${improvementWinRate.toFixed(1)}%`);
  console.log(`  ${"Gross Profit".padEnd(colW)} ${fmt(aggOldGrossProfit).padEnd(c1)} ${fmt(aggNewGrossProfit).padEnd(c2)}`);
  console.log(`  ${"Gross Loss".padEnd(colW)} ${fmt(aggOldGrossLoss).padEnd(c1)} ${fmt(aggNewGrossLoss).padEnd(c2)}`);
  console.log(`  ${"Net Profit".padEnd(colW)} ${fmt(aggOldNetProfit).padEnd(c1)} ${fmt(aggNewNetProfit).padEnd(c2)} ${improvementNetProfit >= 0 ? "+" : ""}${improvementNetProfit.toFixed(1)}%`);
  console.log(`  ${"Profit Factor".padEnd(colW)} ${pfOldStr.padEnd(c1)} ${pfNewStr.padEnd(c2)} ${improvementPF >= 0 ? "+" : ""}${improvementPF.toFixed(1)}%`);
  console.log(`  ${"Expectancy (avg)".padEnd(colW)} ${fmt(avgOldExpectancy).padEnd(c1)} ${fmt(avgNewExpectancy).padEnd(c2)}`);
  console.log(`  ${"Max Drawdown (total ₹)".padEnd(colW)} ${fmt(aggOldDD).padEnd(c1)} ${fmt(aggNewDD).padEnd(c2)} ${improvementDrawdown >= 0 ? "-" : "+"}${Math.abs(improvementDrawdown).toFixed(1)}%`);
  console.log(`  ${"False Signals Blocked".padEnd(colW)} ${"N/A".padEnd(c1)} ${String(totalBlocked).padEnd(c2)}`);

  // ─── Per-symbol breakdown ─────────────────────────────────────────────────
  console.log(`\n  PER-SYMBOL BREAKDOWN:`);
  console.log(`  ${"Symbol".padEnd(12)} ${"Old PF".padEnd(10)} ${"New PF".padEnd(10)} ${"Old Net".padEnd(14)} ${"New Net".padEnd(14)} ${"Blocked"}`);
  console.log(`  ${hr("-", 70)}`);
  for (const sr of symbolResults) {
    const opf = typeof sr.old.profitFactor === "number" ? sr.old.profitFactor.toFixed(2) : String(sr.old.profitFactor);
    const npf = typeof sr.newR.profitFactor === "number" ? sr.newR.profitFactor.toFixed(2) : String(sr.newR.profitFactor);
    console.log(
      `  ${sr.symbol.padEnd(12)} ${opf.padEnd(10)} ${npf.padEnd(10)} ${fmt(sr.old.netProfit).padEnd(14)} ${fmt(sr.newR.netProfit).padEnd(14)} ${sr.blocked}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — FINAL VERDICT
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${hr("=", 80)}`);
  console.log("SECTION 8 — FINAL VERDICT");
  console.log(hr("=", 80));

  const falseEntryRate = buyLogs.length > 0 ? (falseEntries.length / buyLogs.length) * 100 : 0;
  const newStratProfitable = aggNewNetProfit > 0;
  const newPFOk = typeof aggNewPF === "number" ? aggNewPF > 1.5 : true;
  const newWinRateOk = aggNewWinRate >= 55;
  const newDDOk = aggNewDD < 10000; // < ₹10,000 drawdown

  console.log(`\n  FALSE ENTRY RATE:    ${falseEntries.length}/${buyLogs.length} = ${pct(falseEntryRate)}`);
  console.log(`  NEW STRATEGY PROFITABLE: ${newStratProfitable ? "✅ YES" : "❌ NO"}`);
  console.log(`  NEW PROFIT FACTOR ≥ 1.5: ${newPFOk ? "✅ YES" : "❌ NO"} (${pfNewStr})`);
  console.log(`  NEW WIN RATE ≥ 55%:      ${newWinRateOk ? "✅ YES" : "❌ NO"} (${pct(aggNewWinRate)})`);
  console.log(`  NEW DRAWDOWN < ₹10,000:  ${newDDOk ? "✅ YES" : "❌ NO"} (${fmt(aggNewDD)})`);
  console.log(`  NET IMPROVEMENT:         ${improvementNetProfit >= 0 ? "+" : ""}${improvementNetProfit.toFixed(1)}%`);

  const readyForLive =
    newStratProfitable && newPFOk && newWinRateOk && newDDOk && falseEntryRate < 30;

  console.log(`\n  ${"═".repeat(60)}`);
  if (readyForLive) {
    console.log(`  ✅ RECOMMENDATION: NEW STRATEGY IS READY FOR EXTENDED PAPER TESTING`);
    console.log(`     All key metrics pass. Proceed with live monitoring.`);
  } else {
    console.log(`  ❌ RECOMMENDATION: NOT READY FOR LIVE DEPLOYMENT`);
    if (falseEntryRate >= 30) console.log(`     → ${pct(falseEntryRate)} of entries are FALSE — strategy discipline is broken.`);
    if (!newStratProfitable) console.log(`     → New strategy is still unprofitable on backtested data.`);
    if (!newPFOk) console.log(`     → Profit Factor below 1.5 threshold.`);
    if (!newWinRateOk) console.log(`     → Win rate below 55%.`);
    if (!newDDOk) console.log(`     → Drawdown exceeds ₹10,000 risk limit.`);
  }
  console.log(`  ${"═".repeat(60)}`);

  await AppDataSource.destroy();
  console.log("\n✅ Audit complete. MongoDB connection closed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
