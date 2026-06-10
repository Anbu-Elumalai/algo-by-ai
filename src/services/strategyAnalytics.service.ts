import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { StrategyMetrics } from "../entity/StrategyMetrics";

export class StrategyAnalyticsService {
  /**
   * Recalculates and updates strategy analytics metrics for a stock
   */
  static async calculateMetrics(symbol: string): Promise<StrategyMetrics> {
    const sym = symbol.toUpperCase();
    const tradeRepo = AppDataSource.getRepository(TradeLog);
    const metricsRepo = AppDataSource.getRepository(StrategyMetrics);

    const logs = await tradeRepo.find({
      where: { symbol: sym } as any,
      order: { createdAt: "ASC" } as any
    });

    const tradesPL: number[] = [];
    const tradeReturns: number[] = [];
    const negativeReturns: number[] = [];

    let activeBuyPrice = 0;
    let activeBuyQty = 0;

    for (const log of logs) {
      if (log.action === "BUY") {
        activeBuyPrice = log.price;
        activeBuyQty = log.qty;
      } else if (log.action === "SELL" && activeBuyQty > 0) {
        const cost = activeBuyPrice * activeBuyQty;
        const revenue = log.price * activeBuyQty;
        const fees = log.transactionFees || 40; // Default ₹40 fallback
        const pl = revenue - cost - fees;

        tradesPL.push(pl);
        const returnRate = pl / cost;
        tradeReturns.push(returnRate);

        if (pl < 0) {
          negativeReturns.push(returnRate);
        }

        activeBuyPrice = 0;
        activeBuyQty = 0;
      }
    }

    const totalTrades = tradesPL.length;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    tradesPL.forEach(pl => {
      if (pl > 0) {
        wins++;
        grossProfit += pl;
      } else {
        losses++;
        grossLoss += Math.abs(pl);
      }
    });

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const lossRate = totalTrades > 0 ? (losses / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

    const avgWin = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    const expectancy = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;

    // Sharpe Ratio calculation
    let sharpe = 0;
    if (tradeReturns.length > 0) {
      const avgReturn = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
      const variance = tradeReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / tradeReturns.length;
      const stdDev = Math.sqrt(variance);
      sharpe = stdDev > 0 ? avgReturn / stdDev : 0;
    }

    // Sortino Ratio calculation
    let sortino = 0;
    if (tradeReturns.length > 0) {
      const avgReturn = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
      const downsideVariance = negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / tradeReturns.length;
      const downsideStdDev = Math.sqrt(downsideVariance);
      sortino = downsideStdDev > 0 ? avgReturn / downsideStdDev : 0;
    }

    // Maximum Drawdown calculation
    let balance = 100000;
    let peak = balance;
    let maxDD = 0;

    tradesPL.forEach(pl => {
      balance += pl;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak;
      if (dd > maxDD) maxDD = dd;
    });

    const totalReturnRate = tradeReturns.reduce((a, b) => a + b, 0);
    const annualizedReturn = totalTrades > 0 ? totalReturnRate * (252 / totalTrades) * 100 : 0;

    let metrics = await metricsRepo.findOne({ where: { symbol: sym } as any });
    if (!metrics) {
      metrics = new StrategyMetrics();
      metrics.symbol = sym;
    }

    metrics.totalTrades = totalTrades;
    metrics.winRatePercent = winRate;
    metrics.lossRatePercent = lossRate;
    metrics.profitFactor = profitFactor;
    metrics.sharpeRatio = sharpe;
    metrics.sortinoRatio = sortino;
    metrics.maxDrawdownPercent = maxDD * 100;
    metrics.avgWin = avgWin;
    metrics.avgLoss = avgLoss;
    metrics.expectancy = expectancy;
    metrics.annualizedReturnPercent = annualizedReturn;

    await metricsRepo.save(metrics);
    console.log(`📊 Analytics refreshed for ${sym} | Win Rate: ${winRate.toFixed(2)}% | Profit Factor: ${profitFactor.toFixed(2)}`);

    return metrics;
  }
}
