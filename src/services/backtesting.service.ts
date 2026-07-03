import { CandleService } from "./candle.service";
import { analyzeAdvancedStrategy, prepareStrategyCandles } from "../strategies/strategyEngine";
import { AppDataSource } from "../data-source";
import { BacktestRun } from "../entity/BacktestRun";
import { ObjectId } from "mongodb";

export interface BacktestTrade {
  entryTime: string;
  exitTime: string;
  symbol: string;
  side: "BUY";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  grossPnL: number;
  fees: number;
  netPnL: number;
  reason: string;
  holdingTimeMinutes: number;
  equityAfterTrade: number;
  riskPercent: number;
  expectedRR: number;
}

export class BacktestingService {
  private static calculateFees(amount: number, side: "BUY" | "SELL"): number {
    const flatBrokerage = 20;
    const taxRate = side === "SELL" ? 0.0005 : 0.0003;
    const taxes = amount * taxRate;
    return flatBrokerage + taxes;
  }

  static async runBacktest(
    symbol: string,
    fromDateOrDays: string | number,
    toDateStr?: string,
    initialBalance: number = 100000,
    slippagePct: number = 0.0005, // 0.05% default slippage
    riskPercent: number = 0.01 // 1% risk constraint
  ): Promise<any> {
    let fromDateStr: string;
    let days: number;

    if (typeof fromDateOrDays === "number" || !isNaN(Number(fromDateOrDays))) {
      // Days format
      days = Number(fromDateOrDays);
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - days);

      fromDateStr = fromDate.toISOString().split("T")[0];
      toDateStr = toDate.toISOString().split("T")[0];
    } else {
      // Date range format
      fromDateStr = fromDateOrDays as string;
      if (!toDateStr) {
        toDateStr = new Date().toISOString().split("T")[0];
      }
      const fromDate = new Date(fromDateStr);
      const toDate = new Date(toDateStr);
      const diffTime = Math.abs(toDate.getTime() - fromDate.getTime());
      days = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
    }

    console.log(`📊 Replaying historical strategy for ${symbol} over ${days} days (${fromDateStr} to ${toDateStr})...`);

    // Fetch historical candles via CandleService
    const bars15m = await CandleService.getSyncedCandles(symbol, days);
    const bars1H = await CandleService.get1HourCandles(symbol, days); // Unified 1H candles endpoint

    if (bars15m.length === 0) {
      throw new Error(`No historical 15m candle data found for ${symbol}.`);
    }

    console.log(`📈 Loaded ${bars15m.length} 15-minute and ${bars1H.length} 1-hour candles.`);

    let cash = initialBalance;
    let equity = initialBalance;
    let activePos: {
      qty: number;
      entryPrice: number;
      entryTime: string;
      peakPrice: number;
      stopLossPrice: number;
      trailingStopPrice: number;
      stopOffset: number;
      targetPrice: number;
      expectedRR: number;
    } | null = null;

    const trades: BacktestTrade[] = [];
    const equityCurve: number[] = [initialBalance];
    const drawdownCurve: number[] = [0];

    let peakEquity = initialBalance;
    let maxDrawdown = 0;

    let wins = 0;
    let losses = 0;
    let totalWinStreak = 0;
    let totalLossStreak = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;

    let largestWinner = 0;
    let largestLoser = 0;
    let totalHoldingTime = 0;

    // Daily/Weekly/Monthly/Yearly PnL tracking maps
    const dailyPnL: Record<string, number> = {};
    const weeklyPnL: Record<string, number> = {};
    const monthlyPnL: Record<string, number> = {};
    const yearlyPnL: Record<string, number> = {};

    const lastProcessedTimeMap = new Map<string, string>();

