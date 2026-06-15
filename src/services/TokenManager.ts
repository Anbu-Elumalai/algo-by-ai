import { UpstoxService } from "./upstox.service";
import { MarketDataReliabilityLayer } from "./MarketDataReliabilityLayer";
import { NotificationService } from "./notification.service";

export class TokenManager {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isAuthError = false;

  static startMonitoring(intervalMs: number = 5 * 60 * 1000): void {
    if (this.intervalId) {
      return;
    }
    console.log("🔑 Starting Upstox Token Lifecycle Monitor...");
    
    // Run validation immediately on startup
    this.checkTokenHealth();

    this.intervalId = setInterval(() => {
      this.checkTokenHealth();
    }, intervalMs);
  }

  static stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("🔑 Stopped Upstox Token Lifecycle Monitor.");
    }
  }

  static async checkTokenHealth(): Promise<boolean> {
    try {
      await UpstoxService.getProfile();
      if (this.isAuthError) {
        console.log("💚 Upstox Token health restored.");
        this.isAuthError = false;
      }
      return true;
    } catch (error: any) {
      const status = error.response?.status;
      const isUnauthorized = status === 401 || status === 410 || 
        (error.message && (
          error.message.includes("401") || 
          error.message.includes("410") || 
          error.message.toLowerCase().includes("unauthorized") || 
          error.message.toLowerCase().includes("expired")
        ));

      if (isUnauthorized) {
        this.isAuthError = true;
        console.error("❌ Upstox Token is expired or invalid (Unauthorized/410).");
        
        if (!MarketDataReliabilityLayer.isTradingPaused()) {
          await MarketDataReliabilityLayer.pauseTrading(
            "Upstox API Authentication Failure (Unauthorized/HTTP 410). Browser OAuth login is required."
          );
        } else {
          await NotificationService.sendNotification(
            "CRITICAL: Upstox Token Expired",
            "Upstox token authorization failed. Browser OAuth login is required to resume trading."
          );
        }
        return false;
      }
      
      console.warn("⚠️ Upstox token health check encountered a non-auth error:", error.message);
      return false;
    }
  }
}
