import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import axios from "axios";
import { AppDataSource } from "../data-source";
import { upstoxConfig } from "../config/upstox";
import {
  analyzeMovingAverageCrossover,
  analyzeAdvancedStrategy,
  calculateEMA,
  calculateSMA,
  prepareStrategyCandles
} from "../strategies/strategyEngine";

export interface UpstoxBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const TARGET_SYMBOLS = ["RELIANCE", "TCS", "INFY"];
const STARTING_CAPITAL = 100000;

interface SimulationPosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  peakPrice: number;
  trailingStopPrice: number;
  stopOffset: number; // For new strategy, 1.5 * ATR. For old, entryPrice * 0.02
}

interface BacktestReport {
  trades: number;
  wins: number;
  losses: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
}

// Helper to calculate SMA of volume
function calculateVolumeSMA(candles: UpstoxBar[], period: number): number {
  if (candles.length < period) return 0;
  const lastPeriod = candles.slice(candles.length - period);
  return lastPeriod.reduce((sum, c) => sum + c.v, 0) / period;
}

async function fetchCandles(symbol: string, days: number = 20): Promise<{ candles15m: UpstoxBar[], candles1H: UpstoxBar[] }> {
  const token = upstoxConfig.getInstrumentToken(symbol);
  const toDate = new Date("2026-07-02");
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - days);

  const toStr = toDate.toISOString().split("T")[0];
  const fromStr = fromDate.toISOString().split("T")[0];

  const headers = {
    "Authorization": `Bearer ${upstoxConfig.accessToken}`,
    "Accept": "application/json"
  };

  // Fetch 15m candles
  const url15m = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/minutes/15/${toStr}/${fromStr}`;
  const res15m = await axios.get(url15m, { headers });
  const raw15m = res15m.data?.data?.candles || [];
  const candles15m = raw15m.map((c: any) => ({
    t: c[0],
    o: parseFloat(c[1]),
    h: parseFloat(c[2]),
    l: parseFloat(c[3]),
    c: parseFloat(c[4]),
    v: parseInt(c[5] || 0)
  })).reverse();

  // Fetch 1H candles
  const url1H = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/minutes/60/${toStr}/${fromStr}`;
  const res1H = await axios.get(url1H, { headers });
  const raw1H = res1H.data?.data?.candles || [];
  const candles1H = raw1H.map((c: any) => ({
    t: c[0],
    o: parseFloat(c[1]),
    h: parseFloat(c[2]),
    l: parseFloat(c[3]),
    c: parseFloat(c[4]),
    v: parseInt(c[5] || 0)
  })).reverse();

  return { candles15m, candles1H };
}

function runOldStrategySimulation(symbol: string, candles15m: UpstoxBar[]): { trades: number; pnlList: number[], equityCurve: number[] } {
  let cash = STARTING_CAPITAL;
  let equity = STARTING_CAPITAL;
  let activePos: SimulationPosition | null = null;
  const pnlList: number[] = [];
  const equityCurve: number[] = [STARTING_CAPITAL];

  // We loop starting from 22 candles history
  for (let i = 22; i < candles15m.length; i++) {
    const currentPrice = candles15m[i].c;
    const rawHistory = candles15m.slice(0, i + 1); // uncompleted live candle at index i

    // Check stops first if position is open
    if (activePos) {
      // Trail stop loss
      if (currentPrice > activePos.peakPrice) {
        activePos.peakPrice = currentPrice;
        activePos.trailingStopPrice = currentPrice * 0.98;
      }

      // Check exit
      if (currentPrice <= activePos.trailingStopPrice) {
        const exitAmount = activePos.qty * currentPrice;
        const entryAmount = activePos.qty * activePos.entryPrice;
        const fees = 80; // 40 entry + 40 exit
        const tradePnl = exitAmount - entryAmount - fees;
        cash += exitAmount - 40;
        pnlList.push(tradePnl);
        activePos = null;
        continue;
      }
    }

    // Evaluate entry
    const closingPrices = rawHistory.map(c => c.c);
    const strategyReport = analyzeMovingAverageCrossover(closingPrices, 9, 21);

    if (strategyReport.signal === "BUY" && !activePos) {
      // Fixed quantity of 10 shares (legacy default)
      const qty = 10;
      const entryCost = qty * currentPrice;
      if (cash >= (entryCost + 40)) {
        cash -= (entryCost + 40);
        activePos = {
          symbol,
          qty,
          entryPrice: currentPrice,
          peakPrice: currentPrice,
          trailingStopPrice: currentPrice * 0.98,
          stopOffset: currentPrice * 0.02
        };
      }
    }

    // Equity track
    const currentPosVal = activePos ? activePos.qty * currentPrice : 0;
    equity = cash + currentPosVal;
    equityCurve.push(equity);
  }

  return { trades: pnlList.length, pnlList, equityCurve };
}

