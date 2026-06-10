import { CandleService } from "./candle.service";
import { analyzeMovingAverageCrossover } from "../strategies/strategyEngine";
import { RiskService } from "./risk.service";

interface BacktestTrade {
  timestamp: string;
  action: "BUY" | "SELL";
  price: number;
  qty: number;
  total: number;
  reason: string;
  portfolioValue: number;
}

export interface BacktestReport {
  symbol: string;
  initialBalance: number;
  finalBalance: number;
  totalReturnPercent: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  totalFeesPaid: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
}

export class BacktestingService {
  /**
   * Calculate realistic transaction fees (Upstox flat Rs 20 + Govt taxes)
   */
  private static calculateFees(amount: number, side: "BUY" | "SELL"): number {
    const flatBrokerage = 20;
    const taxRate = side === "SELL" ? 0.0005 : 0.0003;
    const taxes = amount * taxRate;
    return flatBrokerage + taxes;
  }

  /**
   * Run historical backtest of the strategy on 15-minute bars
   */
  static async runBacktest(
    symbol: string,
    days: number = 10,
    initialBalance: number = 100000
  ): Promise<BacktestReport> {
    console.log(`📊 Running 15-minute candle historical backtest for ${symbol.toUpperCase()} over ${days} days...`);

    // Fetch historical candles via CandleService
    const bars = await CandleService.getSyncedCandles(symbol, days);

    if (bars.length === 0) {
      throw new Error(`No historical candle data found for ${symbol}.`);
    }

    console.log(`📈 Loaded ${bars.length} validated 15-minute candles for backtesting.`);

    let cash = initialBalance;
    let sharesHeld = 0;
    let entryPrice = 0;
    let highestPrice = 0; // Peak price reached for trailing stop-loss
    let totalFeesPaid = 0;

    let wins = 0;
    let losses = 0;
    const trades: BacktestTrade[] = [];
    const closingPrices: number[] = [];

    // Performance tracking variables
    let peakPortfolioValue = initialBalance;
    let maxDrawdown = 0;
    const tradeReturns: number[] = [];

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      closingPrices.push(bar.c);

      const currentPortfolioValue = cash + (sharesHeld * bar.c);
      if (currentPortfolioValue > peakPortfolioValue) {
        peakPortfolioValue = currentPortfolioValue;
      }

      // Drawdown calculation
      const currentDrawdown = (peakPortfolioValue - currentPortfolioValue) / peakPortfolioValue;
      if (currentDrawdown > maxDrawdown) {
        maxDrawdown = currentDrawdown;
      }

      // --- Unified Trailing Stop Loss Check ---
      if (sharesHeld > 0) {
        if (bar.c > highestPrice) {
          highestPrice = bar.c;
        }

        const trailingStopPrice = highestPrice * 0.98; // 2% Trailing SL

        if (bar.c <= trailingStopPrice) {
          const totalAmount = sharesHeld * bar.c;
          const fees = this.calculateFees(totalAmount, "SELL");

          cash += (totalAmount - fees);
          totalFeesPaid += fees;

          const tradePL = totalAmount - (sharesHeld * entryPrice) - fees;
          const tradeReturn = tradePL / (sharesHeld * entryPrice);
          tradeReturns.push(tradeReturn);

          if (tradePL > 0) wins++;
          else losses++;

          trades.push({
            timestamp: bar.t,
            action: "SELL",
            price: bar.c,
            qty: sharesHeld,
            total: totalAmount,
            reason: `TRAILING STOP LOSS TRIGGERED! Price ₹${bar.c.toFixed(2)} dropped below SL threshold ₹${trailingStopPrice.toFixed(2)} (Peak: ₹${highestPrice.toFixed(2)})`,
            portfolioValue: cash,
          });

          sharesHeld = 0;
          entryPrice = 0;
          highestPrice = 0;
          continue;
        }
      }

      // --- Shared Strategy Engine Decision ---
      const analysis = analyzeMovingAverageCrossover(closingPrices, 9, 21);

      // Buy Trigger
      if (analysis.signal === "BUY" && sharesHeld === 0) {
        const qty = RiskService.calculatePositionSize(currentPortfolioValue, bar.c, 0.02);

        if (qty > 0) {
          const totalCost = qty * bar.c;
          const fees = this.calculateFees(totalCost, "BUY");

          if (cash >= (totalCost + fees)) {
            cash -= (totalCost + fees);
            totalFeesPaid += fees;
            sharesHeld = qty;
            entryPrice = bar.c;
            highestPrice = bar.c;

            trades.push({
              timestamp: bar.t,
              action: "BUY",
              price: bar.c,
              qty: sharesHeld,
              total: totalCost,
              reason: `${analysis.reason} [Fees: ₹${fees.toFixed(2)}]`,
              portfolioValue: cash + (sharesHeld * bar.c),
            });
          }
        }
      }

      // Sell Trigger
      else if (analysis.signal === "SELL" && sharesHeld > 0) {
        const totalAmount = sharesHeld * bar.c;
        const fees = this.calculateFees(totalAmount, "SELL");

        cash += (totalAmount - fees);
        totalFeesPaid += fees;

        const tradePL = totalAmount - (sharesHeld * entryPrice) - fees;
        const tradeReturn = tradePL / (sharesHeld * entryPrice);
        tradeReturns.push(tradeReturn);

        if (tradePL > 0) wins++;
        else losses++;

        trades.push({
          timestamp: bar.t,
          action: "SELL",
          price: bar.c,
          qty: sharesHeld,
          total: totalAmount,
          reason: `${analysis.reason} [Fees: ₹${fees.toFixed(2)}]`,
          portfolioValue: cash,
        });

        sharesHeld = 0;
        entryPrice = 0;
      }
    }

