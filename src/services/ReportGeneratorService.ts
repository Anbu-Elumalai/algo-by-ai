import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { StrategyDecision } from "../entity/StrategyDecision";
import { ActivePosition } from "../entity/ActivePosition";
import { PriceConsistencyMonitor } from "./PriceConsistencyMonitor";

export interface EodValidationReport {
  timestamp: Date;
  summary: string;
  totalSignals: number;
  buyExecutions: number;
  sellExecutions: number;
  stopLossExits: number;
  trailingStopExits: number;
  openPositionsCount: number;
  closedPositionsCount: number;
  averageHoldTimeMinutes: number;
  priceConsistencyScore: number;
  positionIntegrityScore: number;
  tradingHealthScore: number;
  certified: boolean;
  failures: string[];
}

export class ReportGeneratorService {
  /**
   * Generates the End-Of-Day Validation Report compiling database metrics
   */
  static async generateEodReport(): Promise<EodValidationReport> {
    console.log("📊 ReportGeneratorService: Compiling EOD validation metrics...");
    const failures: string[] = [];

    const tradeRepo = AppDataSource.getRepository(TradeLog);
    const decisionRepo = AppDataSource.getRepository(StrategyDecision);
    const positionRepo = AppDataSource.getRepository(ActivePosition);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Fetch database records from today
    const trades = await tradeRepo.find({
      where: {
        createdAt: { $gte: todayStart }
      } as any
    });

    const decisions = await decisionRepo.find({
      where: {
        createdAt: { $gte: todayStart }
      } as any
    });

    const openPositions = await positionRepo.find();

    // Counts
    const totalSignals = decisions.length;
    const buyExecutions = trades.filter(t => t.action === "BUY").length;
    const sellExecutions = trades.filter(t => t.action === "SELL").length;
    
    const stopLossExits = trades.filter(
      t => t.action === "SELL" && 
      (t.signalReason.toLowerCase().includes("stop loss") || t.signalReason.toLowerCase().includes("sl")) &&
      !t.signalReason.toLowerCase().includes("trailing")
    ).length;

    const trailingStopExits = trades.filter(
      t => t.action === "SELL" && 
      t.signalReason.toLowerCase().includes("trailing stop")
    ).length;

    const closedPositionsCount = sellExecutions;
    const openPositionsCount = openPositions.length;

    // Calculate Average Hold Time
    let totalHoldTimeMs = 0;
    let holdTimeCount = 0;

    const buyTrades = trades.filter(t => t.action === "BUY");
    const sellTrades = trades.filter(t => t.action === "SELL");

    for (const sell of sellTrades) {
      // Find matching buy trade before this sell trade for the same symbol
      const matchingBuy = buyTrades
        .filter(b => b.symbol === sell.symbol && new Date(b.createdAt).getTime() < new Date(sell.createdAt).getTime())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

      if (matchingBuy) {
        const holdTime = new Date(sell.createdAt).getTime() - new Date(matchingBuy.createdAt).getTime();
        totalHoldTimeMs += holdTime;
        holdTimeCount++;
      }
    }

    const averageHoldTimeMinutes = holdTimeCount > 0 
      ? Math.round((totalHoldTimeMs / (1000 * 60)) / holdTimeCount) 
      : 0;

    // Calculate Price Consistency Score
    // Check if any price consistency monitor reports divergence > 2%
    const consistencyMetrics = PriceConsistencyMonitor.getMetrics();
    let hasPriceDivergence = false;
    let maxDivObserved = 0;

    for (const metric of consistencyMetrics) {
      if (metric.maxDivergencePercent > maxDivObserved) {
        maxDivObserved = metric.maxDivergencePercent;
      }
      if (metric.maxDivergencePercent > 2.0) {
        hasPriceDivergence = true;
        failures.push(`Price divergence of ${metric.maxDivergencePercent.toFixed(2)}% on ${metric.symbol} exceeded 2% limit.`);
      }
    }

    const priceConsistencyScore = hasPriceDivergence 
      ? Math.max(0, Math.round(100 - (maxDivObserved * 10))) 
      : 100;

    // Calculate Position Integrity Score
    let hasCorruptedPositions = false;
    let hasInvalidTrailingStops = false;
    let hasUnrealisticPeaks = false;

    for (const pos of openPositions) {
      if (pos.isInvalid) {
        hasInvalidTrailingStops = true;
        failures.push(`Active position ${pos.symbol} was flagged invalid by the validator.`);
      }
      if (pos.peakPrice > pos.avgEntryPrice * 1.5) {
        hasUnrealisticPeaks = true;
        failures.push(`Active position ${pos.symbol} has an unrealistic peak price of ₹${pos.peakPrice.toFixed(2)} vs entry ₹${pos.avgEntryPrice.toFixed(2)}.`);
      }
    }

    if (hasInvalidTrailingStops || hasUnrealisticPeaks) {
      hasCorruptedPositions = true;
    }

    const positionIntegrityScore = hasCorruptedPositions ? 50 : 100;

    // Trading Health Score
    const tradingHealthScore = Math.round((priceConsistencyScore + positionIntegrityScore) / 2);

    // Pass Criteria checks
    const certified = failures.length === 0;

    const summary = certified
      ? "PASS: Paper Trading Environment is fully certified. All safety, divergence, and position checks are green."
      : "FAIL: Paper Trading Environment is NOT certified due to active safety breaches.";

    return {
      timestamp: new Date(),
      summary,
      totalSignals,
      buyExecutions,
      sellExecutions,
      stopLossExits,
      trailingStopExits,
      openPositionsCount,
      closedPositionsCount,
      averageHoldTimeMinutes,
      priceConsistencyScore,
      positionIntegrityScore,
      tradingHealthScore,
      certified,
      failures
    };
  }
}
