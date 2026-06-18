import { UpstoxService } from "./upstox.service";
import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { PositionReconciliationService } from "./positionReconciliation.service";

export class PositionGuardService {
  /**
   * Verifies if trade execution is permitted based on broker holdings and database states.
   * Gate 0: System halt (reconciliation mismatch) blocks ALL orders unconditionally.
   */
  static async verifyOrderAllowed(
    symbol: string,
    side: "BUY" | "SELL"
  ): Promise<{ allowed: boolean; reason: string }> {
    const sym = symbol.toUpperCase();

    // Gate 0 — Reconciliation safety halt (highest priority)
    if (PositionReconciliationService.isSystemHalted()) {
      return {
        allowed: false,
        reason: "SYSTEM HALTED: Critical position state mismatch detected. Manual admin intervention required before trading resumes."
      };
    }

    // 1. Fetch live broker positions
    let brokerPositions: any[] = [];
    try {
      brokerPositions = await UpstoxService.getPositions();
    } catch (err: any) {
      console.warn("⚠️ Position sync check: Broker fetch failed during guard check:", err.message);
    }

    const brokerPos = brokerPositions.find(p => p.symbol.toUpperCase() === sym);

    // 2. Fetch local database position cache
    const repo = AppDataSource.getRepository(ActivePosition);
    const dbPos = await repo.findOne({ where: { symbol: sym } as any });

    if (side === "BUY") {
      if (brokerPos && brokerPos.qty > 0) {
        return {
          allowed: false,
          reason: `Broker holds active position for ${sym} (${brokerPos.qty} shares). Trade blocked.`
        };
      }
      if (dbPos && dbPos.qty > 0) {
        return {
          allowed: false,
          reason: `Database registers active position for ${sym} (${dbPos.qty} shares). Trade blocked.`
        };
      }
    } else if (side === "SELL") {
      if (!brokerPos || brokerPos.qty <= 0) {
        return {
          allowed: false,
          reason: `No active broker position found to liquidate for ${sym}.`
        };
      }
      if (!dbPos || dbPos.qty <= 0) {
        return {
          allowed: false,
          reason: `No active database position cache found for ${sym}.`
        };
      }
    }

    return { allowed: true, reason: "Position guard verification cleared." };
  }
}
