import { PriceEngine } from "./PriceEngine";
import { MarketDataService } from "./marketData.service";
import { UpstoxService } from "./upstox.service";
import { MarketDataReliabilityLayer } from "./MarketDataReliabilityLayer";
import { NotificationService } from "./notification.service";
import { AppDataSource } from "../data-source";
import { FeedHealthLog } from "../entity/FeedHealthLog";

export interface DivergenceMetrics {
  symbol: string;
  priceEnginePrice: number;
  restLtpPrice: number;
  divergencePercent: number;
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
        const restLtpPrice = await UpstoxService.getLastTradedPrice(symbol);

        if (priceEnginePrice <= 0 || restLtpPrice <= 0) {
          // Prices not initialized yet, skip checks for now
          continue;
        }

        const divergence = (Math.abs(priceEnginePrice - restLtpPrice) / restLtpPrice) * 100;

        const metrics: DivergenceMetrics = {
          symbol,
          priceEnginePrice,
          restLtpPrice,
          divergencePercent: divergence,
          maxDivergencePercent: divergence
        };

        this.latestMetrics.set(symbol, metrics);

        console.log(
          `📊 Price Audit for ${symbol}:\n` +
          `   - PriceEngine:  ₹${priceEnginePrice.toFixed(2)}\n` +
          `   - REST LTP:     ₹${restLtpPrice.toFixed(2)}\n` +
          `   - Divergence:   ${divergence.toFixed(2)}%`
        );

        // 1. Log metrics to MongoDB FeedHealthLog
        try {
          if (AppDataSource.isInitialized) {
            const feedHealthRepo = AppDataSource.getRepository(FeedHealthLog);
            const log = new FeedHealthLog();
            log.symbol = symbol;
            log.wsPrice = priceEnginePrice;
            log.restPrice = restLtpPrice;
            log.divergence = divergence;
            await feedHealthRepo.save(log);
          }
        } catch (dbErr: any) {
          console.error(`❌ Failed to save FeedHealthLog for ${symbol}:`, dbErr.message);
        }

        // 2. Alert / Action Rules
        if (divergence > 3.0) {
          const alarmReason = `CRITICAL PRICE DIVERGENCE PAUSE on ${symbol}: Divergence ${divergence.toFixed(2)}% ` +
            `(PriceEngine: ₹${priceEnginePrice.toFixed(2)}, REST LTP: ₹${restLtpPrice.toFixed(2)})`;
          
          console.error(`🚨 ${alarmReason}`);

          // Immediately pause trading
          await MarketDataReliabilityLayer.pauseTrading(alarmReason);
        } else if (divergence > 2.0) {
          const alarmReason = `CRITICAL PRICE DIVERGENCE DETECTED on ${symbol}: Divergence ${divergence.toFixed(2)}% ` +
            `(PriceEngine: ₹${priceEnginePrice.toFixed(2)}, REST LTP: ₹${restLtpPrice.toFixed(2)})`;
          
          console.error(`🚨 ${alarmReason}`);

          // Dispatch critical alerts via Telegram & Email (handled inside NotificationService)
          await NotificationService.sendNotification(
            "CRITICAL: Price Feed Divergence Breach",
            alarmReason
          );
        } else if (divergence > 1.0) {
          console.warn(
            `⚠️ Warning: Price divergence for ${symbol} is ${divergence.toFixed(2)}% ` +
            `(PriceEngine: ₹${priceEnginePrice.toFixed(2)}, REST LTP: ₹${restLtpPrice.toFixed(2)})`
          );
        }
      } catch (err: any) {
        console.error(`❌ PriceConsistencyMonitor error auditing ${symbol}:`, err.message);
      }
    }
  }
}
