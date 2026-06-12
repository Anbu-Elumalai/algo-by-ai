import { marketDataService } from "./marketData.service";
import { UpstoxService } from "./upstox.service";
import { EventEmitter } from "events";

export interface PriceHealthStatus {
  stale: boolean;
  lastTickAgeMs: number;
  feedDivergencePercent: number;
  lagMs: number;
}

export class PriceEngine {
  private static prices = new Map<string, number>();
  private static lastTickTimes = new Map<string, number>();
  private static emitter = new EventEmitter();
  private static isInitialized = false;

  private static STALE_THRESHOLD_MS = 5000; // 5 seconds stale limit
  private static DIVERGENCE_CHECK_INTERVAL = 30000; // Check every 30 seconds

  static initialize(): void {
    if (this.isInitialized) return;
    
    console.log("⚡ Centralized Price Engine Initializing...");
    
    // Subscribe to WebSocket price ticks
    marketDataService.on("priceUpdate", ({ symbol, ltp }) => {
      const sym = symbol.toUpperCase();
      this.prices.set(sym, ltp);
      this.lastTickTimes.set(sym, Date.now());
      this.emitter.emit("priceUpdate", { symbol: sym, ltp });
    });

    // Start background price health and divergence monitor
    setInterval(async () => {
      await this.runDivergenceAudit();
    }, this.DIVERGENCE_CHECK_INTERVAL);

    this.isInitialized = true;
    console.log("✅ Centralized Price Engine Ready.");
  }

  static on(event: string, listener: (data: { symbol: string; ltp: number }) => void): void {
    this.initialize();
    this.emitter.on(event, listener);
  }

  static removeAllListeners(event: string): void {
    this.emitter.removeAllListeners(event);
  }

  /**
   * Centralized method to query current asset price
   */
  static async getLastPrice(symbol: string): Promise<number> {
    this.initialize();
    const sym = symbol.toUpperCase();
    const now = Date.now();
    const ltp = this.prices.get(sym);
    const lastTickTime = this.lastTickTimes.get(sym) || 0;

    // Check if cache is missing or stale
    if (ltp === undefined || (now - lastTickTime > this.STALE_THRESHOLD_MS)) {
      console.warn(`⚠️ Price cache for ${sym} is stale or empty. Triggering failover REST API query...`);
      try {
        const freshLtp = await UpstoxService.getLastTradedPrice(sym);
        if (freshLtp > 0) {
          this.prices.set(sym, freshLtp);
          this.lastTickTimes.set(sym, Date.now());
          return freshLtp;
        }
      } catch (err: any) {
        console.error(`❌ PriceEngine Failover REST query failed for ${sym}:`, err.message);
      }
    }

    return ltp || 0;
  }

  /**
   * Sync price fetch from in-memory cache
   */
  static getLastPriceSync(symbol: string): number {
    return this.prices.get(symbol.toUpperCase()) || 0;
  }

  /**
   * Audits health and divergence between WebSocket ticks and HTTP quotes
   */
  static async getPriceHealth(symbol: string): Promise<PriceHealthStatus> {
    const sym = symbol.toUpperCase();
    const now = Date.now();
    const cachedPrice = this.prices.get(sym) || 0;
    const lastTickTime = this.lastTickTimes.get(sym) || 0;
    const age = now - lastTickTime;

    let divergence = 0;
    if (cachedPrice > 0) {
      try {
        const restPrice = await UpstoxService.getLastTradedPrice(sym);
        if (restPrice > 0) {
          divergence = (Math.abs(cachedPrice - restPrice) / restPrice) * 100;
        }
      } catch {
        // Ignore check failure
      }
    }

    return {
      stale: age > this.STALE_THRESHOLD_MS,
      lastTickAgeMs: lastTickTime > 0 ? age : Infinity,
      feedDivergencePercent: divergence,
      lagMs: age > 0 && age < Infinity ? age : 0
    };
  }

  private static async runDivergenceAudit(): Promise<void> {
    const symbols = Array.from(this.prices.keys());
    for (const sym of symbols) {
      try {
        const health = await this.getPriceHealth(sym);
        if (health.feedDivergencePercent > 1.0) {
          console.warn(`🚨 FEED DIVERGENCE WARNING: ${sym} price feed divergence is ${health.feedDivergencePercent.toFixed(2)}% (greater than 1% threshold).`);
        }
        if (health.stale) {
          console.warn(`🚨 STALE PRICE FEED: ${sym} WebSocket ticks have stopped for ${(health.lastTickAgeMs / 1000).toFixed(1)}s.`);
        }
      } catch (err: any) {
        // Suppress background audit errors
      }
    }
  }
}