    // Replay candles one by one (Chronological Backtest Engine)
    for (let i = 30; i < bars15m.length; i++) {
      const currentPrice = bars15m[i].c;
      const tickTime = new Date(bars15m[i].t);
      const tickTimeMs = tickTime.getTime();

      // Track active equity values
      const currentPosVal = activePos ? activePos.qty * currentPrice : 0;
      equity = cash + currentPosVal;
      equityCurve.push(equity);

      if (equity > peakEquity) peakEquity = equity;
      const currentDd = (peakEquity - equity) / peakEquity;
      drawdownCurve.push(currentDd);
      if (currentDd > maxDrawdown) maxDrawdown = currentDd;

      // Extract raw history up to current tick
      const rawHistory15m = bars15m.slice(0, i + 1);
      const completed15m = prepareStrategyCandles(rawHistory15m, tickTime, 15);
      const lastCompleted = completed15m[completed15m.length - 1];

      // Time verification
      const utc = tickTime.getTime() + tickTime.getTimezoneOffset() * 60000;
      const ist = new Date(utc + 3600000 * 5.5);
      const timeVal = ist.getHours() * 100 + ist.getMinutes();

      // Find 1H candles completed before this tick
      const completed1H = prepareStrategyCandles(bars1H, tickTime, 60);

      // 1. Check Active Position Stops and Targets first
      if (activePos) {
        // Track new high for trailing stop
        if (currentPrice > activePos.peakPrice) {
          activePos.peakPrice = currentPrice;
          activePos.trailingStopPrice = Math.max(activePos.trailingStopPrice, currentPrice - activePos.stopOffset);
        }

        let exitTriggered = false;
        let exitReason = "";
        let exitPrice = currentPrice;

        if (currentPrice <= activePos.stopLossPrice) {
          exitTriggered = true;
          exitPrice = activePos.stopLossPrice;
          exitReason = "STOP LOSS TRIGGERED";
        } else if (currentPrice <= activePos.trailingStopPrice) {
          exitTriggered = true;
          exitPrice = activePos.trailingStopPrice;
          exitReason = "TRAILING STOP LOSS TRIGGERED";
        } else if (currentPrice >= activePos.targetPrice) {
          exitTriggered = true;
          exitPrice = activePos.targetPrice;
          exitReason = "TARGET PRICE HIT";
        }

        if (exitTriggered) {
          // Adjust for exit slippage
          const simulatedExitPrice = exitPrice * (1 - slippagePct);
          const grossAmount = activePos.qty * simulatedExitPrice;
          const entryAmount = activePos.qty * activePos.entryPrice;

          const entryFees = this.calculateFees(entryAmount, "BUY");
          const exitFees = this.calculateFees(grossAmount, "SELL");
          const totalFees = entryFees + exitFees;

          const grossPnL = grossAmount - entryAmount;
          const netPnL = grossPnL - totalFees;

          cash += (grossAmount - exitFees);
          const holdingMinutes = Math.round((tickTimeMs - new Date(activePos.entryTime).getTime()) / (1000 * 60));

          // Log trade record
          trades.push({
            entryTime: activePos.entryTime,
            exitTime: bars15m[i].t,
            symbol,
            side: "BUY",
            qty: activePos.qty,
            entryPrice: activePos.entryPrice,
            exitPrice: simulatedExitPrice,
            grossPnL,
            fees: totalFees,
            netPnL,
            reason: exitReason,
            holdingTimeMinutes: holdingMinutes,
            equityAfterTrade: cash,
            riskPercent: riskPercent * 100,
            expectedRR: activePos.expectedRR
          });

          // PnL Streaks
          if (netPnL > 0) {
            wins++;
            currentWinStreak++;
            currentLossStreak = 0;
            if (currentWinStreak > totalWinStreak) totalWinStreak = currentWinStreak;
            if (netPnL > largestWinner) largestWinner = netPnL;
          } else {
            losses++;
            currentLossStreak++;
            currentWinStreak = 0;
            if (currentLossStreak > totalLossStreak) totalLossStreak = currentLossStreak;
            if (netPnL < largestLoser) largestLoser = netPnL;
          }

          totalHoldingTime += holdingMinutes;

          // Date breakdowns
          const dayStr = tickTime.toISOString().split("T")[0];
          const monthStr = dayStr.substring(0, 7);
          const yearStr = dayStr.substring(0, 4);

          dailyPnL[dayStr] = (dailyPnL[dayStr] || 0) + netPnL;
          monthlyPnL[monthStr] = (monthlyPnL[monthStr] || 0) + netPnL;
          yearlyPnL[yearStr] = (yearlyPnL[yearStr] || 0) + netPnL;

          activePos = null;
          continue;
        }
      }

      // Skip if already evaluated this completed candle
      if (lastCompleted && lastProcessedTimeMap.get(symbol) === lastCompleted.t) {
        continue;
      }

      if (lastCompleted) {
        lastProcessedTimeMap.set(symbol, lastCompleted.t);
      }

      // 2. Evaluate Strategy Decision
      const strategyReport = analyzeAdvancedStrategy(completed15m, completed1H, timeVal, !!activePos);

      // Handle strategy exit crossover
      if (activePos && strategyReport.signal === "SELL") {
        const simulatedExitPrice = currentPrice * (1 - slippagePct);
        const grossAmount = activePos.qty * simulatedExitPrice;
        const entryAmount = activePos.qty * activePos.entryPrice;

        const entryFees = this.calculateFees(entryAmount, "BUY");
        const exitFees = this.calculateFees(grossAmount, "SELL");
        const totalFees = entryFees + exitFees;

        const grossPnL = grossAmount - entryAmount;
        const netPnL = grossPnL - totalFees;

        cash += (grossAmount - exitFees);
        const holdingMinutes = Math.round((tickTimeMs - new Date(activePos.entryTime).getTime()) / (1000 * 60));

        trades.push({
          entryTime: activePos.entryTime,
          exitTime: bars15m[i].t,
          symbol,
          side: "BUY",
          qty: activePos.qty,
          entryPrice: activePos.entryPrice,
          exitPrice: simulatedExitPrice,
          grossPnL,
          fees: totalFees,
          netPnL,
          reason: "STRATEGY EXIT CROSSOVER TRIGGERED",
          holdingTimeMinutes: holdingMinutes,
          equityAfterTrade: cash,
          riskPercent: riskPercent * 100,
          expectedRR: activePos.expectedRR
        });

        if (netPnL > 0) {
          wins++;
          currentWinStreak++;
          currentLossStreak = 0;
          if (currentWinStreak > totalWinStreak) totalWinStreak = currentWinStreak;
          if (netPnL > largestWinner) largestWinner = netPnL;
        } else {
          losses++;
          currentLossStreak++;
          currentWinStreak = 0;
          if (currentLossStreak > totalLossStreak) totalLossStreak = currentLossStreak;
          if (netPnL < largestLoser) largestLoser = netPnL;
        }

        totalHoldingTime += holdingMinutes;
        activePos = null;
        continue;
      }

      // Handle strategy entry signal
      if (!activePos && strategyReport.signal === "BUY") {
        const atr = strategyReport.atr || 2.0;
        const stopDistance = 2 * atr;

        // Position sizing logic: 1% risk per trade on 2 * ATR
        const maxRisk = equity * riskPercent;
        const qtyRiskLimit = Math.floor(maxRisk / stopDistance);

        // Max 10% capital allocation constraint
        const maxAllocation = equity * 0.10;
        const qtyAllocationLimit = Math.floor(maxAllocation / currentPrice);

        const qty = Math.min(qtyRiskLimit, qtyAllocationLimit || 1);

        if (qty > 0) {
          // Adjust for entry slippage
          const simulatedEntryPrice = currentPrice * (1 + slippagePct);
          const totalCost = qty * simulatedEntryPrice;
          const entryFees = this.calculateFees(totalCost, "BUY");

          if (cash >= (totalCost + entryFees)) {
            cash -= (totalCost + entryFees);

            const highs15m = completed15m.map(c => c.h);
            const resistance = Math.max(...highs15m.slice(-20));

            activePos = {
              qty,
              entryPrice: simulatedEntryPrice,
              entryTime: bars15m[i].t,
              peakPrice: simulatedEntryPrice,
              stopLossPrice: simulatedEntryPrice - 2 * atr,
              trailingStopPrice: simulatedEntryPrice - 2 * atr,
              stopOffset: 1.5 * atr,
              targetPrice: resistance,
              expectedRR: strategyReport.rrRatio || 2.0
            };
          }
        }
      }
    }