    // Force liquidate remaining holdings at the final price at backtest termination
    if (sharesHeld > 0) {
      const finalBar = bars[bars.length - 1];
      const totalAmount = sharesHeld * finalBar.c;
      const fees = this.calculateFees(totalAmount, "SELL");

      cash += (totalAmount - fees);
      totalFeesPaid += fees;

      const tradePL = totalAmount - (sharesHeld * entryPrice) - fees;
      const tradeReturn = tradePL / (sharesHeld * entryPrice);
      tradeReturns.push(tradeReturn);

      if (tradePL > 0) wins++;
      else losses++;

      trades.push({
        timestamp: finalBar.t,
        action: "SELL",
        price: finalBar.c,
        qty: sharesHeld,
        total: totalAmount,
        reason: "Backtest period ended. Liquidated remaining position at closing price.",
        portfolioValue: cash,
      });

      sharesHeld = 0;
      entryPrice = 0;
    }

    const finalBalance = cash;
    const totalReturnPercent = ((finalBalance - initialBalance) / initialBalance) * 100;
    const totalTrades = trades.length;
    const completedTrades = totalTrades / 2;
    const winRatePercent = completedTrades > 0 ? (wins / completedTrades) * 100 : 0;

    // Calculate Sharpe Ratio (simplified trade-level Sharpe)
    let sharpeRatio = 0;
    if (tradeReturns.length > 0) {
      const avgReturn = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
      const variance = tradeReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / tradeReturns.length;
      const stdDev = Math.sqrt(variance);
      // Sharpe Ratio = (Avg Return - Risk Free Rate (assumed 0 here)) / StdDev
      sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    }

    console.log(
      "✅ Backtest completed.\n" +
      `   Final Balance: ₹${finalBalance.toFixed(2)} (${totalReturnPercent.toFixed(2)}% Return)\n` +
      `   Max Drawdown: ${(maxDrawdown * 100).toFixed(2)}% | Sharpe Ratio: ${sharpeRatio.toFixed(2)}`
    );

    return {
      symbol: symbol.toUpperCase(),
      initialBalance,
      finalBalance,
      totalReturnPercent,
      totalTrades,
      wins,
      losses,
      winRatePercent: Math.min(winRatePercent, 100),
      totalFeesPaid,
      maxDrawdownPercent: maxDrawdown * 100,
      sharpeRatio,
      trades,
    };
  }
}
