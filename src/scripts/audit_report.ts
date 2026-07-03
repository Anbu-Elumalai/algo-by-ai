// src/scripts/audit_report.ts
// ─────────────────────────────────────────────────────────────────────────────
//  TRADING PERFORMANCE AUDIT — Full Institutional-Grade Report
//  Principal Fix: Pairs BUY/SELL trades via FIFO and calculates actual P&L.
//  All metrics derived from net trade profit, never from raw totalAmount.
// ─────────────────────────────────────────────────────────────────────────────
import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { ActivePosition } from "../entity/ActivePosition";
import { DailyRiskTracker } from "../entity/DailyRiskTracker";
import { ErrorLog } from "../entity/ErrorLog";
import { SystemHealthLog } from "../entity/SystemHealthLog";
import { PaperBrokerPosition } from "../entity/PaperBrokerPosition";
import { OrderJournal } from "../entity/OrderJournal";
import { PositionHealthLog } from "../entity/PositionHealthLog";
import axios from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface CompletedTrade {
  symbol: string;
  buyPrice: number;     // Weighted average buy price for this lot
  sellPrice: number;
  qty: number;
  buyFees: number;
  sellFees: number;
  grossProfit: number;  // (sellPrice - buyPrice) * qty
  netProfit: number;    // grossProfit - buyFees - sellFees
  buyTime: Date;
  sellTime: Date;
  holdingMs: number;
}

