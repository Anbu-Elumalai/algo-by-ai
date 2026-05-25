import { UpstoxPosition } from "./upstox.service";

export class RiskService {
  /**
   * Dynamically calculates how many shares we can buy without risking too much capital
   * @param accountEquity Total value of our account (cash + assets)
   * @param currentPrice Current market price of the stock (INR)
   * @param maxPortfolioRiskPercent Max percentage of our overall account to allocate to this trade (default 5% or 0.05)
   */
  static calculatePositionSize(
    accountEquity: number,
    currentPrice: number,
    maxPortfolioRiskPercent: number = 0.05
  ): number {
    if (accountEquity <= 0 || currentPrice <= 0) {
      return 0;
    }
    
    // Total capital we are allowed to spend on this single trade
    const maxCapitalAllocation = accountEquity * maxPortfolioRiskPercent;
    
    // Calculate shares. We use Math.floor to round down to the nearest whole share.
    const qty = Math.floor(maxCapitalAllocation / currentPrice);
    
    console.log(
      `🛡️ Risk Assessment: Account Equity = ₹${accountEquity.toFixed(2)}, ` +
      `Max Allocation per trade (5%) = ₹${maxCapitalAllocation.toFixed(2)}, ` +
      `Current Price = ₹${currentPrice.toFixed(2)} => Target Qty = ${qty} shares.`
    );
    
    return qty;
  }

  /**
   * Checks if an open position has breached our stop-loss threshold
   * @param position Active UpstoxPosition object
   * @param stopLossPercent Maximum allowed loss percentage (default 2% or 0.02)
   */
  static shouldTriggerStopLoss(
    position: UpstoxPosition,
    stopLossPercent: number = 0.02
  ): { trigger: boolean; currentLossPercent: number } {
    const entryPrice = position.avgEntryPrice;
    const currentPrice = position.currentPrice;

    if (entryPrice <= 0 || currentPrice <= 0) {
      return { trigger: false, currentLossPercent: 0 };
    }

    // Loss = (Entry Price - Current Price) / Entry Price
    const currentLossPercent = (entryPrice - currentPrice) / entryPrice;

    if (currentLossPercent >= stopLossPercent) {
      console.log(
        `🚨 STOP LOSS WARNING: ${position.symbol} has dropped by ` +
        `${(currentLossPercent * 100).toFixed(2)}% from entry price of ₹${entryPrice.toFixed(2)}. ` +
        `Threshold is ${(stopLossPercent * 100).toFixed(2)}%.`
      );
      return { trigger: true, currentLossPercent };
    }

    return { trigger: false, currentLossPercent };
  }
}