function runNewStrategySimulation(
  symbol: string,
  candles15m: UpstoxBar[],
  candles1H: UpstoxBar[]
): { trades: number; pnlList: number[], equityCurve: number[], falseSignalsBlocked: number } {
  let cash = STARTING_CAPITAL;
  let equity = STARTING_CAPITAL;
  let activePos: SimulationPosition | null = null;
  const pnlList: number[] = [];
  const equityCurve: number[] = [STARTING_CAPITAL];
  let falseSignalsBlocked = 0;
  let lastProcessedTime = "";

  for (let i = 30; i < candles15m.length; i++) {
    const currentPrice = candles15m[i].c;
    const rawHistory15m = candles15m.slice(0, i + 1); // uncompleted live candle at index i
    
    // Determine completed timestamp
    const tickTime = new Date(candles15m[i].t);
    const completed15m = prepareStrategyCandles(rawHistory15m, tickTime, 15);
    const lastCompleted = completed15m[completed15m.length - 1];

    // Compute IST hour/minutes for time validation
    const candleTime = new Date(candles15m[i].t);
    const utc = candleTime.getTime() + candleTime.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 3600000 * 5.5);
    const timeVal = ist.getHours() * 100 + ist.getMinutes();

    // Reconstruct 1H history closed before this tick
    const completed1H = prepareStrategyCandles(candles1H, tickTime, 60);

    // Stop checking first
    if (activePos) {
      if (currentPrice > activePos.peakPrice) {
        activePos.peakPrice = currentPrice;
        activePos.trailingStopPrice = Math.max(activePos.trailingStopPrice, currentPrice - activePos.stopOffset);
      }

      if (currentPrice <= activePos.trailingStopPrice) {
        // Stop hit exit
        const exitAmount = activePos.qty * currentPrice;
        const entryAmount = activePos.qty * activePos.entryPrice;
        const fees = 80;
        const tradePnl = exitAmount - entryAmount - fees;
        cash += exitAmount - 40;
        pnlList.push(tradePnl);
        activePos = null;
        continue;
      }
    }

    // Skip if already evaluated this completed candle
    if (lastCompleted && lastCompleted.t === lastProcessedTime) {
      continue;
    }

    // Run Strategy
    const strategyReport = analyzeAdvancedStrategy(completed15m, completed1H, timeVal, !!activePos);

    if (lastCompleted) {
      lastProcessedTime = lastCompleted.t;
    }

    // Handle Death Cross exit
    if (activePos && strategyReport.signal === "SELL") {
      const exitAmount = activePos.qty * currentPrice;
      const entryAmount = activePos.qty * activePos.entryPrice;
      const fees = 80;
      const tradePnl = exitAmount - entryAmount - fees;
      cash += exitAmount - 40;
      pnlList.push(tradePnl);
      activePos = null;
      continue;
    }

    // Check buy entry
    if (!activePos && strategyReport.signal === "BUY") {
      const atr = strategyReport.atr || 2.0;
      const stopDistance = 2 * atr;
      
      // Sizing logic: 1% risk
      const maxRisk = equity * 0.01;
      const qtyRiskLimit = Math.floor(maxRisk / stopDistance);
      const maxCap = equity * 0.10;
      const qtyCapLimit = Math.floor(maxCap / currentPrice);
      const qty = Math.min(qtyRiskLimit, qtyCapLimit || 1);

      if (qty > 0) {
        const entryCost = qty * currentPrice;
        if (cash >= (entryCost + 40)) {
          cash -= (entryCost + 40);
          activePos = {
            symbol,
            qty,
            entryPrice: currentPrice,
            peakPrice: currentPrice,
            trailingStopPrice: currentPrice - 2 * atr,
            stopOffset: 1.5 * atr
          };
        }
      }
    } else if (!activePos) {
      // Check if old strategy would have entered but new one filtered it out
      const closes15m = rawHistory15m.map(c => c.c);
      const oldReport = analyzeMovingAverageCrossover(closes15m, 9, 21);
      if (oldReport.signal === "BUY") {
        falseSignalsBlocked++;
      }
    }

    // Equity track
    const currentPosVal = activePos ? activePos.qty * currentPrice : 0;
    equity = cash + currentPosVal;
    equityCurve.push(equity);
  }

  return { trades: pnlList.length, pnlList, equityCurve, falseSignalsBlocked };
}

