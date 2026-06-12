import { PriceEngine } from "./PriceEngine";
import { marketDataService } from "./marketData.service";
import { NotificationService } from "./notification.service";

export class MarketDataReliabilityLayer {
  private static tradingPaused = false;
  private static monitorInterval: NodeJS.Timeout | null = null;
  private static targetSymbols = ["RELIANCE", "TCS", "INFY"];

  static isTradingPaused(): boolean {
    return this.tradingPaused;
  }

  static initialize(symbols: string[] = ["RELIANCE", "TCS", "INFY"]): void {
    this.targetSymbols = symbols;

    // Subscribe to simulator/websocket critical errors
    marketDataService.on("criticalError", async (reason: string) => {
      if (!this.tradingPaused) {
        await this.pauseTrading(reason);
      }
    });

    if (this.monitorInterval) return;

    console.log("🛡️ Market Data Reliability Layer Initialized. Monitoring feeds...");

    this.monitorInterval = setInterval(async () => {
      await this.auditFeedReliability();
    }, 10000); // Check reliability every 10 seconds
  }

  static stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      console.log("🔌 Market Data Reliability Layer deactivated.");
    }
  }

  static reset(): void {
    this.tradingPaused = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  private static async auditFeedReliability(): Promise<void> {
    let hasIssues = false;
    let issueReason = "";

    for (const symbol of this.targetSymbols) {
      try {
        const health = await PriceEngine.getPriceHealth(symbol);
        
        // 1. Check for stale feed (stale if > 5s delay)
        if (health.stale) {
          hasIssues = true;
          issueReason = `Stale price feed for ${symbol} (delay: ${(health.lastTickAgeMs / 1000).toFixed(1)}s)`;
          break;
        }

        // 2. Check for feed divergence (> 1%)
        if (health.feedDivergencePercent > 1.0) {
          hasIssues = true;
          issueReason = `High feed divergence for ${symbol} (${health.feedDivergencePercent.toFixed(2)}% vs REST API)`;
          break;
        }
      } catch (err: any) {
        // Suppress individual errors during background check
      }
    }

    if (hasIssues && !this.tradingPaused) {
      await this.pauseTrading(issueReason);
    } else if (!hasIssues && this.tradingPaused) {
      await this.resumeTrading();
    }
  }

  public static async pauseTrading(reason: string): Promise<void> {
    this.tradingPaused = true;
    console.error(`🚨 [CRITICAL FEED FAILURE] Pausing trading due to: ${reason}`);
    
    await NotificationService.sendNotification(
      "TRADING PAUSED",
      `Trading operations have been paused automatically: ${reason}. Triggering WebSocket reconnection...`
    );

    // Trigger reconnection
    try {
      if (marketDataService.getMode() === "LIVE") {
        await marketDataService.connect();
      }
    } catch (err: any) {
      console.error("❌ Failed to trigger WebSocket reconnect:", err.message);
    }
  }

  private static async resumeTrading(): Promise<void> {
    this.tradingPaused = false;
    console.log("💚 Price feeds stabilized. Resuming trading operations.");
    
    await NotificationService.sendNotification(
      "TRADING RESUMED",
      "WebSocket feed stability has been re-established. Trading operations resumed."
    );
  }
}
