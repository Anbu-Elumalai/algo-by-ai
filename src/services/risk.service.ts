import { AppDataSource } from "../data-source";
import { DailyRiskTracker } from "../entity/DailyRiskTracker";
import { ActivePosition } from "../entity/ActivePosition";

export class RiskService {
  private static MAX_DAILY_LOSS_PERCENT = 0.03; // 3% Max Daily Drawdown
  private static MAX_TRADES_PER_DAY = 10;
  private static RISK_PER_TRADE_PERCENT = 0.01; // Risk 1% of total equity on the stop-loss
  private static MAX_ALLOCATION_PERCENT = 0.10; // Max 10% capital allocation per trade

  /**
   * Fetch or initialize the daily risk tracking record for today
   */
  static async getDailyTracker(startingEquity: number): Promise<DailyRiskTracker> {
    const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const repo = AppDataSource.getRepository(DailyRiskTracker);

    let tracker = await repo.findOne({ where: { date: todayStr } as any });
    if (!tracker) {
      tracker = new DailyRiskTracker();
      tracker.date = todayStr;
      tracker.startingEquity = startingEquity;
      tracker.currentEquity = startingEquity;
      tracker.tradeCount = 0;
      tracker.isHalted = false;
      await repo.save(tracker);
      console.log(`🛡️ Initialized new DailyRiskTracker for ${todayStr}. Starting equity: ₹${startingEquity.toFixed(2)}`);
    } else if (tracker.startingEquity <= 0 && startingEquity > 0) {
      tracker.startingEquity = startingEquity;
      tracker.currentEquity = startingEquity;
      await repo.save(tracker);
      console.log(`🏥 DailyRiskTracker starting equity healed from zero to current equity: ₹${startingEquity.toFixed(2)}`);
    }
    return tracker;
  }

  /**
   * Checks if daily trading limits (loss limit or trade count) have been breached
   */
  static async checkDailyLimits(currentEquity: number): Promise<boolean> {
    const todayStr = new Date().toISOString().split("T")[0];
    const repo = AppDataSource.getRepository(DailyRiskTracker);

    let tracker = await repo.findOne({ where: { date: todayStr } as any });
    if (!tracker) {
      tracker = await this.getDailyTracker(currentEquity);
    }

    // Calculate current loss relative to starting equity of the day
    const lossAmount = tracker.startingEquity - currentEquity;
    const lossPercent = lossAmount / tracker.startingEquity;

    let breachReason = "";
    if (tracker.isHalted) {
      breachReason = "Trading is already halted for today.";
    } else if (lossPercent >= this.MAX_DAILY_LOSS_PERCENT) {
      breachReason = `Daily loss limit breached: Drop of ${(lossPercent * 100).toFixed(2)}% exceeded max daily threshold of ${(this.MAX_DAILY_LOSS_PERCENT * 100).toFixed(2)}%.`;
      tracker.isHalted = true;
    } else if (tracker.tradeCount >= this.MAX_TRADES_PER_DAY) {
      breachReason = `Max daily trades limit reached: ${tracker.tradeCount} trades executed. Maximum is ${this.MAX_TRADES_PER_DAY}.`;
      tracker.isHalted = true;
    }

    // Update current equity
    tracker.currentEquity = currentEquity;
    await repo.save(tracker);

    if (tracker.isHalted) {
      console.warn(`🚨 RISK BREACH HALT: ${breachReason}`);
      return false; // Risk limit breached, halt execution
    }

    return true; // Limits are clear
  }

  /**
   * Log a trade to the daily risk count
   */
  static async incrementDailyTradeCount(): Promise<void> {
    const todayStr = new Date().toISOString().split("T")[0];
    const repo = AppDataSource.getRepository(DailyRiskTracker);

    const tracker = await repo.findOne({ where: { date: todayStr } as any });
    if (tracker) {
      tracker.tradeCount += 1;
      await repo.save(tracker);
      console.log(`📈 Daily trade count incremented: ${tracker.tradeCount}/${this.MAX_TRADES_PER_DAY}`);
    }
  }

  /**
   * Dynamically calculates position size using both Risk and Capital constraints:
   * 1. Capital Limit: Do not allocate more than 10% of portfolio value.
   * 2. Risk Limit: Stop-loss (e.g. 2%) must represent at most 1% total portfolio risk.
   */
  static calculatePositionSize(
    accountEquity: number,
    currentPrice: number,
    stopLossPercent: number = 0.02
  ): number {
    if (accountEquity <= 0 || currentPrice <= 0) {
      return 0;
    }

    // Constraint 1: Maximum capital allocation (10%)
    const maxCapitalAllocation = accountEquity * this.MAX_ALLOCATION_PERCENT;
    const qtyCapitalLimit = Math.floor(maxCapitalAllocation / currentPrice);

    // Constraint 2: Risk limit (Risk 1% of total equity on the stop-loss)
    const maxCapitalAtRisk = accountEquity * this.RISK_PER_TRADE_PERCENT;
    const riskPerShare = currentPrice * stopLossPercent;
    const qtyRiskLimit = Math.floor(maxCapitalAtRisk / riskPerShare);

    // Final Qty is the minimum of the two constraints
    const qty = Math.min(qtyCapitalLimit, qtyRiskLimit);

    console.log(
      "🛡️ Position Sizing Assessment:\n" +
      `   Account Equity: ₹${accountEquity.toFixed(2)}\n` +
      `   Capital Constraint (10%): Max allocation ₹${maxCapitalAllocation.toFixed(2)} => ${qtyCapitalLimit} shares\n` +
      `   Risk Constraint (1% risk on ${stopLossPercent * 100}% SL): Max Risk ₹${maxCapitalAtRisk.toFixed(2)} => ${qtyRiskLimit} shares\n` +
      `   Selected Quantity: ${qty} shares`
    );

    return qty;
  }

  /**
   * Evaluates the trailing stop loss for an active position, updating the peak price dynamically.
   */
  static checkTrailingStopLoss(
    position: ActivePosition,
    currentPrice: number
  ): { trigger: boolean; updatedPeak: number; trailingStop: number } {
    let trigger = false;
    let updatedPeak = position.peakPrice;
    let trailingStop = position.trailingStopPrice;

    // Initialize peak if not set
    if (updatedPeak <= 0) {
      updatedPeak = position.avgEntryPrice;
      trailingStop = updatedPeak * (1 - position.stopLossPercent);
    }

    // If current price is higher than the previous peak, trail the stop upward
    if (currentPrice > updatedPeak) {
      updatedPeak = currentPrice;
      trailingStop = currentPrice * (1 - position.stopLossPercent);
      console.log(`📈 Trailing Stop Updated for ${position.symbol}: New Peak ₹${updatedPeak.toFixed(2)} | Stop price ₹${trailingStop.toFixed(2)}`);
    }

    // Trigger if price breaks the trailing stop threshold
    if (currentPrice <= trailingStop) {
      trigger = true;
      console.log(
        `🚨 TRAILING STOP LOSS TRIGGERED for ${position.symbol}: Price ₹${currentPrice.toFixed(2)} ` +
        `dropped below stop-loss threshold of ₹${trailingStop.toFixed(2)} (Peak: ₹${updatedPeak.toFixed(2)})`
      );
    }

    return { trigger, updatedPeak, trailingStop };
  }
}
