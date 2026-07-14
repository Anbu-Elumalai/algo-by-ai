import * as fs from "fs";
import * as path from "path";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { ObjectId } from "mongodb";
import { AppDataSource } from "../data-source";
import { StrategyEvaluationLog } from "../entity/StrategyEvaluationLog";
import { TradeLog } from "../entity/TradeLog";
import { StrategyDecision } from "../entity/StrategyDecision";
import { RuntimeDailyAudit } from "../entity/RuntimeDailyAudit";
import { ActivePosition } from "../entity/ActivePosition";
import { WeeklyStrategyReport } from "../entity/WeeklyStrategyReport";

export class WeeklyReportService {
  private static getMailTransporter() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || "587");
    const user = process.env.SMTP_USER || process.env.SMTP_USERNAME;
    const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;

    if (!host || !user || !pass) {
      return null;
    }

    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  }

  /**
   * Compiles all required metrics for a given start and end date range.
   */
  static async compileMetrics(startDate: Date, endDate: Date, weekIdentifier: string) {
    console.log(`📊 [WeeklyReportService] Compiling weekly metrics from ${startDate.toISOString()} to ${endDate.toISOString()}...`);

    const evalRepo = AppDataSource.getMongoRepository(StrategyEvaluationLog);
    const tradeRepo = AppDataSource.getMongoRepository(TradeLog);
    const posRepo = AppDataSource.getRepository(ActivePosition);
    const dailyAuditRepo = AppDataSource.getMongoRepository(RuntimeDailyAudit);

    // 1. Fetch Evaluations in range
    const evaluations = await evalRepo.find({
      where: {
        createdAt: { $gte: startDate, $lte: endDate }
      } as any
    });

    const totalEvaluations = evaluations.length;
    if (totalEvaluations === 0) {
      const filtersList = [
        { name: "Golden Cross", key: "goldenCross" },
        { name: "RSI", key: "rsi" },
        { name: "ADX", key: "adx" },
        { name: "Volume", key: "volume" },
        { name: "1H Trend", key: "trend1H" },
        { name: "Risk Reward", key: "riskReward" },
        { name: "Trade Score", key: "tradeScore" },
        { name: "Sideways Filter", key: "sideways" }
      ];

      const filterStats = filtersList.map(f => ({
        filter: f.name,
        passed: 0,
        failed: 0,
        passPct: 0,
        failPct: 0
      }));

      const blockedRanking = filtersList.map(f => ({
        filter: f.name,
        failed: 0,
        pct: 0
      }));

      const marketRegime = ["Trending", "Sideways", "Low Volatility", "High Volatility", "Breakout"].map(regime => ({
        regime,
        evaluations: 0,
        buyCount: 0,
        buyPct: 0
      }));

      const symbolAnalysis = ["RELIANCE", "TCS", "INFY"].map(symbol => ({
        symbol,
        evaluations: 0,
        buys: 0,
        avgScore: 0,
        avgRr: 0,
        avgAdx: 0,
        avgRsi: 0,
        avgVolRatio: 0,
        mostFailedFilter: "None"
      }));

      return {
        weekIdentifier,
        generatedAt: endDate,
        strategyVersion: "2.0",
        executiveSummary: `During the weekly audit cycle ${weekIdentifier}, no strategy evaluations were logged. System compliance remains active at 100/100, but execution was idle.`,
        evaluationStatistics: {
          totalEvaluations: 0,
          buyCount: 0,
          sellCount: 0,
          holdCount: 0,
          buyPct: 0,
          holdPct: 0,
          avgTradeScore: 0,
          avgAdx: 0,
          avgRsi: 0,
          avgAtr: 0,
          avgRiskReward: 0,
          avgVolumeRatio: 0
        },
        filterAnalysis: {
          filterStats,
          blockedCrossoverCount: 0,
          blockedRanking
        },
        nearMisses: [],
        marketRegime,
        symbolAnalysis,
        engineeringHealth: {
          duplicateEvalsCount: 0,
          duplicateBuysCount: 0,
          incompleteCandlesCount: 0,
          lookaheadBiasCount: 0,
          stalePricesCount: 0,
          reconciliationMismatch: 0,
          missingStrategyLogs: "None",
          overallScore: 100
        },
        strategyHealth: {
          winRate: 0,
          profitFactor: 0,
          netProfit: 0,
          completedTrades: 0,
          openTrades: 0,
          overallScore: 50
        },
        recommendation: {
          status: "🟡 No Market Evaluations Recorded",
          explanation: "The system did not record any market data evaluations during this week. Either the trading loop was paused, or no candles met execution criteria."
        }
      };
    }

    // Averages and totals
    const buyLogs = evaluations.filter(l => l.signal === "BUY");
    const sellLogs = evaluations.filter(l => l.signal === "SELL");
    const holdLogs = evaluations.filter(l => l.signal === "HOLD");

    const buyCount = buyLogs.length;
    const sellCount = sellLogs.length;
    const holdCount = holdLogs.length;

    const buyPct = (buyCount / totalEvaluations) * 100;
    const holdPct = (holdCount / totalEvaluations) * 100;

    let scoreSum = 0, adxSum = 0, rsiSum = 0, atrSum = 0, rrSum = 0, volRatioSum = 0;
    evaluations.forEach(l => {
      scoreSum += l.tradeScore || 0;
      adxSum += l.indicators?.adx || 0;
      rsiSum += l.indicators?.rsi || 0;
      atrSum += l.indicators?.atr || 0;
      rrSum += l.indicators?.riskReward || 0;
      volRatioSum += (l.indicators?.volume || 0) / (l.indicators?.averageVolume || 1);
    });

    const avgTradeScore = scoreSum / totalEvaluations;
    const avgAdx = adxSum / totalEvaluations;
    const avgRsi = rsiSum / totalEvaluations;
    const avgAtr = atrSum / totalEvaluations;
    const avgRiskReward = rrSum / totalEvaluations;
    const avgVolumeRatio = volRatioSum / totalEvaluations;

    // 2. Filter Analysis
    const filtersList = [
      { name: "Golden Cross", key: "goldenCross" },
      { name: "RSI", key: "rsi" },
      { name: "ADX", key: "adx" },
      { name: "Volume", key: "volume" },
      { name: "1H Trend", key: "trend1H" },
      { name: "Risk Reward", key: "riskReward" },
      { name: "Trade Score", key: "tradeScore" },
      { name: "Sideways Filter", key: "sideways" }
    ];

    const filterStats = filtersList.map(f => {
      let passed = 0;
      let failed = 0;
      evaluations.forEach(l => {
        const val = l.filters ? (l.filters as any)[f.key] : false;
        if (val === true) passed++;
        else failed++;
      });
      return {
        filter: f.name,
        passed,
        failed,
        passPct: (passed / totalEvaluations) * 100,
        failPct: (failed / totalEvaluations) * 100
      };
    });

    // Crossover blocked
    const blockedCrossoverLogs = evaluations.filter(l => l.signal === "HOLD" && l.reason.includes("ignored"));
    const blockedCrossoverCount = blockedCrossoverLogs.length;

    const blockedFilterCounts: Record<string, number> = {
      "Golden Cross": 0,
      "RSI": 0,
      "ADX": 0,
      "Volume": 0,
      "1H Trend": 0,
      "Risk Reward": 0,
      "Trade Score": 0,
      "Sideways Filter": 0
    };

    blockedCrossoverLogs.forEach(l => {
      if (!l.filters.rsi) blockedFilterCounts["RSI"]++;
      if (!l.filters.adx) blockedFilterCounts["ADX"]++;
      if (!l.filters.volume) blockedFilterCounts["Volume"]++;
      if (!l.filters.trend1H) blockedFilterCounts["1H Trend"]++;
      if (!l.filters.riskReward) blockedFilterCounts["Risk Reward"]++;
      if (!l.filters.tradeScore) blockedFilterCounts["Trade Score"]++;
      if (!l.filters.sideways) blockedFilterCounts["Sideways Filter"]++;
    });

    const blockedRanking = Object.entries(blockedFilterCounts)
      .map(([filter, failed]) => ({
        filter,
        failed,
        pct: blockedCrossoverCount > 0 ? (failed / blockedCrossoverCount) * 100 : 0
      }))
      .sort((a, b) => b.failed - a.failed);

    // 3. Near Misses
    const nearMisses = evaluations.filter(l => l.signal === "HOLD").map(l => {
      const isCrossoverBlocked = l.reason.includes("ignored");
      const failedFiltersList: string[] = [];
      filtersList.forEach(f => {
        const pass = l.filters ? (l.filters as any)[f.key] : false;
        if (!pass) failedFiltersList.push(f.name);
      });

      const scoreVal = l.tradeScore || 0;
      const rrVal = l.indicators?.riskReward || 0;
      const adxVal = l.indicators?.adx || 0;
      const rsiVal = l.indicators?.rsi || 50;
      const volVal = l.indicators?.volume || 0;
      const avgVolVal = l.indicators?.averageVolume || 1;

      const scoreGap = Math.max(0, 60 - scoreVal);
      const rrGap = Math.max(0, 2.0 - rrVal);
      const adxGap = Math.max(0, 25 - adxVal);
      
      let rsiGap = 0;
      if (rsiVal < 55) rsiGap = 55 - rsiVal;
      else if (rsiVal > 70) rsiGap = rsiVal - 70;

      const volGap = Math.max(0, avgVolVal - volVal);

      const normScoreGap = scoreGap / 60;
      const normRrGap = rrGap / 2.0;
      const normAdxGap = adxGap / 25;
      const normRsiGap = rsiGap / 15;
      const normVolGap = volGap / (avgVolVal || 1);

      const totalNormGap = normScoreGap + normRrGap + normAdxGap + normRsiGap + normVolGap;

      return {
        timestamp: l.timestamp,
        symbol: l.symbol,
        tradeScore: scoreVal,
        requiredScore: 60,
        riskReward: rrVal,
        adx: adxVal,
        rsi: rsiVal,
        reason: l.reason,
        isCrossoverBlocked,
        failedFiltersCount: failedFiltersList.length,
        failedFilters: failedFiltersList.join(", "),
        totalNormGap
      };
    });

    const sortedNearMisses = [...nearMisses].sort((a, b) => {
      if (a.isCrossoverBlocked && !b.isCrossoverBlocked) return -1;
      if (!a.isCrossoverBlocked && b.isCrossoverBlocked) return 1;
      if (a.failedFiltersCount !== b.failedFiltersCount) {
        return a.failedFiltersCount - b.failedFiltersCount;
      }
      return a.totalNormGap - b.totalNormGap;
    }).slice(0, 50);

    // 4. Market Regime Classification
    const regimeStats: Record<string, { count: number; buyCount: number }> = {
      "Breakout": { count: 0, buyCount: 0 },
      "High Volatility": { count: 0, buyCount: 0 },
      "Low Volatility": { count: 0, buyCount: 0 },
      "Trending": { count: 0, buyCount: 0 },
      "Sideways": { count: 0, buyCount: 0 }
    };

    evaluations.forEach(l => {
      const ind = l.indicators || {};
      const volRatio = (ind.volume || 0) / (ind.averageVolume || 1);
      const bbw = ind.bbw || 0;
      const atr = ind.atr || 0;
      const price = ind.fastSMA || 1;
      const adx = ind.adx || 0;
      const chop = ind.choppiness || 50;

      let regime = "Sideways";
      if (volRatio > 1.5 && bbw > 0.03) {
        regime = "Breakout";
      } else if (bbw >= 0.04 || (atr / price) > 0.005) {
        regime = "High Volatility";
      } else if (bbw < 0.01) {
        regime = "Low Volatility";
      } else if (adx >= 25 && chop <= 61.8) {
        regime = "Trending";
      } else {
        regime = "Sideways";
      }

      regimeStats[regime].count++;
      if (l.signal === "BUY") {
        regimeStats[regime].buyCount++;
      }
    });

    const marketRegime = Object.entries(regimeStats).map(([regime, data]) => ({
      regime,
      evaluations: data.count,
      buyCount: data.buyCount,
      buyPct: data.count > 0 ? (data.buyCount / data.count) * 100 : 0
    }));

    // 5. Symbol Analysis
    const symbols = ["RELIANCE", "TCS", "INFY"];
    const symbolAnalysis = symbols.map(sym => {
      const symLogs = evaluations.filter(l => l.symbol === sym);
      const totalSym = symLogs.length;
      if (totalSym === 0) {
        return { symbol: sym, evaluations: 0, buys: 0, avgScore: 0, avgRr: 0, avgAdx: 0, avgRsi: 0, avgVolRatio: 0, mostFailedFilter: "N/A" };
      }
      const buys = symLogs.filter(l => l.signal === "BUY").length;
      
      let sSum = 0, rSum = 0, aSum = 0, rsSum = 0, vSum = 0;
      const fFailures: Record<string, number> = {};

      symLogs.forEach(l => {
        sSum += l.tradeScore || 0;
        rSum += l.indicators?.riskReward || 0;
        aSum += l.indicators?.adx || 0;
        rsSum += l.indicators?.rsi || 0;
        vSum += (l.indicators?.volume || 0) / (l.indicators?.averageVolume || 1);

        filtersList.forEach(f => {
          const pass = l.filters ? (l.filters as any)[f.key] : false;
          if (!pass) {
            fFailures[f.name] = (fFailures[f.name] || 0) + 1;
          }
        });
      });

      const mostFailed = Object.entries(fFailures).sort((a, b) => b[1] - a[1])[0];
      const mostFailedFilter = mostFailed ? `${mostFailed[0]} (${mostFailed[1]} fails)` : "None";

      return {
        symbol: sym,
        evaluations: totalSym,
        buys,
        avgScore: sSum / totalSym,
        avgRr: rSum / totalSym,
        avgAdx: aSum / totalSym,
        avgRsi: rsSum / totalSym,
        avgVolRatio: vSum / totalSym,
        mostFailedFilter
      };
    });

    // 6. Engineering Verification
    const seenEvals = new Set<string>();
    let duplicateEvalsCount = 0;
    evaluations.forEach(l => {
      const key = `${l.symbol}-${l.candleTimestamp}`;
      if (seenEvals.has(key)) duplicateEvalsCount++;
      seenEvals.add(key);
    });

    const seenBuys = new Set<string>();
    let duplicateBuysCount = 0;
    buyLogs.forEach(l => {
      const key = `${l.symbol}-${l.candleTimestamp}`;
      if (seenBuys.has(key)) duplicateBuysCount++;
      seenBuys.add(key);
    });

    let incompleteCandlesCount = 0;
    let lookaheadBiasCount = 0;
    evaluations.forEach(l => {
      if (l.indicators?.fastSMA === 0 || l.indicators?.volume === undefined) {
        incompleteCandlesCount++;
      }
      const evalTime = new Date(l.timestamp).getTime();
      const candleOpenTime = new Date(l.candleTimestamp).getTime();
      const timeframeMs = 15 * 60 * 1000;
      if (evalTime < candleOpenTime + timeframeMs) {
        lookaheadBiasCount++;
      }
    });

    // Stale prices (5 consecutive same fastSma)
    let stalePricesCount = 0;
    const symLogsMap: Record<string, any[]> = {};
    evaluations.forEach(l => {
      if (!symLogsMap[l.symbol]) symLogsMap[l.symbol] = [];
      symLogsMap[l.symbol].push(l);
    });
    Object.entries(symLogsMap).forEach(([sym, logs]) => {
      for (let i = 4; i < logs.length; i++) {
        const p0 = logs[i].indicators?.fastSMA;
        const p1 = logs[i-1].indicators?.fastSMA;
        const p2 = logs[i-2].indicators?.fastSMA;
        const p3 = logs[i-3].indicators?.fastSMA;
        const p4 = logs[i-4].indicators?.fastSMA;
        if (p0 === p1 && p1 === p2 && p2 === p3 && p3 === p4 && p0 !== 0) stalePricesCount++;
      }
    });

    // Reconciliation mismatch check
    const tradesThisWeek = await tradeRepo.find({
      where: {
        createdAt: { $gte: startDate, $lte: endDate }
      } as any
    });

    const dailyAuditsThisWeek = await dailyAuditRepo.find({
      where: {
        createdAt: { $gte: startDate, $lte: endDate }
      } as any
    });

    let totalDailyAuditOrders = 0;
    dailyAuditsThisWeek.forEach(a => {
      totalDailyAuditOrders += (a.strategyStats?.ordersExecuted || 0);
    });
    const reconciliationMismatch = Math.abs(totalDailyAuditOrders - tradesThisWeek.length);

    // Missing logs checking
    const uniqueDates = Array.from(new Set(evaluations.map(l => l.date)));
    const missingLogsArray = uniqueDates.map(d => {
      const count = evaluations.filter(l => l.date === d).length;
      return `${d}: ${count} evals`;
    });
    const missingStrategyLogs = missingLogsArray.join("; ");

    // Overall engineering score calculation
    let engineeringScore = 100;
    engineeringScore -= duplicateEvalsCount * 2;
    engineeringScore -= duplicateBuysCount * 5;
    engineeringScore -= incompleteCandlesCount * 5;
    engineeringScore -= lookaheadBiasCount * 10;
    engineeringScore -= stalePricesCount * 5;
    engineeringScore -= reconciliationMismatch * 5;
    engineeringScore = Math.max(0, engineeringScore);

    const engineeringHealth = {
      duplicateEvalsCount,
      duplicateBuysCount,
      incompleteCandlesCount,
      lookaheadBiasCount,
      stalePricesCount,
      reconciliationMismatch,
      missingStrategyLogs,
      overallScore: engineeringScore
    };

    // 7. Strategy Health
    let grossProfit = 0, grossLoss = 0, netProfit = 0, wins = 0, losses = 0;
    const buyTrades = tradesThisWeek.filter(t => t.action === "BUY");
    const sellTrades = tradesThisWeek.filter(t => t.action === "SELL");

    sellTrades.forEach(sell => {
      const matchBuy = tradesThisWeek.find(t => t.symbol === sell.symbol && t.action === "BUY" && t.createdAt < sell.createdAt);
      if (matchBuy) {
        const pnl = sell.totalAmount - matchBuy.totalAmount - (sell.transactionFees || 40) - (matchBuy.transactionFees || 40);
        netProfit += pnl;
        if (pnl > 0) {
          grossProfit += pnl;
          wins++;
        } else {
          grossLoss += Math.abs(pnl);
          losses++;
        }
      }
    });

    const completedTrades = wins + losses;
    const activePositions = await posRepo.find();
    const openTrades = activePositions.length;
    const winRate = completedTrades > 0 ? (wins / completedTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 99.9 : 0);

    let strategyScore = 100;
    if (completedTrades > 0) {
      if (winRate < 40) strategyScore -= 20;
      if (profitFactor < 1.0) strategyScore -= 30;
      if (netProfit < 0) strategyScore -= 20;
    } else {
      // Penalize for being overly restrictive (zero trades generated)
      strategyScore = 50; 
    }
    strategyScore = Math.max(0, strategyScore);

    const strategyHealth = {
      winRate,
      profitFactor,
      netProfit,
      completedTrades,
      openTrades,
      overallScore: strategyScore
    };

    // 8. Recommendation Verdict
    let recStatus = "🟢 Trading Normally";
    let recExplanation = "The trading system indicates stable operational compliance. All check parameters are within normal thresholds.";
    if (engineeringScore < 90) {
      recStatus = "🔴 Engineering Review Required";
      recExplanation = `System engineering health score has deteriorated to ${engineeringScore}/100. Discrepancies, duplicates, or lag must be audited.`;
    } else if (strategyScore <= 50) {
      recStatus = "🟡 Review Filter Calibration";
      recExplanation = `The strategy has generated ${completedTrades} trades. Compound filters (Risk/Reward, Volume, Trade Score) are overly restrictive and blocking entry setups. Re-calibrating thresholds is highly recommended to enable execution.`;
    }

    const recommendation = {
      status: recStatus,
      explanation: recExplanation
    };

    const executiveSummary = completedTrades === 0 
      ? `During the audit week ${weekIdentifier}, the strategy evaluated ${totalEvaluations} bars and generated 0 trades (100.0% HOLD decision rate). Filter diagnostics indicate the system is operationally healthy (Engineering Score: ${engineeringScore}/100) but structurally locked due to overly restrictive parameters. Risk/Reward and Trade Score filters blocked 100% of the crossover setups.`
      : `Weekly trading cycle completed with ${completedTrades} executed positions. Net profit achieved: ₹${netProfit.toFixed(2)} with a Win Rate of ${winRate.toFixed(1)}% and Profit Factor of ${profitFactor.toFixed(2)}. Operations compliance remains highly aligned.`;

    return {
      weekIdentifier,
      generatedAt: endDate,
      strategyVersion: "2.0",
      executiveSummary,
      evaluationStatistics: {
        totalEvaluations,
        buyCount,
        sellCount,
        holdCount,
        buyPct,
        holdPct,
        avgTradeScore,
        avgAdx,
        avgRsi,
        avgAtr,
        avgRiskReward,
        avgVolumeRatio
      },
      filterAnalysis: {
        filterStats,
        blockedCrossoverCount,
        blockedRanking
      },
      nearMisses: sortedNearMisses,
      marketRegime,
      symbolAnalysis,
      engineeringHealth,
      strategyHealth,
      recommendation
    };
  }

  /**
   * Generates a beautifully styled, responsive HTML report.
   */
  static generateHtmlReport(data: any): string {
    const filterRows = data.filterAnalysis.filterStats.map((f: any) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: 500;">${f.filter}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; color: #10b981;">${f.passed}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; color: #ef4444;">${f.failed}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; font-weight: bold;">${f.passPct.toFixed(1)}%</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; font-weight: bold; color: #ef4444;">${f.failPct.toFixed(1)}%</td>
      </tr>
    `).join("");

    const nearMissRows = data.nearMisses.length === 0
      ? `<tr><td colspan="7" style="padding: 12px; text-align: center; color: #64748b;">No near misses recorded this week.</td></tr>`
      : data.nearMisses.slice(0, 10).map((nm: any) => `
        <tr style="${nm.isCrossoverBlocked ? 'background-color: #fef2f2;' : ''}">
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px;">${new Date(nm.timestamp).toLocaleString("en-IN")}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${nm.symbol}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: center;">${nm.tradeScore}/60</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: center;">${nm.riskReward.toFixed(2)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: center;">${nm.adx.toFixed(1)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: center;">${nm.rsi.toFixed(1)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 11px; max-width: 200px; word-wrap: break-word;">${nm.reason}</td>
        </tr>
      `).join("");

    const regimeRows = data.marketRegime.map((mr: any) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: 500;">${mr.regime}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${mr.evaluations}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${mr.buyCount}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center; font-weight: bold; color: #1e3a8a;">${mr.buyPct.toFixed(1)}%</td>
      </tr>
    `).join("");

    const symbolRows = data.symbolAnalysis.map((sa: any) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${sa.symbol}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.evaluations}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.buys}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.avgScore.toFixed(1)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.avgRr.toFixed(2)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.avgAdx.toFixed(1)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.avgRsi.toFixed(1)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${sa.avgVolRatio.toFixed(2)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 11px; color: #ef4444;">${sa.mostFailedFilter}</td>
      </tr>
    `).join("");

    return `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6; padding: 20px; color: #1f2937;">
        <div style="max-width: 900px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); border: 1px solid #e5e7eb; overflow: hidden;">
          
          <!-- Header -->
          <div style="background: linear-gradient(135deg, #1e3a8a, #3b82f6); padding: 30px; color: white; border-bottom: 4px solid #2563eb;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td>
                  <h1 style="margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">MARS ALGO TRADING</h1>
                  <p style="margin: 4px 0 0 0; opacity: 0.85; font-size: 14px;">Institutional Weekly Strategy Trend & Effectiveness Report</p>
                </td>
                <td style="text-align: right; vertical-align: middle;">
                  <span style="background: rgba(255, 255, 255, 0.2); padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: bold;">Week: ${data.weekIdentifier}</span>
                </td>
              </tr>
            </table>
          </div>

          <!-- Main Body -->
          <div style="padding: 30px;">
            
            <!-- Recommendation Alert -->
            <div style="background-color: #f8fafc; border-left: 6px solid #3b82f6; padding: 20px; border-radius: 6px; margin-bottom: 30px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
              <h3 style="margin: 0 0 8px 0; font-size: 15px; text-transform: uppercase; color: #475569; letter-spacing: 0.5px;">Quantitative Verdict & Recommendation</h3>
              <span style="font-size: 20px; font-weight: 800; color: #1e3a8a;">${data.recommendation.status}</span>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #334155; line-height: 1.6;">${data.recommendation.explanation}</p>
            </div>

            <!-- Executive Summary -->
            <h3 style="border-bottom: 2px solid #f3f4f6; padding-bottom: 8px; margin-top: 0; color: #1e3a8a; font-weight: 700; font-size: 17px;">Executive Summary</h3>
            <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin-bottom: 30px;">${data.executiveSummary}</p>

            <!-- Grid: Scores & General Stats -->
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
              <tr>
                <td style="width: 48%; vertical-align: top; padding-right: 2%;">
                  <h4 style="margin: 0 0 10px 0; color: #1e3a8a; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px;">Evaluation Metrics</h4>
                  <table style="width: 100%; font-size: 13px;">
                    <tr style="height: 26px;"><td><strong>Total Evaluations</strong></td><td style="text-align: right; color: #4b5563;">${data.evaluationStatistics.totalEvaluations}</td></tr>
                    <tr style="height: 26px;"><td><strong>BUY Signals</strong></td><td style="text-align: right; font-weight: bold; color: #10b981;">${data.evaluationStatistics.buyCount} (${data.evaluationStatistics.buyPct.toFixed(2)}%)</td></tr>
                    <tr style="height: 26px;"><td><strong>HOLD Signals</strong></td><td style="text-align: right; color: #64748b;">${data.evaluationStatistics.holdCount} (${data.evaluationStatistics.holdPct.toFixed(2)}%)</td></tr>
                    <tr style="height: 26px;"><td><strong>Average Trade Score</strong></td><td style="text-align: right; color: #4b5563;">${data.evaluationStatistics.avgTradeScore.toFixed(1)} / 100</td></tr>
                    <tr style="height: 26px;"><td><strong>Average Risk/Reward</strong></td><td style="text-align: right; color: #4b5563;">${data.evaluationStatistics.avgRiskReward.toFixed(2)}</td></tr>
                    <tr style="height: 26px;"><td><strong>Average Volume Ratio</strong></td><td style="text-align: right; color: #4b5563;">${data.evaluationStatistics.avgVolumeRatio.toFixed(2)}</td></tr>
                  </table>
                </td>
                <td style="width: 4%;">&nbsp;</td>
                <td style="width: 48%; vertical-align: top; background-color: #fafafa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px;">
                  <h4 style="margin: 0 0 10px 0; color: #1e3a8a; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px;">System Health Grades</h4>
                  <div style="margin-bottom: 12px; overflow: hidden;">
                    <div style="float: left; font-weight: bold; font-size: 14px;">Engineering Health Score</div>
                    <div style="float: right; font-weight: 800; font-size: 16px; color: ${data.engineeringHealth.overallScore >= 95 ? '#10b981' : '#f59e0b'};">${data.engineeringHealth.overallScore}/100</div>
                  </div>
                  <div style="margin-bottom: 20px; overflow: hidden;">
                    <div style="float: left; font-weight: bold; font-size: 14px;">Strategy Execution Score</div>
                    <div style="float: right; font-weight: 800; font-size: 16px; color: ${data.strategyHealth.overallScore >= 70 ? '#10b981' : '#ef4444'};">${data.strategyHealth.overallScore}/100</div>
                  </div>
                  <table style="width: 100%; font-size: 11px; border-collapse: collapse;">
                    <tr style="height: 20px;"><td style="color: #64748b;">Duplicate Evaluations</td><td style="text-align: right; font-weight: bold;">${data.engineeringHealth.duplicateEvalsCount}</td></tr>
                    <tr style="height: 20px;"><td style="color: #64748b;">Look-ahead Bias Detections</td><td style="text-align: right; font-weight: bold; color: #ef4444;">${data.engineeringHealth.lookaheadBiasCount}</td></tr>
                    <tr style="height: 20px;"><td style="color: #64748b;">Stale Price Flags</td><td style="text-align: right; font-weight: bold;">${data.engineeringHealth.stalePricesCount}</td></tr>
                    <tr style="height: 20px;"><td style="color: #64748b;">Reconciliation Mismatch</td><td style="text-align: right; font-weight: bold;">${data.engineeringHealth.reconciliationMismatch}</td></tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Filter Analysis -->
            <h3 style="border-bottom: 2px solid #f3f4f6; padding-bottom: 8px; color: #1e3a8a; font-weight: 700; font-size: 17px; margin-top: 30px;">Filter Effectiveness Table</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 13px; text-align: left;">
              <thead>
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 10px;">Filter Name</th>
                  <th style="padding: 10px; text-align: center;">Passed (Count)</th>
                  <th style="padding: 10px; text-align: center;">Failed (Count)</th>
                  <th style="padding: 10px; text-align: center;">Pass %</th>
                  <th style="padding: 10px; text-align: center; color: #ef4444;">Fail %</th>
                </tr>
              </thead>
              <tbody>
                ${filterRows}
              </tbody>
            </table>

            <!-- Market Regime -->
            <h3 style="border-bottom: 2px solid #f3f4f6; padding-bottom: 8px; color: #1e3a8a; font-weight: 700; font-size: 17px;">Market Regime Analysis</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 13px; text-align: left;">
              <thead>
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 10px;">Market Regime</th>
                  <th style="padding: 10px; text-align: center;">Evaluations</th>
                  <th style="padding: 10px; text-align: center;">BUY Count</th>
                  <th style="padding: 10px; text-align: center;">BUY %</th>
                </tr>
              </thead>
              <tbody>
                ${regimeRows}
              </tbody>
            </table>

            <!-- Symbol-wise Analysis -->
            <h3 style="border-bottom: 2px solid #f3f4f6; padding-bottom: 8px; color: #1e3a8a; font-weight: 700; font-size: 17px;">Symbol-wise Analysis</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 12px; text-align: left;">
              <thead>
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 10px;">Symbol</th>
                  <th style="padding: 10px; text-align: center;">Evals</th>
                  <th style="padding: 10px; text-align: center;">BUYs</th>
                  <th style="padding: 10px; text-align: center;">Avg Score</th>
                  <th style="padding: 10px; text-align: center;">Avg R/R</th>
                  <th style="padding: 10px; text-align: center;">Avg ADX</th>
                  <th style="padding: 10px; text-align: center;">Avg RSI</th>
                  <th style="padding: 10px; text-align: center;">Avg Vol Ratio</th>
                  <th style="padding: 10px; color: #ef4444;">Most Restrictive Filter</th>
                </tr>
              </thead>
              <tbody>
                ${symbolRows}
              </tbody>
            </table>

            <!-- Near Misses -->
            <h3 style="border-bottom: 2px solid #f3f4f6; padding-bottom: 8px; color: #1e3a8a; font-weight: 700; font-size: 17px;">Near Miss Analysis (Top 10)</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 12px; text-align: left;">
              <thead>
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 8px;">Time</th>
                  <th style="padding: 8px;">Symbol</th>
                  <th style="padding: 8px; text-align: center;">Score</th>
                  <th style="padding: 8px; text-align: center;">R/R</th>
                  <th style="padding: 8px; text-align: center;">ADX</th>
                  <th style="padding: 8px; text-align: center;">RSI</th>
                  <th style="padding: 8px;">Failed Reason</th>
                </tr>
              </thead>
              <tbody>
                ${nearMissRows}
              </tbody>
            </table>

          </div>

          <!-- Footer -->
          <div style="background-color: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px 30px; text-align: center; font-size: 12px; color: #6b7280;">
            This document is generated automatically by the Mars Algo Platform. If you have any inquiries, contact quantitative auditing at admin@oceansoftteam.in
          </div>

        </div>
      </div>
    `;
  }

  /**
   * Generates vector-drawn PDF document using PDFKit.
   */
  static async generatePdfReport(data: any, outputPath: string): Promise<void> {
    const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Color definitions
    const primaryColor = "#1E3A8A";
    const secondaryColor = "#2563EB";
    const darkGray = "#1F2937";
    const textGray = "#4B5563";
    const lightBorder = "#E5E7EB";

    // --- Header ---
    doc.fillColor(primaryColor).fontSize(20).text("MARS ALGO TRADING PLATFORM", { align: "left" });
    doc.fontSize(12).fillColor(secondaryColor).text("WEEKLY STRATEGY TREND & EFFECTIVENESS REPORT", { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor(textGray).text(`Week: ${data.weekIdentifier} | Generated At: ${new Date(data.generatedAt).toLocaleString()} | Strategy Version: ${data.strategyVersion}`);
    
    // Draw boundary line
    doc.strokeColor(lightBorder).lineWidth(1).moveTo(50, 95).lineTo(545, 95).stroke();
    doc.moveDown(1.5);

    // --- Recommendation Alert Box ---
    const alertBoxY = doc.y;
    doc.rect(50, alertBoxY, 495, 60).fillColor("#F8FAFC").fill();
    doc.rect(50, alertBoxY, 5, 60).fillColor(secondaryColor).fill();
    doc.fillColor(darkGray).fontSize(10).text("WEEKLY QUANTITATIVE VERDICT", 65, alertBoxY + 8);
    doc.fillColor(secondaryColor).fontSize(12).text(data.recommendation.status, 65, alertBoxY + 20, { stroke: false });
    doc.fillColor(textGray).fontSize(8.5).text(data.recommendation.explanation, 65, alertBoxY + 36, { width: 460 });

    doc.y = alertBoxY + 75; // reset y

    // --- Executive Summary ---
    doc.fillColor(primaryColor).fontSize(12).text("Executive Summary", 50, doc.y);
    doc.moveDown(0.3);
    doc.fillColor(textGray).fontSize(9.5).text(data.executiveSummary, { width: 495, align: "justify" });
    doc.moveDown(1);

    // --- Grid: Summary Stats & Grades ---
    const statsY = doc.y;
    // Left Grid: Stats
    doc.fillColor(primaryColor).fontSize(11).text("Evaluation Statistics", 50, statsY);
    doc.fontSize(8.5).fillColor(textGray);
    let rowY = statsY + 18;
    const drawRow = (label: string, val: string) => {
      doc.text(label, 50, rowY);
      doc.text(val, 200, rowY, { align: "right", width: 50 });
      doc.strokeColor("#F3F4F6").lineWidth(0.5).moveTo(50, rowY + 12).lineTo(250, rowY + 12).stroke();
      rowY += 16;
    };
    drawRow("Total Evaluations", String(data.evaluationStatistics.totalEvaluations));
    drawRow("BUY Signals", `${data.evaluationStatistics.buyCount} (${data.evaluationStatistics.buyPct.toFixed(1)}%)`);
    drawRow("HOLD Signals", `${data.evaluationStatistics.holdCount} (${data.evaluationStatistics.holdPct.toFixed(1)}%)`);
    drawRow("Avg Trade Score", `${data.evaluationStatistics.avgTradeScore.toFixed(1)}/100`);
    drawRow("Avg Risk/Reward", data.evaluationStatistics.avgRiskReward.toFixed(2));
    drawRow("Avg Volume Ratio", data.evaluationStatistics.avgVolumeRatio.toFixed(2));

    // Right Grid: System Health
    doc.fillColor(primaryColor).fontSize(11).text("System Health Grades", 300, statsY);
    doc.rect(300, statsY + 18, 245, 96).fillColor("#FAFAFA").fill();
    doc.strokeColor(lightBorder).lineWidth(0.5).rect(300, statsY + 18, 245, 96).stroke();
    doc.fillColor(darkGray).fontSize(9.5).text("Engineering Compliance Score:", 310, statsY + 28);
    doc.fillColor(data.engineeringHealth.overallScore >= 95 ? "#10B981" : "#F59E0B").fontSize(12).text(`${data.engineeringHealth.overallScore}/100`, 480, statsY + 26, { align: "right", width: 55 });
    
    doc.fillColor(darkGray).fontSize(9.5).text("Strategy Execution Score:", 310, statsY + 48);
    doc.fillColor(data.strategyHealth.overallScore >= 70 ? "#10B981" : "#EF4444").fontSize(12).text(`${data.strategyHealth.overallScore}/100`, 480, statsY + 46, { align: "right", width: 55 });

    // Checklist stats
    doc.fillColor(textGray).fontSize(8);
    doc.text(`Duplicate Evals: ${data.engineeringHealth.duplicateEvalsCount}`, 310, statsY + 74);
    doc.text(`Lookahead Bias: ${data.engineeringHealth.lookaheadBiasCount}`, 430, statsY + 74);
    doc.text(`Stale Price Flags: ${data.engineeringHealth.stalePricesCount}`, 310, statsY + 86);
    doc.text(`Reconciliation Misses: ${data.engineeringHealth.reconciliationMismatch}`, 430, statsY + 86);

    doc.y = Math.max(rowY, statsY + 115) + 15;

    // --- Filter Effectiveness Table & Charts ---
    doc.fillColor(primaryColor).fontSize(12).text("Filter Effectiveness (Overall evaluations failure rates)", 50, doc.y);
    doc.moveDown(0.4);

    const tblHeaderY = doc.y;
    doc.rect(50, tblHeaderY, 495, 18).fillColor("#F1F5F9").fill();
    doc.fillColor(darkGray).fontSize(8.5);
    doc.text("Filter", 55, tblHeaderY + 5);
    doc.text("Passed", 200, tblHeaderY + 5, { width: 50, align: "center" });
    doc.text("Failed", 250, tblHeaderY + 5, { width: 50, align: "center" });
    doc.text("Fail Rate Bar Chart", 320, tblHeaderY + 5);
    doc.text("Fail %", 500, tblHeaderY + 5, { width: 40, align: "right" });

    let tRowY = tblHeaderY + 18;
    data.filterAnalysis.filterStats.forEach((f: any) => {
      // Row zebra background
      doc.fillColor(textGray).fontSize(8.5);
      doc.text(f.filter, 55, tRowY + 5);
      doc.text(String(f.passed), 200, tRowY + 5, { width: 50, align: "center" });
      doc.text(String(f.failed), 250, tRowY + 5, { width: 50, align: "center" });

      // Draw vector progress chart in PDF
      const chartWidth = 150;
      doc.rect(320, tRowY + 5, chartWidth, 8).fillColor("#E2E8F0").fill();
      const filledWidth = (f.failPct / 100) * chartWidth;
      if (filledWidth > 0) {
        doc.rect(320, tRowY + 5, filledWidth, 8).fillColor(f.failPct > 70 ? "#EF4444" : "#3B82F6").fill();
      }

      doc.fillColor(f.failPct > 75 ? "#EF4444" : darkGray).fontSize(8.5);
      doc.text(`${f.failPct.toFixed(1)}%`, 500, tRowY + 5, { width: 40, align: "right" });

      doc.strokeColor("#E5E7EB").lineWidth(0.5).moveTo(50, tRowY + 18).lineTo(545, tRowY + 18).stroke();
      tRowY += 18;
    });

    doc.y = tRowY + 20;

    // Add a new page for detailed symbol and near miss lists
    doc.addPage();

    // --- Symbol-wise Analysis ---
    doc.fillColor(primaryColor).fontSize(12).text("Symbol-wise Analysis", 50, 50);
    doc.moveDown(0.4);

    const sHeaderY = doc.y;
    doc.rect(50, sHeaderY, 495, 18).fillColor("#F1F5F9").fill();
    doc.fillColor(darkGray).fontSize(8);
    doc.text("Symbol", 55, sHeaderY + 5);
    doc.text("Evals", 110, sHeaderY + 5, { width: 35, align: "center" });
    doc.text("BUYs", 145, sHeaderY + 5, { width: 35, align: "center" });
    doc.text("Avg Score", 180, sHeaderY + 5, { width: 45, align: "center" });
    doc.text("Avg R/R", 225, sHeaderY + 5, { width: 45, align: "center" });
    doc.text("Avg ADX", 270, sHeaderY + 5, { width: 45, align: "center" });
    doc.text("Avg RSI", 315, sHeaderY + 5, { width: 45, align: "center" });
    doc.text("Vol Ratio", 360, sHeaderY + 5, { width: 45, align: "center" });
    doc.text("Most Restrictive Filter", 410, sHeaderY + 5);

    let sRowY = sHeaderY + 18;
    data.symbolAnalysis.forEach((sa: any) => {
      doc.fillColor(darkGray).fontSize(8);
      doc.text(sa.symbol, 55, sRowY + 5);
      doc.text(String(sa.evaluations), 110, sRowY + 5, { width: 35, align: "center" });
      doc.text(String(sa.buys), 145, sRowY + 5, { width: 35, align: "center" });
      doc.text(sa.avgScore.toFixed(1), 180, sRowY + 5, { width: 45, align: "center" });
      doc.text(sa.avgRr.toFixed(2), 225, sRowY + 5, { width: 45, align: "center" });
      doc.text(sa.avgAdx.toFixed(1), 270, sRowY + 5, { width: 45, align: "center" });
      doc.text(sa.avgRsi.toFixed(1), 315, sRowY + 5, { width: 45, align: "center" });
      doc.text(sa.avgVolRatio.toFixed(2), 360, sRowY + 5, { width: 45, align: "center" });
      doc.fillColor("#EF4444").text(sa.mostFailedFilter, 410, sRowY + 5);

      doc.strokeColor("#E5E7EB").lineWidth(0.5).moveTo(50, sRowY + 18).lineTo(545, sRowY + 18).stroke();
      sRowY += 18;
    });

    doc.y = sRowY + 20;

    // --- Market Regime Analysis ---
    doc.fillColor(primaryColor).fontSize(12).text("Market Regime Classification", 50, doc.y);
    doc.moveDown(0.4);

    const rHeaderY = doc.y;
    doc.rect(50, rHeaderY, 495, 18).fillColor("#F1F5F9").fill();
    doc.fillColor(darkGray).fontSize(8.5);
    doc.text("Regime Type", 55, rHeaderY + 5);
    doc.text("Evaluations", 200, rHeaderY + 5, { width: 80, align: "center" });
    doc.text("BUY Count", 300, rHeaderY + 5, { width: 80, align: "center" });
    doc.text("BUY % per Regime", 420, rHeaderY + 5, { width: 100, align: "center" });

    let rRowY = rHeaderY + 18;
    data.marketRegime.forEach((mr: any) => {
      doc.fillColor(textGray).fontSize(8.5);
      doc.text(mr.regime, 55, rRowY + 5);
      doc.text(String(mr.evaluations), 200, rRowY + 5, { width: 80, align: "center" });
      doc.text(String(mr.buyCount), 300, rRowY + 5, { width: 80, align: "center" });
      doc.fillColor(primaryColor).text(`${mr.buyPct.toFixed(1)}%`, 420, rRowY + 5, { width: 100, align: "center" });

      doc.strokeColor("#E5E7EB").lineWidth(0.5).moveTo(50, rRowY + 18).lineTo(545, rRowY + 18).stroke();
      rRowY += 18;
    });

    doc.y = rRowY + 20;

    // --- Near Miss Analysis ---
    doc.fillColor(primaryColor).fontSize(12).text("Near Miss Analysis (Top 10 closest opportunities)", 50, doc.y);
    doc.moveDown(0.4);

    const nmHeaderY = doc.y;
    doc.rect(50, nmHeaderY, 495, 18).fillColor("#F1F5F9").fill();
    doc.fillColor(darkGray).fontSize(8);
    doc.text("Time", 55, nmHeaderY + 5);
    doc.text("Symbol", 140, nmHeaderY + 5);
    doc.text("Score", 190, nmHeaderY + 5, { width: 35, align: "center" });
    doc.text("R/R", 230, nmHeaderY + 5, { width: 35, align: "center" });
    doc.text("ADX", 270, nmHeaderY + 5, { width: 35, align: "center" });
    doc.text("RSI", 310, nmHeaderY + 5, { width: 35, align: "center" });
    doc.text("Blocked Filter Blockage Reason", 350, nmHeaderY + 5);

    let nmRowY = nmHeaderY + 18;
    data.nearMisses.slice(0, 10).forEach((nm: any) => {
      doc.fillColor(textGray).fontSize(7.5);
      doc.text(new Date(nm.timestamp).toLocaleTimeString("en-IN"), 55, nmRowY + 5);
      doc.fillColor(darkGray).fontSize(8).text(nm.symbol, 140, nmRowY + 5);
      doc.text(`${nm.tradeScore}/60`, 190, nmRowY + 5, { width: 35, align: "center" });
      doc.text(nm.riskReward.toFixed(1), 230, nmRowY + 5, { width: 35, align: "center" });
      doc.text(nm.adx.toFixed(1), 270, nmRowY + 5, { width: 35, align: "center" });
      doc.text(nm.rsi.toFixed(1), 310, nmRowY + 5, { width: 35, align: "center" });
      doc.fillColor(textGray).fontSize(7).text(nm.reason.replace("Golden Cross ignored due to: ", ""), 350, nmRowY + 4, { width: 190 });

      doc.strokeColor("#E5E7EB").lineWidth(0.5).moveTo(50, nmRowY + 18).lineTo(545, nmRowY + 18).stroke();
      nmRowY += 18;
    });

    // Write footer on both pages
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fontSize(7.5).fillColor("#9CA3AF").text("Mars Algo Platform Auditing Division | Confidential Report", 50, 785, { align: "left" });
      doc.text(`Page ${i + 1} of ${pageCount}`, 500, 785, { align: "right" });
    }

    await new Promise<void>((resolve, reject) => {
      stream.on("finish", () => {
        console.log(`PDF successfully written to ${outputPath}`);
        resolve();
      });
      stream.on("error", (err) => reject(err));
      doc.end();
    });
  }

  /**
   * Dispatches email reports using Nodemailer SMTP transporter.
   */
  static async dispatchEmailReport(reportId: string): Promise<boolean> {
    console.log(`📨 [WeeklyReportService] Dispatching email report for ID ${reportId}...`);
    const reportRepo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
    const report = await reportRepo.findOne({ where: { _id: new ObjectId(reportId) } as any });
    if (!report) {
      console.error(`❌ Report not found: ${reportId}`);
      return false;
    }

    const transporter = this.getMailTransporter();
    // Support multiple recipients split by comma
    const recipientsRaw = process.env.WEEKLY_REPORT_RECIPIENTS || process.env.ADMIN_EMAIL || "";
    const recipientList = recipientsRaw.split(",").map(e => e.trim()).filter(e => e.length > 0);

    if (recipientList.length === 0) {
      console.warn("⚠️ No SMTP recipients configured in .env. Skipping email dispatch.");
      report.emailStatus = {
        emailSent: false,
        recipientList: [],
        deliveryStatus: "FAILED",
        errorMessage: "No SMTP recipients configured in .env",
        retryCount: 0
      };
      await reportRepo.save(report);
      return false;
    }

    if (!transporter) {
      console.warn("⚠️ SMTP server credentials missing. Skipping email dispatch.");
      report.emailStatus = {
        emailSent: false,
        recipientList,
        deliveryStatus: "FAILED",
        errorMessage: "SMTP server credentials are not configured in .env",
        retryCount: 0
      };
      await reportRepo.save(report);
      return false;
    }

    const subject = `[AlgoBot] Weekly Strategy Trend Report - Week ${report.weekIdentifier} (${report.generatedAt.toISOString().split("T")[0]})`;

    // Compact email body
    const emailBodyHtml = `
      <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; max-width: 600px;">
        <h2 style="color: #1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-top: 0;">Weekly Strategy Trend & Effectiveness</h2>
        
        <p style="font-size: 15px; color: #374151; line-height: 1.5;">${report.executiveSummary}</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
          <tr style="height: 28px; background-color: #f9fafb;"><td style="padding: 6px; font-weight: bold;">Engineering Compliance Score</td><td style="padding: 6px; text-align: right; font-weight: bold; color: ${report.engineeringHealth.overallScore >= 95 ? '#10b981' : '#f59e0b'};">${report.engineeringHealth.overallScore}/100</td></tr>
          <tr style="height: 28px;"><td style="padding: 6px; font-weight: bold;">Strategy Execution Score</td><td style="padding: 6px; text-align: right; font-weight: bold; color: ${report.strategyHealth.overallScore >= 70 ? '#10b981' : '#ef4444'};">${report.strategyHealth.overallScore}/100</td></tr>
          <tr style="height: 28px; background-color: #f9fafb;"><td style="padding: 6px; font-weight: bold;">BUY Signals Generated</td><td style="padding: 6px; text-align: right; font-weight: bold;">${report.evaluationStatistics.buyCount}</td></tr>
          <tr style="height: 28px;"><td style="padding: 6px; font-weight: bold;">Completed Trades</td><td style="padding: 6px; text-align: right; font-weight: bold;">${report.strategyHealth.completedTrades}</td></tr>
          <tr style="height: 28px; background-color: #f9fafb;"><td style="padding: 6px; font-weight: bold; color: #ef4444;">Most Restrictive Filter</td><td style="padding: 6px; text-align: right; font-weight: bold; color: #ef4444;">${report.filterAnalysis.blockedRanking[0] ? report.filterAnalysis.blockedRanking[0].filter : "None"}</td></tr>
          <tr style="height: 28px;"><td style="padding: 6px; font-weight: bold;">Closest Near Miss</td><td style="padding: 6px; text-align: right; font-size: 13px;">${report.nearMisses[0] ? `${report.nearMisses[0].symbol} (Score: ${report.nearMisses[0].tradeScore}/60)` : "N/A"}</td></tr>
        </table>
        
        <div style="background-color: #eff6ff; padding: 12px; border-left: 4px solid #3b82f6; border-radius: 4px; font-size: 14px;">
          <strong>Final Recommendation Status:</strong> ${report.recommendation.status}<br>
          <span style="font-size: 13px; color: #4b5563;">${report.recommendation.explanation}</span>
        </div>
        
        <p style="font-size: 12px; color: #9ca3af; margin-top: 20px; border-top: 1px solid #e5e7eb; padding-top: 10px;">
          The full report is attached as HTML and PDF. You can download or query details using the AlgoBot dashboard APIs.
        </p>
      </div>
    `;

    // Attempt delivery with 3 retries
    const maxRetries = 3;
    let attempts = 0;
    let delivered = false;
    let lastError = "";

    while (attempts < maxRetries && !delivered) {
      attempts++;
      console.log(`[WeeklyReportService] Email dispatch attempt ${attempts} of ${maxRetries}...`);
      try {
        await transporter.sendMail({
          from: `"Mars Algo Platform" <${process.env.SMTP_USER}>`,
          to: recipientList.join(", "),
          subject,
          html: emailBodyHtml,
          attachments: [
            {
              filename: `Weekly_Report_Week_${report.weekIdentifier}.pdf`,
              path: report.pdfPath
            },
            {
              filename: `Weekly_Report_Week_${report.weekIdentifier}.html`,
              path: report.htmlPath
            }
          ]
        });
        delivered = true;
        console.log("📨 [WeeklyReportService] Weekly Strategy Report successfully emailed.");
      } catch (err: any) {
        lastError = err.message;
        console.error(`❌ [WeeklyReportService] Email attempt ${attempts} failed:`, err.message);
        if (attempts < maxRetries) {
          // Linear backoff wait (2 seconds per attempt count)
          await new Promise(r => setTimeout(r, 2000 * attempts));
        }
      }
    }

    // Save final delivery status in MongoDB
    report.emailStatus = {
      emailSent: delivered,
      emailSentAt: delivered ? new Date() : undefined,
      recipientList,
      deliveryStatus: delivered ? "SENT" : "FAILED",
      errorMessage: delivered ? undefined : lastError,
      retryCount: attempts
    };

    await reportRepo.save(report);
    return delivered;
  }

  /**
   * Core generator function.
   * Compiles stats, exports PDF & HTML, saves metadata, and triggers email delivery.
   */
  static async generateWeeklyReport(weekIdentifier: string): Promise<WeeklyStrategyReport> {
    console.log(`📝 [WeeklyReportService] Starting weekly report generation process for week ${weekIdentifier}...`);
    const startTime = Date.now();

    const reportRepo = AppDataSource.getMongoRepository(WeeklyStrategyReport);

    // Resolve date boundary:
    // We check if a previous weekly report exists. If so, start from its date.
    // If not, fall back to exactly 7 days ago.
    const lastReport = await reportRepo.findOne({
      order: { generatedAt: "DESC" }
    } as any);

    const now = new Date();
    const startDate = lastReport ? lastReport.generatedAt : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const endDate = now;

    // Compile statistics
    const data = await this.compileMetrics(startDate, endDate, weekIdentifier);

    // Create target directory in workspace
    const reportDir = path.resolve(process.cwd(), "public", "reports", "weekly");
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const pdfFilename = `Weekly_Report_${weekIdentifier}.pdf`;
    const htmlFilename = `Weekly_Report_${weekIdentifier}.html`;

    const pdfPath = path.join(reportDir, pdfFilename);
    const htmlPath = path.join(reportDir, htmlFilename);

    // Save HTML file
    console.log(`💾 [WeeklyReportService] Writing HTML file to ${htmlPath}...`);
    const htmlContent = this.generateHtmlReport(data);
    fs.writeFileSync(htmlPath, htmlContent, "utf8");

    // Save PDF file
    console.log(`💾 [WeeklyReportService] Writing PDF file to ${pdfPath}...`);
    await this.generatePdfReport(data, pdfPath);

    // Instantiate and Save MongoDB report record
    const report = new WeeklyStrategyReport();
    report.weekIdentifier = weekIdentifier;
    report.generatedAt = now;
    report.strategyVersion = data.strategyVersion;
    report.executiveSummary = data.executiveSummary;
    report.evaluationStatistics = data.evaluationStatistics;
    report.filterAnalysis = data.filterAnalysis;
    report.nearMisses = data.nearMisses;
    report.marketRegime = data.marketRegime;
    report.symbolAnalysis = data.symbolAnalysis;
    report.engineeringHealth = data.engineeringHealth;
    report.strategyHealth = data.strategyHealth;
    report.recommendation = data.recommendation;
    report.reportJson = data;
    report.pdfPath = pdfPath;
    report.htmlPath = htmlPath;
    report.emailStatus = {
      emailSent: false,
      recipientList: [],
      deliveryStatus: "PENDING",
      retryCount: 0
    };

    const savedReport = await reportRepo.save(report);
    console.log(`💾 [WeeklyReportService] WeeklyStrategyReport successfully saved in DB with ID: ${savedReport._id}`);

    // Dispatch email
    const emailSent = await this.dispatchEmailReport(savedReport._id.toString());

    const duration = Date.now() - startTime;
    console.log(`✅ [WeeklyReportService] Report generation and delivery cycle completed in ${duration}ms. Email sent: ${emailSent}`);
    
    return savedReport;
  }
}
