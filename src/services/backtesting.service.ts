import { UpstoxService, UpstoxBar } from "./upstox.service";
import { analyzeMovingAverageCrossover } from "../strategies/movingAverageCrossover";
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
  trades: BacktestTrade[];
}

export class BacktestingService {
  /**
   * Helper to calculate realistic Upstox Intraday transaction charges in INR
   * Covers: flat ₹20 brokerage, STT (0.025% on sell), GST, SEBI Turnover fees, Stamp Duty (~0.05% combined)
   */
  private static calculateFees(amount: number, side: "BUY" | "SELL"): number {
    const flatBrokerage = 20; // Upstox Intraday flat ₹20 brokerage
    
    // Govt taxes & transaction charges average to about 0.03% on buy, 0.05% on sell (STT included)
    const taxRate = side === "SELL" ? 0.0005 : 0.0003; 
    const taxes = amount * taxRate;
    
    return flatBrokerage + taxes;
  }

  /**
   * Run a historical backtest of the SMA crossover strategy on Indian stocks
   * @param symbol Indian stock ticker (e.g. RELIANCE, TCS)
   * @param days Number of days of historical data (default 60)
   * @param initialBalance Starting cash in INR (default ₹100,000)
   */
  static async runBacktest(
    symbol: string,
    days: number = 60,
    initialBalance: number = 100000
  ): Promise<BacktestReport> {
    console.log(`📊 Starting Upstox historical backtest for ${symbol.toUpperCase()} over ${days} days...`);
    
    // Fetch historical daily bars
    const bars = await UpstoxService.getHistoricalBars(symbol, days, "day");
    
    if (bars.length === 0) {
      throw new Error(`No historical bar data returned for ${symbol} via Upstox API.`);
    }

    console.log(`📈 Downloaded ${bars.length} historical daily candles for backtesting.`);

    let cash = initialBalance;
    let sharesHeld = 0;
    let entryPrice = 0;
    let highestPrice = 0; // Tracks the peak price reached while holding stock
    let totalFeesPaid = 0;
    
    let wins = 0;
    let losses = 0;
    const trades: BacktestTrade[] = [];

    // Store a running array of closing prices to pass to our strategy
    const closingPrices: number[] = [];

    // Loop through the historical bars
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      closingPrices.push(bar.c);

      const currentPortfolioValue = cash + (sharesHeld * bar.c);

      // --- Trailing Stop Loss Check ---
      if (sharesHeld > 0) {
        // Track the highest price (peak) reached since we opened the position
        if (bar.c > highestPrice) {
          highestPrice = bar.c;
        }

        // Trigger if the price drops 2% or more below the highest peak price reached
        const dropPercent = (highestPrice - bar.c) / highestPrice;
        const stopLossThreshold = 0.02; // 2% trailing stop loss

        if (dropPercent >= stopLossThreshold) {
          // Trigger automatic stop-loss sell
          const totalAmount = sharesHeld * bar.c;
          const fees = this.calculateFees(totalAmount, "SELL");
          
          cash += (totalAmount - fees);
          totalFeesPaid += fees;

          const tradePL = totalAmount - (sharesHeld * entryPrice) - fees;
          if (tradePL > 0) wins++;
          else losses++;

          trades.push({
            timestamp: bar.t,
            action: "SELL",
            price: bar.c,
            qty: sharesHeld,
            total: totalAmount,
            reason: `TRAILING STOP LOSS TRIGGERED! Position dropped by ${(dropPercent * 100).toFixed(2)}% from peak of ₹${highestPrice.toFixed(2)} (Entry: ₹${entryPrice.toFixed(2)}) [Fees Paid: ₹${fees.toFixed(2)}]`,
            portfolioValue: cash,
          });

          sharesHeld = 0;
          entryPrice = 0;
          highestPrice = 0;
          continue; // skip other logic for this bar
        }
      }

      // --- Strategy Decision ---
      // We only run strategy calculations if we have enough closing prices
      const analysis = analyzeMovingAverageCrossover(closingPrices, 9, 21);

      // Buy Trigger
      if (analysis.signal === "BUY" && sharesHeld === 0) {
        // Calculate dynamic position size based on 5% allocation limit
        const qty = RiskService.calculatePositionSize(currentPortfolioValue, bar.c, 0.05);

        if (qty > 0) {
          const totalCost = qty * bar.c;
          const fees = this.calculateFees(totalCost, "BUY");

          if (cash >= (totalCost + fees)) {
            cash -= (totalCost + fees);
            totalFeesPaid += fees;
            sharesHeld = qty;
            entryPrice = bar.c;
            highestPrice = bar.c; // Initialize highest price at entry cost

            trades.push({
              timestamp: bar.t,
              action: "BUY",
              price: bar.c,
              qty: sharesHeld,
              total: totalCost,
              reason: `${analysis.reason} [Fees Paid: ₹${fees.toFixed(2)}]`,
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
        if (tradePL > 0) wins++;
        else losses++;

        trades.push({
          timestamp: bar.t,
          action: "SELL",
          price: bar.c,
          qty: sharesHeld,
          total: totalAmount,
          reason: `${analysis.reason} [Fees Paid: ₹${fees.toFixed(2)}]`,
          portfolioValue: cash,
        });

        sharesHeld = 0;
        entryPrice = 0;
      }
    }

    // Force liquidate remaining holdings at the final price to calculate absolute ending balance
    if (sharesHeld > 0) {
      const finalBar = bars[bars.length - 1];
      const totalAmount = sharesHeld * finalBar.c;
      const fees = this.calculateFees(totalAmount, "SELL");

      cash += (totalAmount - fees);
      totalFeesPaid += fees;

      const tradePL = totalAmount - (sharesHeld * entryPrice) - fees;
      if (tradePL > 0) wins++;
      else losses++;

      trades.push({
        timestamp: finalBar.t,
        action: "SELL",
        price: finalBar.c,
        qty: sharesHeld,
        total: totalAmount,
        reason: `Backtest ended. Position liquidated at market close. [Fees Paid: ₹${fees.toFixed(2)}]`,
        portfolioValue: cash,
      });

      sharesHeld = 0;
      entryPrice = 0;
    }

    const finalBalance = cash;
    const totalReturnPercent = ((finalBalance - initialBalance) / initialBalance) * 100;
    const totalTrades = trades.length;
    const winRatePercent = totalTrades > 0 ? (wins / (totalTrades / 2)) * 100 : 0; // Each completed trade consists of a buy & sell

    console.log(`✅ Backtest completed. Final Balance: ₹${finalBalance.toFixed(2)} (${totalReturnPercent.toFixed(2)}% Return) | Total Fees: ₹${totalFeesPaid.toFixed(2)}`);

    return {
      symbol: symbol.toUpperCase(),
      initialBalance,
      finalBalance,
      totalReturnPercent,
      totalTrades,
      wins,
      losses,
      winRatePercent: Math.min(winRatePercent, 100), // Cap at 100
      totalFeesPaid,
      trades,
    };
  }
}