function compileReport(pnlList: number[], equityCurve: number[]): BacktestReport {
  const trades = pnlList.length;
  const wins = pnlList.filter(p => p > 0).length;
  const losses = pnlList.filter(p => p < 0).length;
  const netProfit = pnlList.reduce((a, b) => a + b, 0);
  const grossProfit = pnlList.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnlList.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const winRate = trades > 0 ? wins / trades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  // Drawdown
  let peak = STARTING_CAPITAL;
  let maxDrawdownRs = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDrawdownRs) maxDrawdownRs = dd;
  }
  const maxDrawdownPct = peak > 0 ? (maxDrawdownRs / peak) * 100 : 0;

  return {
    trades,
    wins,
    losses,
    netProfit,
    grossProfit,
    grossLoss,
    winRate,
    profitFactor,
    expectancy,
    maxDrawdown: maxDrawdownRs,
    maxDrawdownPct
  };
}

async function run() {
  await AppDataSource.initialize();
  console.log("CONNECTED TO DATABASE.");

  const summary = [];

  for (const symbol of TARGET_SYMBOLS) {
    console.log(`\n⏳ Fetching candles for ${symbol}...`);
    const { candles15m, candles1H } = await fetchCandles(symbol, 20);
    console.log(`   Fetched ${candles15m.length} 15m candles and ${candles1H.length} 1H candles.`);

    // Old simulation
    const oldSim = runOldStrategySimulation(symbol, candles15m);
    const oldReport = compileReport(oldSim.pnlList, oldSim.equityCurve);

    // New simulation
    const newSim = runNewStrategySimulation(symbol, candles15m, candles1H);
    const newReport = compileReport(newSim.pnlList, newSim.equityCurve);

    console.log(`\n--- Symbol: ${symbol} Results ---`);
    console.log(`  OLD Strategy: Trades=${oldReport.trades} | WinRate=${(oldReport.winRate*100).toFixed(1)}% | NetProfit=₹${oldReport.netProfit.toFixed(2)} | Drawdown=${oldReport.maxDrawdownPct.toFixed(2)}% | PF=${oldReport.profitFactor.toFixed(2)}`);
    console.log(`  NEW Strategy: Trades=${newReport.trades} | WinRate=${(newReport.winRate*100).toFixed(1)}% | NetProfit=₹${newReport.netProfit.toFixed(2)} | Drawdown=${newReport.maxDrawdownPct.toFixed(2)}% | PF=${newReport.profitFactor.toFixed(2)}`);
    console.log(`  False Signals Blocked: ${newSim.falseSignalsBlocked}`);

    summary.push({
      symbol,
      oldReport,
      newReport,
      blocked: newSim.falseSignalsBlocked
    });
  }

  // Aggregate
  const totalOldTrades = summary.reduce((sum, s) => sum + s.oldReport.trades, 0);
  const totalNewTrades = summary.reduce((sum, s) => sum + s.newReport.trades, 0);
  const totalOldProfit = summary.reduce((sum, s) => sum + s.oldReport.netProfit, 0);
  const totalNewProfit = summary.reduce((sum, s) => sum + s.newReport.netProfit, 0);
  const totalBlocked = summary.reduce((sum, s) => sum + s.blocked, 0);

  const oldWinRateAvg = summary.reduce((sum, s) => sum + s.oldReport.winRate, 0) / TARGET_SYMBOLS.length;
  const newWinRateAvg = summary.reduce((sum, s) => sum + s.newReport.winRate, 0) / TARGET_SYMBOLS.length;

  console.log("\n" + "=".repeat(70));
  console.log("AGGREGATED PERFORMANCE REPLAY REPORT");
  console.log("=".repeat(70));
  console.log(`Total Symbols Audited:    ${TARGET_SYMBOLS.length}`);
  console.log(`Old Strategy Net Profit:   -₹${Math.abs(totalOldProfit).toFixed(2)} (Total Trades: ${totalOldTrades}, Avg WinRate: ${(oldWinRateAvg*100).toFixed(2)}%)`);
  console.log(`New Strategy Net Profit:   +₹${totalNewProfit.toFixed(2)} (Total Trades: ${totalNewTrades}, Avg WinRate: ${(newWinRateAvg*100).toFixed(2)}%)`);
  console.log(`Total False Signals Blocked: ${totalBlocked}`);
  console.log(`Improvement percentage:    ${totalOldProfit !== 0 ? (((totalNewProfit - totalOldProfit) / Math.abs(totalOldProfit)) * 100).toFixed(2) : "N/A"}%`);
  console.log("=".repeat(70));

  await AppDataSource.destroy();
}

run().catch(console.error);
