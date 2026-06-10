import { AppDataSource } from "../data-source";
import { ErrorLog } from "../entity/ErrorLog";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class HealthService {
  private static circuitState: CircuitState = "CLOSED";
  private static consecutiveFailures = 0;
  private static failureThreshold = 3;
  private static cooldownPeriodMs = 60000; // 1 minute cooldown before entering HALF_OPEN
  private static lastFailureTime: number = 0;

  static getCircuitState(): CircuitState {
    if (this.circuitState === "OPEN") {
      const now = Date.now();
      if (now - this.lastFailureTime > this.cooldownPeriodMs) {
        this.circuitState = "HALF_OPEN";
        console.log("🔄 Circuit Breaker transitioning to HALF_OPEN. Testing API connection...");
      }
    }
    return this.circuitState;
  }

  static isTradingAllowed(): boolean {
    const state = this.getCircuitState();
    return state !== "OPEN";
  }

  static getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  static async reportSuccess() {
    this.consecutiveFailures = 0;
    if (this.circuitState !== "CLOSED") {
      console.log("💚 Circuit Breaker successfully recovered! Returning state to CLOSED.");
      this.circuitState = "CLOSED";
    }
  }

  static async reportFailure(context: string, errorMsg: string, stack?: string) {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    const isThresholdReached = this.consecutiveFailures >= this.failureThreshold;
    const severity = isThresholdReached ? "CRITICAL" : "ERROR";

    console.error(`🚨 [API Failure] Context: ${context} | Message: ${errorMsg} | Consecutive failures: ${this.consecutiveFailures}`);

    // Log to DB
    try {
      if (AppDataSource.isInitialized) {
        const log = new ErrorLog();
        log.context = context;
        log.message = errorMsg;
        log.stack = stack;
        log.severity = severity;
        await AppDataSource.manager.save(log);
      }
    } catch (e: any) {
      console.error("❌ Failed to persist error log to MongoDB:", e.message);
    }

    if (isThresholdReached && this.circuitState !== "OPEN") {
      this.circuitState = "OPEN";
      console.error("🛑 CIRCUIT BREAKER TRIPPED! Egress requests blocked to protect account assets.");
    }
  }
}
