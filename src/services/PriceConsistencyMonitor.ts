import { PriceEngine } from "./PriceEngine";
import { MarketDataService } from "./marketData.service";
import { UpstoxService } from "./upstox.service";
import { MarketDataReliabilityLayer } from "./MarketDataReliabilityLayer";
import { NotificationService } from "./notification.service";

export interface DivergenceMetrics {
  symbol: string;
  priceEnginePrice: number;
  simulatorPrice: number;
  restLtpPrice: number;
  divergenceEngineRestPercent: number;
  divergenceSimRestPercent: number;
  divergenceEngineSimPercent: number;
  maxDivergencePercent: number;
}

export class PriceConsistencyMonitor {
  private static checkInterval: NodeJS.Timeout | null = null;
  private static targetSymbols = ["RELIANCE", "TCS", "INFY"];
  private static latestMetrics = new Map<string, DivergenceMetrics>();

  /**
   * Starts periodic price consistency monitoring (runs every 30 seconds).
   */
  static startMonitoring(intervalMs: number = 30000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      await this.auditConsistency();
    }, intervalMs);

    console.log(`⏱️ PriceConsistencyMonitor started (every ${intervalMs / 1000}s).`);
  }

  /**
   * Stops the consistency monitoring.
   */
  static stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log("🔌 PriceConsistencyMonitor deactivated.");
    }
  }

  /**
   * Resets latest metrics cache (used for cleanups in tests)
   */
  static reset(): void {
    this.latestMetrics.clear();
  }

  /**
   * Returns dashboard metrics for price consistency audits
   */
  static getMetrics(): DivergenceMetrics[] {
    return Array.from(this.latestMetrics.values());
  }

  /**
   * Audit prices across PriceEngine, Simulator, and Upstox REST LTP
   */
  static async auditConsistency(): Promise<void> {
    console.log("🔍 Running Price Consistency Audit...");
    for (const symbol of this.targetSymbols) {
      try {
        const priceEnginePrice = PriceEngine.getLastPriceSync(symbol);
        const simulatorPrice = MarketDataService.simulatedPrices.get(symbol) || 0;
        const restLtpPrice = await UpstoxService.getLastTradedPrice(symbol);

        if (priceEnginePrice <= 0 || simulatorPrice <= 0 || restLtpPrice <= 0) {
          // Prices not initialized yet, skip checks for now
          continue;
        }

        const divEngineRest = (Math.abs(priceEnginePrice - restLtpPrice) / restLtpPrice) * 100;
        const divSimRest = (Math.abs(simulatorPrice - restLtpPrice) / restLtpPrice) * 100;
        const divEngineSim = (Math.abs(priceEnginePrice - simulatorPrice) / simulatorPrice) * 100;
        const maxDivergence = Math.max(divEngineRest, divSimRest, divEngineSim);

        const metrics: DivergenceMetrics = {
          symbol,
          priceEnginePrice,
          simulatorPrice,
          restLtpPrice,
          divergenceEngineRestPercent: divEngineRest,
          divergenceSimRestPercent: divSimRest,
          divergenceEngineSimPercent: divEngineSim,
          maxDivergencePercent: maxDivergence
        };

        this.latestMetrics.set(symbol, metrics);

        console.log(
          `📊 Price Audit for ${symbol}:\n` +
          `   - PriceEngine:  ₹${priceEnginePrice.toFixed(2)}\n` +
          `   - Simulator:    ₹${simulatorPrice.toFixed(2)}\n` +
          `   - REST LTP:     ₹${restLtpPrice.toFixed(2)}\n` +
          `   - Max Div:      ${maxDivergence.toFixed(2)}%`
        );

        if (maxDivergence > 2.0) {
          const alarmReason = `CRITICAL PRICE DIVERGENCE DETECTED on ${symbol}: Max Divergence ${maxDivergence.toFixed(2)}% ` +
            `(PriceEngine: ₹${priceEnginePrice.toFixed(2)}, Simulator: ₹${simulatorPrice.toFixed(2)}, REST LTP: ₹${restLtpPrice.toFixed(2)})`;
          
          console.error(`🚨 ${alarmReason}`);

          // Immediately pause trading
          await MarketDataReliabilityLayer.pauseTrading(alarmReason);

          // Dispatch critical alerts via Telegram & Email (handled inside NotificationService)
          await NotificationService.sendNotification(
            "CRITICAL: Price Feed Divergence Breach",
            alarmReason
          );
        }
      } catch (err: any) {
        console.error(`❌ PriceConsistencyMonitor error auditing ${symbol}:`, err.message);
      }
    }
  }
}