    // Force Liquidate on Backtest End
    if (activePos) {
      const finalBar = bars15m[bars15m.length - 1];
      const simulatedExitPrice = finalBar.c * (1 - slippagePct);
      const grossAmount = activePos.qty * simulatedExitPrice;
      const entryAmount = activePos.qty * activePos.entryPrice;

      const entryFees = this.calculateFees(entryAmount, "BUY");
      const exitFees = this.calculateFees(grossAmount, "SELL");
      const totalFees = entryFees + exitFees;

      const grossPnL = grossAmount - entryAmount;
      const netPnL = grossPnL - totalFees;

      cash += (grossAmount - exitFees);
      const holdingMinutes = Math.round((new Date(finalBar.t).getTime() - new Date(activePos.entryTime).getTime()) / (1000 * 60));

      trades.push({
        entryTime: activePos.entryTime,
        exitTime: finalBar.t,
        symbol,
        side: "BUY",
        qty: activePos.qty,
        entryPrice: activePos.entryPrice,
        exitPrice: simulatedExitPrice,
        grossPnL,
        fees: totalFees,
        netPnL,
        reason: "FORCE LIQUIDATION AT BACKTEST TERMINATION",
        holdingTimeMinutes: holdingMinutes,
        equityAfterTrade: cash,
        riskPercent: riskPercent * 100,
        expectedRR: activePos.expectedRR
      });

      if (netPnL > 0) wins++;
      else losses++;
    }

