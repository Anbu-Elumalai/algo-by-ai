import { PositionReconciliationService } from "./positionReconciliation.service";

export class PositionRecoveryManager {
  private static checkInterval: NodeJS.Timeout | null = null;

  /**
   * Run startup 3-way reconciliation check.
   */
  static async runStartupCheck(): Promise<void> {
    console.log("🚀 Running startup position 3-way reconciliation...");
    await PositionReconciliationService.reconcilePositions();

    if (PositionReconciliationService.isSystemHalted()) {
      throw new Error("❌ CRITICAL: Startup position reconciliation failed and system has been halted.");
    }
  }

  /**
   * Start periodic reconciliation loop (runs every 5 minutes).
   */
  static startPeriodicReconciliation(intervalMs: number = 300000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      try {
        await PositionReconciliationService.reconcilePositions();
      } catch (err: any) {
        console.error("❌ PositionRecoveryManager periodic check failed:", err.message);
      }
    }, intervalMs);

    console.log(`⏱️ Position recovery monitoring started (every ${intervalMs / 1000}s).`);
  }

  /**
   * Stop periodic checks.
   */
  static stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log("🔌 Position recovery monitoring deactivated.");
    }
  }
}