interface SymbolBuyLot {
  price: number;
  qty: number;
  fees: number;
  time: Date;
  remaining: number;    // qty not yet matched to a SELL
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: format currency
// ─────────────────────────────────────────────────────────────────────────────
function fmt(n: number): string {
  return `₹${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Trade Pairing via FIFO
// Each BUY lot is consumed in order against each SELL leg for the same symbol.
// Returns an array of fully-realized CompletedTrade objects.
// ─────────────────────────────────────────────────────────────────────────────
function pairTradesFIFO(logs: TradeLog[]): CompletedTrade[] {
  // Sort all logs chronologically
  const sorted = [...logs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // FIFO queues per symbol
  const buyQueues: Record<string, SymbolBuyLot[]> = {};
  const completedTrades: CompletedTrade[] = [];

  for (const log of sorted) {
    const sym = log.symbol.toUpperCase();

    if (log.action === "BUY") {
      if (!buyQueues[sym]) buyQueues[sym] = [];
      buyQueues[sym].push({
        price: log.price,
        qty: log.qty,
        fees: log.transactionFees ?? 0,
        time: new Date(log.createdAt),
        remaining: log.qty,
      });
    } else if (log.action === "SELL") {
      if (!buyQueues[sym] || buyQueues[sym].length === 0) {
        // Orphaned SELL — no matching BUY in logs; skip
        console.warn(`  ⚠️  ORPHANED SELL skipped: ${sym} | qty=${log.qty} | time=${log.createdAt}`);
        continue;
      }

      let remainingSellQty = log.qty;
      // Proportionally distribute sell fees across matched lots
      const totalSellFees = log.transactionFees ?? 0;

      while (remainingSellQty > 0 && buyQueues[sym].length > 0) {
        const buyLot = buyQueues[sym][0];
        const matchedQty = Math.min(remainingSellQty, buyLot.remaining);

        // Proportion of sell fees for this matched qty
        const sellFeesPortion = (matchedQty / log.qty) * totalSellFees;
        // Proportion of buy fees used for this matched qty
        const buyFeesPortion = (matchedQty / buyLot.qty) * buyLot.fees;

        const grossTradePnl = (log.price - buyLot.price) * matchedQty;
        const netTradePnl = grossTradePnl - buyFeesPortion - sellFeesPortion;

        completedTrades.push({
          symbol: sym,
          buyPrice: buyLot.price,
          sellPrice: log.price,
          qty: matchedQty,
          buyFees: Number(buyFeesPortion.toFixed(2)),
          sellFees: Number(sellFeesPortion.toFixed(2)),
          grossProfit: Number(grossTradePnl.toFixed(2)),
          netProfit: Number(netTradePnl.toFixed(2)),
          buyTime: buyLot.time,
          sellTime: new Date(log.createdAt),
          holdingMs: new Date(log.createdAt).getTime() - buyLot.time.getTime(),
        });

        buyLot.remaining -= matchedQty;
        remainingSellQty -= matchedQty;

        if (buyLot.remaining <= 0) {
          buyQueues[sym].shift();
        }
      }
    }
  }

  return completedTrades;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Maximum Drawdown from equity curve
// ─────────────────────────────────────────────────────────────────────────────
function calcMaxDrawdown(
  completedTrades: CompletedTrade[],
  startingCapital: number
): { drawdownRs: number; drawdownPct: number; equityCurve: number[] } {
  let equity = startingCapital;
  let peak = startingCapital;
  let maxDrawdownRs = 0;
  const equityCurve: number[] = [startingCapital];

  // Trades are already chronologically sorted from FIFO pairing
  const sorted = [...completedTrades].sort(
    (a, b) => a.sellTime.getTime() - b.sellTime.getTime()
  );

  for (const trade of sorted) {
    equity += trade.netProfit;
    equityCurve.push(Number(equity.toFixed(2)));
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownRs) maxDrawdownRs = dd;
  }

  const maxDrawdownPct = peak > 0 ? (maxDrawdownRs / peak) * 100 : 0;
  return {
    drawdownRs: Number(maxDrawdownRs.toFixed(2)),
    drawdownPct: Number(maxDrawdownPct.toFixed(2)),
    equityCurve,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Simplified Sharpe Ratio
// Uses daily net profits; risk-free rate ≈ 6% annual → ~0.024% daily
// ─────────────────────────────────────────────────────────────────────────────
function calcSharpeRatio(netProfits: number[], riskFreeRateDaily = 0.00024): number {
  if (netProfits.length < 2) return 0;
  const mean = netProfits.reduce((s, v) => s + v, 0) / netProfits.length;
  const variance =
    netProfits.reduce((s, v) => s + Math.pow(v - mean, 2), 0) /
    (netProfits.length - 1);
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  return Number(((mean - riskFreeRateDaily) / stddev).toFixed(4));
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Sortino Ratio (downside deviation only)
// ─────────────────────────────────────────────────────────────────────────────
function calcSortinoRatio(netProfits: number[], riskFreeRateDaily = 0.00024): number {
  if (netProfits.length < 2) return 0;
  const mean = netProfits.reduce((s, v) => s + v, 0) / netProfits.length;
  const negReturns = netProfits.filter(v => v < riskFreeRateDaily);
  if (negReturns.length === 0) return Infinity;
  const downsideVariance =
    negReturns.reduce((s, v) => s + Math.pow(v - riskFreeRateDaily, 2), 0) /
    negReturns.length;
  const downsideStddev = Math.sqrt(downsideVariance);
  if (downsideStddev === 0) return 0;
  return Number(((mean - riskFreeRateDaily) / downsideStddev).toFixed(4));
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Consecutive Win/Loss streaks from ordered completed trades
// ─────────────────────────────────────────────────────────────────────────────
function calcStreaks(sortedTrades: CompletedTrade[]): {
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
} {
  let maxWins = 0,
    maxLosses = 0,
    curWins = 0,
    curLosses = 0;
  for (const t of sortedTrades) {
    if (t.netProfit > 0) {
      curWins++;
      curLosses = 0;
      if (curWins > maxWins) maxWins = curWins;
    } else if (t.netProfit < 0) {
      curLosses++;
      curWins = 0;
      if (curLosses > maxLosses) maxLosses = curLosses;
    } else {
      curWins = 0;
      curLosses = 0;
    }
  }
  return { maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const STARTING_CAPITAL = 100000.0;

  console.log("=".repeat(70));
  console.log("  TRADING PERFORMANCE AUDIT — INSTITUTIONAL GRADE");
  console.log(`  Generated: ${new Date().toISOString()}`);
  console.log("=".repeat(70));

  await AppDataSource.initialize();
  console.log("✅ Connected to MongoDB\n");

  // ─── Load all raw data ────────────────────────────────────────────────────
  const tradeRepo       = AppDataSource.getMongoRepository(TradeLog);
  const activeRepo      = AppDataSource.getMongoRepository(ActivePosition);
  const dailyRepo       = AppDataSource.getMongoRepository(DailyRiskTracker);
  const errorRepo       = AppDataSource.getMongoRepository(ErrorLog);
  const sysHealthRepo   = AppDataSource.getMongoRepository(SystemHealthLog);
  const paperPosRepo    = AppDataSource.getMongoRepository(PaperBrokerPosition);
  const orderRepo       = AppDataSource.getMongoRepository(OrderJournal);
  const posHealthRepo   = AppDataSource.getMongoRepository(PositionHealthLog);

  const allTrades       = await tradeRepo.find();
  const activePositions = await activeRepo.find();
  const dailyTrackers   = await dailyRepo.find();
  const errorLogs       = await errorRepo.find();
  const sysHealthLogs   = await sysHealthRepo.find();
  const paperPositions  = await paperPosRepo.find();
  const orderJournals   = await orderRepo.find();
  const posHealthLogs   = await posHealthRepo.find();

  const buyLogs  = allTrades.filter(t => t.action === "BUY");
  const sellLogs = allTrades.filter(t => t.action === "SELL");

  // ─── SECTION 1: Trade Pairing ────────────────────────────────────────────
  console.log("─".repeat(70));
  console.log("SECTION 1 — TRADE PAIRING (FIFO)");
  console.log("─".repeat(70));

  const completedTrades = pairTradesFIFO(allTrades);

  // Sort completed trades by sell time for time-ordered analysis
  completedTrades.sort((a, b) => a.sellTime.getTime() - b.sellTime.getTime());

  console.log(`Raw BUY logs:          ${buyLogs.length}`);
  console.log(`Raw SELL logs:         ${sellLogs.length}`);
  console.log(`Completed (paired):    ${completedTrades.length}`);
  console.log(`Open (unmatched BUY):  ${buyLogs.length - completedTrades.length < 0 ? 0 : buyLogs.length - completedTrades.length}`);

  if (completedTrades.length > 0) {
    console.log("\nPaired Trade Table:");
    console.log(
      "Symbol".padEnd(12) +
      "Buy Price".padEnd(12) +
      "Sell Price".padEnd(12) +
      "Qty".padEnd(8) +
      "Fees".padEnd(12) +
      "Net Profit"
    );
    console.log("-".repeat(70));
    for (const t of completedTrades) {
      const fees = t.buyFees + t.sellFees;
      const profitStr = t.netProfit >= 0 ? `+₹${t.netProfit.toFixed(2)}` : `-₹${Math.abs(t.netProfit).toFixed(2)}`;
      console.log(
        t.symbol.padEnd(12) +
        fmt(t.buyPrice).padEnd(12) +
        fmt(t.sellPrice).padEnd(12) +
        String(t.qty).padEnd(8) +
        fmt(fees).padEnd(12) +
        profitStr
      );
    }
  }

  // ─── SECTIONS 2-9: Core Performance Metrics ─────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTIONS 2–9 — CORE PERFORMANCE METRICS");
  console.log("─".repeat(70));

  // Section 3 — Win/Loss Classification
  const winningTrades   = completedTrades.filter(t => t.netProfit > 0);
  const losingTrades    = completedTrades.filter(t => t.netProfit < 0);
  const breakEvenTrades = completedTrades.filter(t => t.netProfit === 0);
  const totalCompleted  = completedTrades.length;

  // Section 4 — Gross Profit (sum of positive net profits only)
  const grossProfit = winningTrades.reduce((s, t) => s + t.netProfit, 0);

  // Section 5 — Gross Loss (absolute sum of negative net profits)
  const grossLoss = losingTrades.reduce((s, t) => s + Math.abs(t.netProfit), 0);

  // Section 6 — Net Profit
  const netProfit = grossProfit - grossLoss;

  // Section 7 — Largest Win / Largest Loss
  const largestWin  = winningTrades.length ? Math.max(...winningTrades.map(t => t.netProfit)) : 0;
  const largestLoss = losingTrades.length  ? Math.min(...losingTrades.map(t => t.netProfit))  : 0;

  // Section 8 — Profit Factor
  const profitFactor: number | string =
    grossLoss === 0 ? (grossProfit > 0 ? "N/A (No Losing Trades)" : "N/A") : grossProfit / grossLoss;

  // Section 9 — Expectancy
  const winRate  = totalCompleted > 0 ? winningTrades.length / totalCompleted : 0;
  const lossRate = totalCompleted > 0 ? losingTrades.length  / totalCompleted : 0;
  const avgWin   = winningTrades.length ? grossProfit / winningTrades.length : 0;
  const avgLoss  = losingTrades.length  ? grossLoss   / losingTrades.length  : 0;
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss);

  console.log(`Total Trades (raw):      ${allTrades.length}`);
  console.log(`Completed Trades:        ${totalCompleted}`);
  console.log(`Winning Trades:          ${winningTrades.length}`);
  console.log(`Losing Trades:           ${losingTrades.length}`);
  console.log(`Break-Even Trades:       ${breakEvenTrades.length}`);
  console.log(`Verification (W+L+B=C):  ${winningTrades.length}+${losingTrades.length}+${breakEvenTrades.length} = ${winningTrades.length + losingTrades.length + breakEvenTrades.length} (expect ${totalCompleted})`);
  console.log(`Win Rate:                ${pct(winRate * 100)}`);
  console.log(`Loss Rate:               ${pct(lossRate * 100)}`);
  console.log(`Gross Profit:            ${fmt(grossProfit)}`);
  console.log(`Gross Loss:              ${fmt(grossLoss)}`);
  console.log(`Net Profit:              ${fmt(netProfit)}`);
  console.log(`Largest Win:             ${fmt(largestWin)}`);
  console.log(`Largest Loss:            ${fmt(largestLoss)}`);
  console.log(`Average Win:             ${fmt(avgWin)}`);
  console.log(`Average Loss:            ${fmt(avgLoss)}`);
  console.log(`Profit Factor:           ${typeof profitFactor === "number" ? profitFactor.toFixed(2) : profitFactor}`);
  console.log(`Expectancy per Trade:    ${fmt(expectancy)}`);

  // ─── SECTION 10: Maximum Drawdown ───────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 10 — MAXIMUM DRAWDOWN");
  console.log("─".repeat(70));

  const { drawdownRs, drawdownPct, equityCurve } = calcMaxDrawdown(
    completedTrades,
    STARTING_CAPITAL
  );
  const finalEquity = equityCurve[equityCurve.length - 1] ?? STARTING_CAPITAL;

  console.log(`Starting Capital:        ${fmt(STARTING_CAPITAL)}`);
  console.log(`Final Equity (closed):   ${fmt(finalEquity)}`);
  console.log(`Max Drawdown (₹):        ${fmt(drawdownRs)}`);
  console.log(`Max Drawdown (%):        ${pct(drawdownPct)}`);

  // ─── SECTION 11: Fees ───────────────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 11 — FEES ANALYSIS");
  console.log("─".repeat(70));

  const totalBuyFees  = completedTrades.reduce((s, t) => s + t.buyFees, 0);
  const totalSellFees = completedTrades.reduce((s, t) => s + t.sellFees, 0);

  // Also include fees from open BUY positions (unmatched)
  const rawBuyFeeTotal  = buyLogs.reduce((s, t) => s + (t.transactionFees ?? 0), 0);
  const rawSellFeeTotal = sellLogs.reduce((s, t) => s + (t.transactionFees ?? 0), 0);
  const totalBrokerage  = rawBuyFeeTotal + rawSellFeeTotal;

  console.log(`Total Buy Fees (paired): ${fmt(totalBuyFees)}`);
  console.log(`Total Sell Fees (paired):${fmt(totalSellFees)}`);
  console.log(`Total Brokerage (all):   ${fmt(totalBrokerage)}`);
  console.log(`Net Fees Paid (closed):  ${fmt(totalBuyFees + totalSellFees)}`);

  // ─── SECTION 12: Unrealized P&L ─────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 12 — UNREALIZED P&L (OPEN POSITIONS)");
  console.log("─".repeat(70));

  let totalUnrealized = 0;
  let ltpFetched = false;

  // Try to get live prices from the running server
  let apiLtp: Record<string, number> = {};
  try {
    const res = await axios.get("http://localhost:4000/api/trading/status", { timeout: 2000 });
    if (res.data?.success && res.data?.data?.positions) {
      for (const pos of res.data.data.positions) {
        apiLtp[pos.symbol.toUpperCase()] = pos.currentPrice;
      }
      ltpFetched = true;
    }
  } catch {
    // fallback to avgEntryPrice
  }

  if (activePositions.length === 0) {
    console.log("No open positions — Unrealized P&L = ₹0.00");
  } else {
    console.log(`LTP source: ${ltpFetched ? "Running server API" : "Entry price fallback"}`);
    console.log(
      "Symbol".padEnd(12) + "Qty".padEnd(8) + "Avg Entry".padEnd(14) +
      "LTP".padEnd(14) + "Mkt Value".padEnd(16) + "Unrealized P&L"
    );
    console.log("-".repeat(78));

    for (const pos of activePositions) {
      const sym = pos.symbol.toUpperCase();
      const ltp = apiLtp[sym] ?? pos.avgEntryPrice;
      const unrealized = (ltp - pos.avgEntryPrice) * pos.qty;
      const mktValue = ltp * pos.qty;
      totalUnrealized += unrealized;
      const upStr = unrealized >= 0 ? `+${fmt(unrealized)}` : `-${fmt(Math.abs(unrealized))}`;
      console.log(
        sym.padEnd(12) + String(pos.qty).padEnd(8) + fmt(pos.avgEntryPrice).padEnd(14) +
        fmt(ltp).padEnd(14) + fmt(mktValue).padEnd(16) + upStr
      );
    }
    console.log(`\nTotal Unrealized P&L:    ${totalUnrealized >= 0 ? "+" : ""}${fmt(totalUnrealized)}`);
  }

  // ─── SECTION 13: Equity Reconciliation ──────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 13 — EQUITY RECONCILIATION");
  console.log("─".repeat(70));

  // Calculate cash from trade logs
  let cashBalance = STARTING_CAPITAL;
  const sortedAllTrades = [...allTrades].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  for (const log of sortedAllTrades) {
    const fees = log.transactionFees ?? 0;
    if (log.action === "BUY") {
      cashBalance -= (log.totalAmount + fees);
    } else if (log.action === "SELL") {
      cashBalance += (log.totalAmount - fees);
    }
  }

  const openPositionValue = activePositions.reduce((s, pos) => {
    const ltp = apiLtp[pos.symbol.toUpperCase()] ?? pos.avgEntryPrice;
    return s + pos.qty * ltp;
  }, 0);

  const calculatedEquity = cashBalance + openPositionValue;

  // Compare against DailyRiskTracker (today)
  const todayStr = new Date().toISOString().split("T")[0];
  const todayTracker = dailyTrackers.find(d => d.date === todayStr);
  const riskTrackerEquity = todayTracker?.currentEquity ?? STARTING_CAPITAL;

  // Compare against PaperBrokerPosition
  const paperBrokerEquity = paperPositions.reduce((s, p) => s + p.qty * (p.currentPrice || p.avgEntryPrice), 0) + cashBalance;

  const diffRiskTracker   = calculatedEquity - riskTrackerEquity;
  const diffPaperBroker   = calculatedEquity - paperBrokerEquity;

  console.log(`Cash Balance (computed): ${fmt(cashBalance)}`);
  console.log(`Open Position Value:     ${fmt(openPositionValue)}`);
  console.log(`Calculated Equity:       ${fmt(calculatedEquity)}`);
  console.log(`Risk Tracker Equity:     ${fmt(riskTrackerEquity)}`);
  console.log(`Paper Broker Equity:     ${fmt(paperBrokerEquity)}`);
  console.log(`Diff vs Risk Tracker:    ${fmt(diffRiskTracker)} ${Math.abs(diffRiskTracker) < 1 ? "✅" : "⚠️  MISMATCH"}`);
  console.log(`Diff vs Paper Broker:    ${fmt(diffPaperBroker)} ${Math.abs(diffPaperBroker) < 1 ? "✅" : "⚠️  MISMATCH"}`);

  if (Math.abs(diffRiskTracker) >= 1) {
    console.log("  → Likely cause: Risk tracker updated every 60s; LTP delta since last tick.");
  }
  if (Math.abs(diffPaperBroker) >= 1) {
    console.log("  → Likely cause: PaperBrokerPosition table may be stale or uses a different fee model.");
  }

  // ─── SECTION 14: Symbol Analytics ───────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 14 — SYMBOL ANALYTICS");
  console.log("─".repeat(70));

  const symbolMap: Record<string, CompletedTrade[]> = {};
  for (const t of completedTrades) {
    if (!symbolMap[t.symbol]) symbolMap[t.symbol] = [];
    symbolMap[t.symbol].push(t);
  }

  const symbolStats = Object.entries(symbolMap).map(([sym, trades]) => {
    const wins   = trades.filter(t => t.netProfit > 0);
    const losses = trades.filter(t => t.netProfit < 0);
    const symNetProfit = trades.reduce((s, t) => s + t.netProfit, 0);
    const avgHoldMs = trades.reduce((s, t) => s + t.holdingMs, 0) / trades.length;
    const avgReturn = trades.length > 0 ? symNetProfit / trades.length : 0;
    return { sym, trades: trades.length, wins: wins.length, losses: losses.length, symNetProfit, avgHoldMs, avgReturn };
  });

  symbolStats.sort((a, b) => b.symNetProfit - a.symNetProfit);

  console.log(
    "Symbol".padEnd(14) + "Trades".padEnd(8) + "Wins".padEnd(8) +
    "Losses".padEnd(8) + "Net Profit".padEnd(16) + "Avg Hold".padEnd(14) + "Avg Return"
  );
  console.log("-".repeat(78));
  for (const s of symbolStats) {
    const holdStr = s.avgHoldMs < 60000
      ? `${(s.avgHoldMs / 1000).toFixed(0)}s`
      : `${(s.avgHoldMs / 60000).toFixed(1)}min`;
    const npStr = s.symNetProfit >= 0 ? `+${fmt(s.symNetProfit)}` : `-${fmt(Math.abs(s.symNetProfit))}`;
    console.log(
      s.sym.padEnd(14) + String(s.trades).padEnd(8) + String(s.wins).padEnd(8) +
      String(s.losses).padEnd(8) + npStr.padEnd(16) + holdStr.padEnd(14) + fmt(s.avgReturn)
    );
  }
  if (symbolStats.length > 0) {
    console.log(`\n🏆 Best Symbol:  ${symbolStats[0].sym} (${fmt(symbolStats[0].symNetProfit)})`);
    console.log(`📉 Worst Symbol: ${symbolStats[symbolStats.length - 1].sym} (${fmt(symbolStats[symbolStats.length - 1].symNetProfit)})`);
  }

  // ─── SECTION 15: Time Analytics ─────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 15 — TIME ANALYTICS");
  console.log("─".repeat(70));

  // Trades by hour (IST offset = UTC+5:30 = +330 min)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const byHour: Record<number, { count: number; pnl: number }> = {};
  const byDow:  Record<string, { count: number; pnl: number }> = {};
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const t of completedTrades) {
    const istTime = new Date(t.sellTime.getTime() + IST_OFFSET_MS);
    const hour = istTime.getUTCHours();
    const dow  = DOW_NAMES[istTime.getUTCDay()];

    if (!byHour[hour]) byHour[hour] = { count: 0, pnl: 0 };
    byHour[hour].count++;
    byHour[hour].pnl += t.netProfit;

    if (!byDow[dow]) byDow[dow] = { count: 0, pnl: 0 };
    byDow[dow].count++;
    byDow[dow].pnl += t.netProfit;
  }

  if (Object.keys(byHour).length > 0) {
    console.log("\nBy Hour (IST):");
    const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
    for (const h of hours) {
      const session = h < 12 ? "Morning" : h < 14 ? "Midday" : "Afternoon";
      const pnlStr = byHour[h].pnl >= 0 ? `+${fmt(byHour[h].pnl)}` : `-${fmt(Math.abs(byHour[h].pnl))}`;
      console.log(`  ${String(h).padStart(2, "0")}:00 IST | Trades: ${byHour[h].count} | Net: ${pnlStr} | ${session}`);
    }

    // Best and worst trading hour
    const bestHour  = hours.reduce((a, b) => byHour[a].pnl > byHour[b].pnl ? a : b);
    const worstHour = hours.reduce((a, b) => byHour[a].pnl < byHour[b].pnl ? a : b);
    console.log(`  Best Hour:  ${bestHour}:00 IST (${fmt(byHour[bestHour].pnl)})`);
    console.log(`  Worst Hour: ${worstHour}:00 IST (${fmt(byHour[worstHour].pnl)})`);
  }

  if (Object.keys(byDow).length > 0) {
    console.log("\nBy Day of Week:");
    for (const [day, data] of Object.entries(byDow)) {
      const pnlStr = data.pnl >= 0 ? `+${fmt(data.pnl)}` : `-${fmt(Math.abs(data.pnl))}`;
      console.log(`  ${day} | Trades: ${data.count} | Net: ${pnlStr}`);
    }
  }

  // ─── SECTION 16: Strategy Metrics ───────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 16 — STRATEGY METRICS");
  console.log("─".repeat(70));

  const avgHoldingMs = completedTrades.length
    ? completedTrades.reduce((s, t) => s + t.holdingMs, 0) / completedTrades.length
    : 0;
  const avgHoldingMin = avgHoldingMs / 60000;

  const avgReturnPerTrade = completedTrades.length ? netProfit / completedTrades.length : 0;

  // Avg risk-reward: (avgWin / avgLoss)
  const avgRiskReward = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Capital used per trade (approximate)
  const avgCapitalUsed = completedTrades.length
    ? completedTrades.reduce((s, t) => s + t.buyPrice * t.qty, 0) / completedTrades.length
    : 0;

  const capitalEfficiency = avgCapitalUsed > 0
    ? (avgReturnPerTrade / avgCapitalUsed) * 100
    : 0;

  // Recovery factor = Net Profit / Max Drawdown
  const recoveryFactor = drawdownRs > 0 ? netProfit / drawdownRs : 0;

  const netProfitList = completedTrades.map(t => t.netProfit);
  const sharpeRatio  = calcSharpeRatio(netProfitList);
  const sortinoRatio = calcSortinoRatio(netProfitList);

  const { maxConsecutiveWins, maxConsecutiveLosses } = calcStreaks(completedTrades);

  console.log(`Avg Holding Time:        ${avgHoldingMin.toFixed(1)} minutes`);
  console.log(`Avg Return per Trade:    ${fmt(avgReturnPerTrade)}`);
  console.log(`Avg Risk-Reward Ratio:   ${avgRiskReward.toFixed(2)}`);
  console.log(`Sharpe Ratio:            ${sharpeRatio}`);
  console.log(`Sortino Ratio:           ${sortinoRatio === Infinity ? "∞ (no losing days)" : sortinoRatio}`);
  console.log(`Avg Capital Used/Trade:  ${fmt(avgCapitalUsed)}`);
  console.log(`Capital Efficiency:      ${capitalEfficiency.toFixed(4)}%`);
  console.log(`Recovery Factor:         ${recoveryFactor.toFixed(2)}`);
  console.log(`Expectancy:              ${fmt(expectancy)}`);
  console.log(`Max Consecutive Wins:    ${maxConsecutiveWins}`);
  console.log(`Max Consecutive Losses:  ${maxConsecutiveLosses}`);

  // ─── SECTION 17: Operational Reliability ────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 17 — OPERATIONAL RELIABILITY");
  console.log("─".repeat(70));

  const wsReconnects = errorLogs.filter(
    l => l.message?.toLowerCase().includes("websocket") &&
        (l.message?.toLowerCase().includes("reconnect") ||
         l.message?.toLowerCase().includes("disconnect") ||
         l.message?.toLowerCase().includes("closed"))
  ).length;

  const staleFeedEvents = errorLogs.filter(
    l => l.message?.toLowerCase().includes("stale") ||
         l.message?.toLowerCase().includes("stale feed")
  ).length;

  const tradingPauses = errorLogs.filter(
    l => l.message?.toLowerCase().includes("trading paused") ||
         l.message?.toLowerCase().includes("circuit breaker") ||
         l.message?.toLowerCase().includes("halted")
  ).length;

  const tradingResumes = errorLogs.filter(
    l => l.message?.toLowerCase().includes("trading resumed") ||
         l.message?.toLowerCase().includes("resumed")
  ).length;

  const tokenExpiries = errorLogs.filter(
    l => l.message?.toLowerCase().includes("token expired") ||
         l.message?.toLowerCase().includes("401") ||
         l.message?.toLowerCase().includes("unauthorized")
  ).length;

  const recoveryEvents = errorLogs.filter(
    l => l.message?.toLowerCase().includes("recover") ||
         l.message?.toLowerCase().includes("repair")
  ).length;

  const circuitBreakerTrips = errorLogs.filter(
    l => l.message?.toLowerCase().includes("circuit breaker") ||
         l.message?.toLowerCase().includes("circuit open")
  ).length;

  // Count WS disconnects from SystemHealthLog
  const wsDisconnectedLogs = sysHealthLogs.filter(
    l => l.wsStatus === "DISCONNECTED"
  ).length;

  // PositionHealthLog orphans/mismatches
  const totalOrphans    = posHealthLogs.reduce((s, l) => s + (l.orphanPositionsCount ?? 0), 0);
  const totalMismatches = posHealthLogs.reduce((s, l) => s + (l.mismatchesCount ?? 0), 0);

  // Error severity breakdown
  const errorsBySeverity = {
    INFO:     errorLogs.filter(l => l.severity === "INFO").length,
    WARNING:  errorLogs.filter(l => l.severity === "WARNING").length,
    ERROR:    errorLogs.filter(l => l.severity === "ERROR").length,
    CRITICAL: errorLogs.filter(l => l.severity === "CRITICAL").length,
  };

  console.log(`Total Error Logs:        ${errorLogs.length}`);
  console.log(`  INFO:                  ${errorsBySeverity.INFO}`);
  console.log(`  WARNING:               ${errorsBySeverity.WARNING}`);
  console.log(`  ERROR:                 ${errorsBySeverity.ERROR}`);
  console.log(`  CRITICAL:              ${errorsBySeverity.CRITICAL}`);
  console.log(`WS Reconnects:           ${wsReconnects}`);
  console.log(`WS Disconnected (SysLog):${wsDisconnectedLogs}`);
  console.log(`Stale Feed Events:       ${staleFeedEvents}`);
  console.log(`Trading Pauses:          ${tradingPauses}`);
  console.log(`Trading Resumes:         ${tradingResumes}`);
  console.log(`Token Expiry Events:     ${tokenExpiries}`);
  console.log(`Recovery Events:         ${recoveryEvents}`);
  console.log(`Circuit Breaker Trips:   ${circuitBreakerTrips}`);
  console.log(`Position Orphans:        ${totalOrphans}`);
  console.log(`Position Mismatches:     ${totalMismatches}`);

  // ─── SECTION 18: Data Validation ────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("SECTION 18 — DATA VALIDATION & CROSS-CHECKS");
  console.log("─".repeat(70));

  const validationIssues: string[] = [];

  // 1. Completed trade count integrity
  const wlbSum = winningTrades.length + losingTrades.length + breakEvenTrades.length;
  if (wlbSum !== totalCompleted) {
    validationIssues.push(`Win+Loss+BreakEven (${wlbSum}) ≠ Completed Trades (${totalCompleted})`);
  }

  // 2. Orphaned sells
  const orphanedSells = sellLogs.length > buyLogs.length ? sellLogs.length - buyLogs.length : 0;
  if (orphanedSells > 0) {
    validationIssues.push(`${orphanedSells} orphaned SELL logs with no matching BUY`);
  }

  // 3. Active positions vs buy logs gap
  const unresolvedSymbols = new Set(activePositions.map(p => p.symbol.toUpperCase()));
  const tradeSymbols = new Set(allTrades.map(t => t.symbol.toUpperCase()));
  for (const sym of unresolvedSymbols) {
    if (!tradeSymbols.has(sym)) {
      validationIssues.push(`Active position exists for ${sym} but no trade logs found`);
    }
  }

  // 4. Daily tracker halted check
  if (todayTracker?.isHalted) {
    validationIssues.push("DailyRiskTracker shows trading is HALTED today");
  }

  // 5. Stuck orders
  const stuckOrders = orderJournals.filter(
    o => o.status === "INITIATED" || o.status === "SUBMITTED"
  );
  if (stuckOrders.length > 0) {
    validationIssues.push(`${stuckOrders.length} order(s) stuck in INITIATED/SUBMITTED state`);
  }

  // 6. Invalid positions
  const invalidPositions = activePositions.filter(p => p.isInvalid === true);
  if (invalidPositions.length > 0) {
    validationIssues.push(`${invalidPositions.length} active position(s) flagged as INVALID`);
  }

  // 7. Position health orphans
  if (totalOrphans > 0) {
    validationIssues.push(`${totalOrphans} orphan position(s) detected in PositionHealthLog`);
  }

  // 8. Critical errors in last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCritical = errorLogs.filter(
    l => l.severity === "CRITICAL" && new Date(l.createdAt) > oneDayAgo
  );
  if (recentCritical.length > 0) {
    validationIssues.push(`${recentCritical.length} CRITICAL error(s) in last 24 hours`);
  }

  if (validationIssues.length === 0) {
    console.log("✅ All cross-checks PASSED — No data inconsistencies found");
  } else {
    console.log(`⚠️  ${validationIssues.length} issue(s) found:`);
    validationIssues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  }

  // ─── SECTION 19: Final Deployment Decision ───────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("SECTION 19 — FINAL DEPLOYMENT DECISION");
  console.log("=".repeat(70));

  // ── Score each dimension 0-100 ──
  let scores: Record<string, number> = {};

  // 1. Strategy Quality (win rate, profit factor, expectancy)
  let stratScore = 0;
  if (totalCompleted >= 20) stratScore += 20; else stratScore += Math.round((totalCompleted / 20) * 20);
  if (typeof profitFactor === "number" && profitFactor >= 1.5) stratScore += 30;
  else if (typeof profitFactor === "number" && profitFactor >= 1.0) stratScore += 15;
  else if (profitFactor === "N/A (No Losing Trades)" && netProfit > 0) stratScore += 20;
  if (winRate >= 0.6) stratScore += 20; else if (winRate >= 0.5) stratScore += 10;
  if (expectancy > 0) stratScore += 30; else if (expectancy === 0) stratScore += 10;
  scores["Strategy Quality"] = Math.min(stratScore, 100);

  // 2. Risk Management (drawdown, recovery factor, max consecutive losses)
  let riskScore = 100;
  if (drawdownPct > 20) riskScore -= 40;
  else if (drawdownPct > 10) riskScore -= 20;
  else if (drawdownPct > 5) riskScore -= 10;
  if (maxConsecutiveLosses > 5) riskScore -= 20;
  else if (maxConsecutiveLosses > 3) riskScore -= 10;
  if (todayTracker?.isHalted) riskScore -= 20;
  if (recoveryFactor < 1 && totalCompleted > 0) riskScore -= 15;
  scores["Risk Management"] = Math.max(riskScore, 0);

  // 3. Execution Quality (fees vs profit, avg slippage not tracked in logs)
  let execScore = 80;
  const feeToGrossPct = grossProfit > 0 ? ((totalBuyFees + totalSellFees) / grossProfit) * 100 : 100;
  if (feeToGrossPct > 30) execScore -= 30;
  else if (feeToGrossPct > 15) execScore -= 15;
  if (stuckOrders.length > 0) execScore -= 20;
  scores["Execution Quality"] = Math.max(execScore, 0);

  // 4. Operational Reliability (WS, errors, feed)
  let opsScore = 100;
  if (errorsBySeverity.CRITICAL > 0) opsScore -= 30;
  if (errorsBySeverity.ERROR > 10)   opsScore -= 20;
  if (wsReconnects > 5)              opsScore -= 15;
  if (staleFeedEvents > 3)           opsScore -= 15;
  if (circuitBreakerTrips > 0)       opsScore -= 10;
  scores["Operational Reliability"] = Math.max(opsScore, 0);

  // 5. Code Reliability (validation issues, invalid positions, orphans)
  let codeScore = 100;
  codeScore -= Math.min(validationIssues.length * 10, 50);
  if (invalidPositions.length > 0)   codeScore -= 20;
  if (totalMismatches > 0)           codeScore -= 10;
  scores["Code Reliability"] = Math.max(codeScore, 0);

  // 6. Recovery (recovery events present, position repair working)
  let recScore = 70;
  if (recoveryEvents > 0)   recScore += 15;
  if (totalOrphans === 0)   recScore += 15;
  scores["Recovery"] = Math.min(recScore, 100);

  const overallScore = Math.round(
    Object.values(scores).reduce((s, v) => s + v, 0) / Object.keys(scores).length
  );

  console.log("\n📊 Dimension Scores:");
  for (const [dim, score] of Object.entries(scores)) {
    const bar = "█".repeat(Math.round(score / 10)) + "░".repeat(10 - Math.round(score / 10));
    console.log(`  ${dim.padEnd(26)} [${bar}] ${score}/100`);
  }
  console.log(`\n  ${"OVERALL SCORE".padEnd(26)} ${"".padEnd(12)} ${overallScore}/100`);

  // ── Final verdict ──
  let verdict: string;
  let icon: string;
  let rationale: string;

  if (overallScore >= 80) {
    icon = "🟢";
    verdict = "READY FOR LIVE";
    rationale = `Overall score ${overallScore}/100 exceeds threshold. Strategy has positive expectancy (${fmt(expectancy)}), acceptable drawdown (${pct(drawdownPct)}), and reliable execution.`;
  } else if (overallScore >= 65) {
    icon = "🟡";
    verdict = "READY FOR PHASED LIVE (Small Capital)";
    rationale = `Overall score ${overallScore}/100. Some metrics acceptable but full live deployment requires: more completed trades (currently ${totalCompleted}), lower drawdown, and zero critical errors.`;
  } else if (overallScore >= 45) {
    icon = "🟠";
    verdict = "MORE PAPER TESTING REQUIRED";
    rationale = `Overall score ${overallScore}/100. Key deficiencies: ${Object.entries(scores).filter(([,v]) => v < 60).map(([k]) => k).join(", ")}. Minimum 50 completed trades and 60+ on all dimensions required before live.`;
  } else {
    icon = "🔴";
    verdict = "NOT READY";
    rationale = `Overall score ${overallScore}/100. Critical failures detected. Do not deploy live until all validation issues are resolved and all dimensions score ≥60.`;
  }

  console.log(`\n${icon} VERDICT: ${verdict}`);
  console.log(`\n📋 Rationale:`);
  console.log(`   ${rationale}`);

  if (validationIssues.length > 0) {
    console.log(`\n⚠️  Outstanding Issues (must resolve before live):`);
    validationIssues.forEach((issue, i) => console.log(`   ${i + 1}. ${issue}`));
  }

  // ─── JSON Summary ────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("MACHINE-READABLE SUMMARY (JSON)");
  console.log("=".repeat(70));

  const jsonReport = {
    auditTimestamp: new Date().toISOString(),
    section1_tradePairing: {
      rawBuyLogs: buyLogs.length,
      rawSellLogs: sellLogs.length,
      completedTrades: totalCompleted,
    },
    section2to9_performance: {
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      breakEvenTrades: breakEvenTrades.length,
      winRatePct: Number((winRate * 100).toFixed(2)),
      lossRatePct: Number((lossRate * 100).toFixed(2)),
      grossProfitRs: Number(grossProfit.toFixed(2)),
      grossLossRs: Number(grossLoss.toFixed(2)),
      netProfitRs: Number(netProfit.toFixed(2)),
      largestWinRs: Number(largestWin.toFixed(2)),
      largestLossRs: Number(largestLoss.toFixed(2)),
      averageWinRs: Number(avgWin.toFixed(2)),
      averageLossRs: Number(avgLoss.toFixed(2)),
      profitFactor: typeof profitFactor === "number" ? Number(profitFactor.toFixed(2)) : profitFactor,
      expectancyRs: Number(expectancy.toFixed(2)),
    },
    section10_drawdown: {
      maxDrawdownRs: drawdownRs,
      maxDrawdownPct: drawdownPct,
      startingCapital: STARTING_CAPITAL,
      finalEquityClosed: finalEquity,
    },
    section11_fees: {
      totalBuyFeesRs: Number(totalBuyFees.toFixed(2)),
      totalSellFeesRs: Number(totalSellFees.toFixed(2)),
      totalBrokerageRs: Number(totalBrokerage.toFixed(2)),
      netFeesPaidRs: Number((totalBuyFees + totalSellFees).toFixed(2)),
    },
    section12_unrealizedPnl: {
      openPositions: activePositions.length,
      totalUnrealizedRs: Number(totalUnrealized.toFixed(2)),
    },
    section13_equityReconciliation: {
      cashBalanceRs: Number(cashBalance.toFixed(2)),
      openPositionValueRs: Number(openPositionValue.toFixed(2)),
      calculatedEquityRs: Number(calculatedEquity.toFixed(2)),
      riskTrackerEquityRs: Number(riskTrackerEquity.toFixed(2)),
      paperBrokerEquityRs: Number(paperBrokerEquity.toFixed(2)),
      diffVsRiskTrackerRs: Number(diffRiskTracker.toFixed(2)),
      diffVsPaperBrokerRs: Number(diffPaperBroker.toFixed(2)),
    },
    section14_symbolAnalytics: symbolStats.map(s => ({
      symbol: s.sym,
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      netProfitRs: Number(s.symNetProfit.toFixed(2)),
      avgHoldMinutes: Number((s.avgHoldMs / 60000).toFixed(1)),
      avgReturnRs: Number(s.avgReturn.toFixed(2)),
    })),
    section16_strategyMetrics: {
      avgHoldingMinutes: Number(avgHoldingMin.toFixed(1)),
      avgReturnPerTradeRs: Number(avgReturnPerTrade.toFixed(2)),
      avgRiskReward: Number(avgRiskReward.toFixed(2)),
      sharpeRatio,
      sortinoRatio: sortinoRatio === Infinity ? "Infinity" : sortinoRatio,
      avgCapitalUsedRs: Number(avgCapitalUsed.toFixed(2)),
      capitalEfficiencyPct: Number(capitalEfficiency.toFixed(4)),
      recoveryFactor: Number(recoveryFactor.toFixed(2)),
      maxConsecutiveWins,
      maxConsecutiveLosses,
    },
    section17_reliability: {
      totalErrorLogs: errorLogs.length,
      errorsBySeverity,
      wsReconnects,
      wsDisconnectedSystemLogs: wsDisconnectedLogs,
      staleFeedEvents,
      tradingPauses,
      tradingResumes,
      tokenExpiries,
      recoveryEvents,
      circuitBreakerTrips,
      positionOrphans: totalOrphans,
      positionMismatches: totalMismatches,
    },
    section18_dataValidation: {
      passed: validationIssues.length === 0,
      issues: validationIssues,
    },
    section19_finalDecision: {
      scores,
      overallScore,
      icon,
      verdict,
      rationale,
    },
  };

  console.log(JSON.stringify(jsonReport, null, 2));

  // ─── Save Strategy Analytics into MongoDB ──────────────────────────────────
  let runner: any = null;
  try {
    runner = AppDataSource.createQueryRunner() as any;
    const db = runner.databaseConnection.db();
    
    // Process Per Symbol
    const symbolAnalytics = symbolStats.map(s => {
      const symTrades = symbolMap[s.sym] || [];
      const symWins = symTrades.filter(t => t.netProfit > 0);
      const symLosses = symTrades.filter(t => t.netProfit < 0);
      const symGrossProfit = symWins.reduce((sum, t) => sum + t.netProfit, 0);
      const symGrossLoss = Math.abs(symLosses.reduce((sum, t) => sum + t.netProfit, 0));
      const symProfitFactor = symGrossLoss > 0 ? symGrossProfit / symGrossLoss : symGrossProfit > 0 ? Infinity : 0;
      
      const symNetProfit = s.symNetProfit;
      const symWinRate = symTrades.length > 0 ? symWins.length / symTrades.length : 0;
      const symAvgWin = symWins.length > 0 ? symGrossProfit / symWins.length : 0;
      const symAvgLoss = symLosses.length > 0 ? symGrossLoss / symLosses.length : 0;
      const symExpectancy = (symWinRate * symAvgWin) - ((1 - symWinRate) * symAvgLoss);

      // Simple Max Drawdown per symbol
      let symPeak = STARTING_CAPITAL;
      let symEquity = STARTING_CAPITAL;
      let symMaxDD = 0;
      for (const t of symTrades) {
        symEquity += t.netProfit;
        if (symEquity > symPeak) symPeak = symEquity;
        const dd = symPeak - symEquity;
        if (dd > symMaxDD) symMaxDD = dd;
      }

      const symNetProfitList = symTrades.map(t => t.netProfit);
      const symSharpe = calcSharpeRatio(symNetProfitList);
      const symRecoveryFactor = symMaxDD > 0 ? symNetProfit / symMaxDD : 0;

      return {
        symbol: s.sym,
        winRate: symWinRate,
        averageHoldTimeMin: Number((s.avgHoldMs / 60000).toFixed(2)),
        averageProfit: symAvgWin,
        averageLoss: symAvgLoss,
        netProfit: symNetProfit,
        profitFactor: symProfitFactor === Infinity ? "Infinity" : symProfitFactor,
        expectancy: symExpectancy,
        maxDrawdown: symMaxDD,
        sharpeRatio: symSharpe,
        recoveryFactor: symRecoveryFactor,
      };
    });

    // Process Per Day Win Rate
    const dailyStats: Record<string, { total: number; wins: number }> = {};
    for (const t of completedTrades) {
      const istTime = new Date(t.sellTime.getTime() + IST_OFFSET_MS);
      const dateKey = istTime.toISOString().split("T")[0];
      if (!dailyStats[dateKey]) dailyStats[dateKey] = { total: 0, wins: 0 };
      dailyStats[dateKey].total++;
      if (t.netProfit > 0) dailyStats[dateKey].wins++;
    }
    const perDayWinRate = Object.entries(dailyStats).map(([date, data]) => ({
      date,
      totalTrades: data.total,
      winRate: data.total > 0 ? data.wins / data.total : 0,
    }));

    // Process Per Hour Win Rate
    const hourlyStats: Record<number, { total: number; wins: number }> = {};
    for (const t of completedTrades) {
      const istTime = new Date(t.sellTime.getTime() + IST_OFFSET_MS);
      const hour = istTime.getUTCHours();
      if (!hourlyStats[hour]) hourlyStats[hour] = { total: 0, wins: 0 };
      hourlyStats[hour].total++;
      if (t.netProfit > 0) hourlyStats[hour].wins++;
    }
    const perHourWinRate = Object.entries(hourlyStats).map(([hourStr, data]) => ({
      hour: parseInt(hourStr),
      totalTrades: data.total,
      winRate: data.total > 0 ? data.wins / data.total : 0,
    }));

    const analyticsRecord = {
      timestamp: new Date().toISOString(),
      overall: {
        winRate: winRate,
        profitFactor: typeof profitFactor === "number" ? profitFactor : 0,
        netProfit: netProfit,
        maxDrawdown: drawdownRs,
        expectancy: expectancy,
        sharpeRatio,
        sortinoRatio: sortinoRatio === Infinity ? "Infinity" : sortinoRatio,
        recoveryFactor,
      },
      symbols: symbolAnalytics,
      perDay: perDayWinRate,
      perHour: perHourWinRate,
    };

    console.log("\n💾 Saving strategy performance analytics to strategy_analytics collection...");
    await db.collection("strategy_analytics").insertOne(analyticsRecord);
    console.log("✅ Strategy analytics successfully persisted!");
  } catch (saveErr: any) {
    console.error("❌ Failed to save strategy analytics:", saveErr.message);
  } finally {
    if (runner) {
      await runner.release();
    }
  }

  await AppDataSource.destroy();
  console.log("\n✅ Audit complete. Database connection closed.");
}

main().catch(async err => {
  console.error("❌ Audit script failed:", err);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(1);
});