    const finalBalance = cash;
    const totalReturnPercent = ((finalBalance - initialBalance) / initialBalance) * 100;
    const totalTradesCount = trades.length;

    // Advanced Metrics calculations (Sharpe, Sortino, Calmar)
    const netPnLList = trades.map(t => t.netPnL);
    let sharpeRatio = 0;
    let sortinoRatio = 0;

    if (netPnLList.length > 0) {
      const avgReturn = netPnLList.reduce((a, b) => a + b, 0) / netPnLList.length;
      const variance = netPnLList.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / netPnLList.length;
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

      const downsideDiffs = netPnLList.filter(r => r < 0).map(r => Math.pow(r - avgReturn, 2));
      const downsideVariance = downsideDiffs.length > 0 ? downsideDiffs.reduce((a, b) => a + b, 0) / downsideDiffs.length : 0;
      const downsideStdDev = Math.sqrt(downsideVariance);
      sortinoRatio = downsideStdDev > 0 ? avgReturn / downsideStdDev : 0;
    }

    const cagr = Math.pow(finalBalance / initialBalance, 365 / days) - 1;
    const calmarRatio = maxDrawdown > 0 ? cagr / maxDrawdown : 0;

    const winRatePercent = totalTradesCount > 0 ? (wins / totalTradesCount) * 100 : 0;
    const grossProfit = netPnLList.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(netPnLList.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const avgWin = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    const expectancy = (winRatePercent / 100 * avgWin) - ((1 - winRatePercent / 100) * avgLoss);

    // Save Backtest Run in database
    const backtestRepo = AppDataSource.getRepository(BacktestRun);
    const run = new BacktestRun();
    run.symbol = symbol.toUpperCase();
    run.fromDate = fromDateStr;
    run.toDate = toDateStr;
    run.capital = initialBalance;
    run.brokerage = 40;
    run.slippage = slippagePct;
    run.totalTrades = totalTradesCount;
    run.winRatePercent = winRatePercent;
    run.profitFactor = profitFactor;
    run.expectancy = expectancy;
    run.maxDrawdownPercent = maxDrawdown * 100;
    run.sharpeRatio = sharpeRatio;
    run.sortinoRatio = sortinoRatio;
    run.calmarRatio = calmarRatio;
    run.finalBalance = finalBalance;
    run.totalReturnPercent = totalReturnPercent;
    
    run.report = {
      symbol: symbol.toUpperCase(),
      initialBalance,
      finalBalance,
      totalReturnPercent,
      totalTradesCount,
      wins,
      losses,
      winRatePercent,
      profitFactor,
      expectancy,
      maxDrawdownPercent: maxDrawdown * 100,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      longestWinStreak: totalWinStreak,
      longestLossStreak: totalLossStreak,
      averageHoldingTimeMinutes: totalTradesCount > 0 ? totalHoldingTime / totalTradesCount : 0,
      largestWinner,
      largestLoser
    };

    run.trades = trades;
    run.chartsData = {
      equityCurve,
      drawdownCurve: drawdownCurve.map(d => d * 100),
      monthlyReturns: monthlyPnL
    };

    const saved = await backtestRepo.save(run);
    return saved;
  }

  static generateCSV(trades: BacktestTrade[]): string {
    const headers = [
      "Entry Time",
      "Exit Time",
      "Symbol",
      "Side",
      "Quantity",
      "Entry Price",
      "Exit Price",
      "Gross PnL",
      "Fees",
      "Net PnL",
      "Exit Reason",
      "Holding Time (Min)",
      "Expected R:R"
    ];

    const rows = trades.map(t => [
      t.entryTime,
      t.exitTime,
      t.symbol,
      t.side,
      t.qty,
      t.entryPrice.toFixed(2),
      t.exitPrice.toFixed(2),
      t.grossPnL.toFixed(2),
      t.fees.toFixed(2),
      t.netPnL.toFixed(2),
      t.reason,
      t.holdingTimeMinutes,
      t.expectedRR.toFixed(2)
    ]);

    return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  }
}
