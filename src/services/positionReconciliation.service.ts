import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { PositionHealthLog } from "../entity/PositionHealthLog";
import { TradeLog } from "../entity/TradeLog";
import { UpstoxService } from "./upstox.service";
import { NotificationService } from "./notification.service";
import { RiskService } from "./risk.service";
import { DailyRiskTracker } from "../entity/DailyRiskTracker";

export class PositionReconciliationService {
  private static cache = new Map<string, ActivePosition>();
  private static systemHalted = false;

  static isSystemHalted(): boolean {
    return this.systemHalted;
  }

  static setSystemHalted(halted: boolean): void {
    this.systemHalted = halted;
  }

  static getCachedPosition(symbol: string): ActivePosition | undefined {
    return this.cache.get(symbol.toUpperCase());
  }

  static getCachedPositions(): ActivePosition[] {
    return Array.from(this.cache.values());
  }

  static setCachedPosition(position: ActivePosition): void {
    this.cache.set(position.symbol.toUpperCase(), position);
  }

  static removeCachedPosition(symbol: string): void {
    this.cache.delete(symbol.toUpperCase());
  }

  static clearCache(): void {
    this.cache.clear();
  }

  static async savePosition(position: ActivePosition): Promise<void> {
    const repo = AppDataSource.getRepository(ActivePosition);
    await repo.save(position);
    this.setCachedPosition(position);
    console.log(`[CACHE]
Position saved
Cache synchronized immediately`);
  }

  static async deletePosition(symbol: string): Promise<void> {
    const sym = symbol.toUpperCase();
    const repo = AppDataSource.getRepository(ActivePosition);
    const dbPos = await repo.findOne({ where: { symbol: sym } as any });
    if (dbPos) {
      await repo.delete({ _id: dbPos._id });
    }
    this.removeCachedPosition(sym);
    console.log(`[CACHE]
Position closed
Cache synchronized immediately`);
  }

  static async clearPositions(): Promise<void> {
    const repo = AppDataSource.getRepository(ActivePosition);
    await repo.clear();
    this.clearCache();
  }

  /**
   * Loads all active positions from MongoDB and populates memory cache
   */
  static async rebuildCache(): Promise<void> {
    try {
      const repo = AppDataSource.getRepository(ActivePosition);
      const dbPositions = await repo.find();
      this.cache.clear();
      for (const pos of dbPositions) {
        this.cache.set(pos.symbol.toUpperCase(), pos);
      }
      console.log(`💾 Memory cache rebuilt from DB: ${this.cache.size} active positions loaded.`);
    } catch (err: any) {
      console.error("❌ Failed to rebuild position memory cache:", err.message);
    }
  }

  /**
   * Validates database position vs cache position vs broker position.
   * Rejects trade if a mismatch exists.
   */
  static async validatePosition(symbol: string): Promise<{ valid: boolean; reason: string }> {
    const sym = symbol.toUpperCase();
    const dbRepo = AppDataSource.getRepository(ActivePosition);
    const dbPos = await dbRepo.findOne({ where: { symbol: sym } as any });
    const cachedPos = this.getCachedPosition(sym);
    const brokerPos = await UpstoxService.getPosition(sym);

    // Verify DB and Cache are aligned
    if ((dbPos && !cachedPos) || (!dbPos && cachedPos) || (dbPos && cachedPos && dbPos.qty !== cachedPos.qty)) {
      return {
        valid: false,
        reason: `Mismatched database vs cache position for ${sym}. DB Qty: ${dbPos?.qty || 0}, Cache Qty: ${cachedPos?.qty || 0}.`
      };
    }

    // Verify DB and Broker are aligned
    const dbQty = dbPos ? dbPos.qty : 0;
    const brokerQty = brokerPos ? brokerPos.qty : 0;

    if (dbQty !== brokerQty) {
      return {
        valid: false,
        reason: `Mismatched database vs broker position for ${sym}. DB Qty: ${dbQty}, Broker Qty: ${brokerQty}.`
      };
    }

    return { valid: true, reason: "Position state is synchronized." };
  }

  /**
   * Compiles detailed audit report of mismatches
   */
  static async auditPositions(): Promise<{
    activePositionsCount: number;
    reconciledPositionsCount: number;
    orphanPositionsCount: number;
    mismatchesCount: number;
    details: any[];
  }> {
    const dbRepo = AppDataSource.getRepository(ActivePosition);
    const dbPositions = await dbRepo.find();
    const brokerPositions = await UpstoxService.getPositions();

    const allSymbols = new Set<string>([
      ...dbPositions.map(p => p.symbol.toUpperCase()),
      ...brokerPositions.map(p => p.symbol.toUpperCase())
    ]);

    let activePositionsCount = 0;
    let reconciledPositionsCount = 0;
    let orphanPositionsCount = 0;
    let mismatchesCount = 0;
    const details: any[] = [];

    for (const sym of allSymbols) {
      const dbPos = dbPositions.find(p => p.symbol.toUpperCase() === sym);
      const brokerPos = brokerPositions.find(p => p.symbol.toUpperCase() === sym);
      const cachedPos = this.getCachedPosition(sym);

      const dbQty = dbPos ? dbPos.qty : 0;
      const brokerQty = brokerPos ? brokerPos.qty : 0;
      const cachedQty = cachedPos ? cachedPos.qty : 0;

      const isDbCacheAligned = dbQty === cachedQty;
      const isBrokerAligned = dbQty === brokerQty;

      if (dbQty > 0 || brokerQty > 0) {
        activePositionsCount++;
      }

      if (isDbCacheAligned && isBrokerAligned) {
        if (dbQty > 0) {
          reconciledPositionsCount++;
        }
      } else {
        mismatchesCount++;
        let caseType = "UNKNOWN";

        if (brokerQty > 0 && dbQty === 0) {
          caseType = "CASE_2_DB_MISSING";
        } else if (brokerQty === 0 && dbQty > 0) {
          caseType = "CASE_3_BROKER_MISSING";
          orphanPositionsCount++;
        } else if (brokerQty > 0 && dbQty > 0 && brokerQty !== dbQty) {
          caseType = "CASE_4_QTY_MISMATCH";
        }

        details.push({
          symbol: sym,
          caseType,
          dbQty,
          cachedQty,
          brokerQty,
          issue: `Mismatch detected: DB Qty ${dbQty}, Cache Qty ${cachedQty}, Broker Qty ${brokerQty}.`
        });
      }
    }

    return {
      activePositionsCount,
      reconciledPositionsCount,
      orphanPositionsCount,
      mismatchesCount,
      details
    };
  }

  /**
   * Resolves Case 2: Rebuilds database entry from broker information and trade logs.
   */
  static async repairPosition(symbol: string, brokerQty: number, avgEntryPrice: number): Promise<boolean> {
    const sym = symbol.toUpperCase();
    console.log(`🔧 Attempting automated repair for position ${sym}...`);

    try {
      const tradeRepo = AppDataSource.getRepository(TradeLog);

      const lastBuyLog = await tradeRepo.findOne({
        where: { symbol: sym, action: "BUY" } as any,
        order: { createdAt: "DESC" } as any
      });

      const entryPrice = lastBuyLog ? lastBuyLog.price : avgEntryPrice;
      const peakPrice = lastBuyLog ? lastBuyLog.price : avgEntryPrice;

      const repairedPos = new ActivePosition();
      repairedPos.symbol = sym;
      repairedPos.qty = brokerQty;
      repairedPos.avgEntryPrice = entryPrice;
      repairedPos.peakPrice = peakPrice;
      repairedPos.trailingStopPrice = peakPrice * 0.98; // Default to 2% trailing stop loss
      repairedPos.stopLossPercent = 0.02;
      repairedPos.createdAt = lastBuyLog ? lastBuyLog.createdAt : new Date();

      // Route through the single authorized write path to keep DB + cache in sync
      await PositionReconciliationService.savePosition(repairedPos);

      console.log(`✓ Position ${sym} successfully repaired and database record restored.`);
      return true;
    } catch (err: any) {
      console.error(`❌ Failed to repair position ${sym}:`, err.message);
      return false;
    }
  }

  /**
   * Run startup and periodic 5-minute reconciliation checks.
   */
  static async reconcilePositions(): Promise<void> {
    console.log("🏥 Running position reconciliation check...");
    
    if (this.cache.size === 0) {
      await this.rebuildCache();
    }

    try {
      const audit = await this.auditPositions();

      let repairsCompleted = 0;
      for (const item of audit.details) {
        if (item.caseType === "CASE_2_DB_MISSING") {
          const brokerPos = await UpstoxService.getPosition(item.symbol);
          if (brokerPos) {
            const repaired = await this.repairPosition(item.symbol, brokerPos.qty, brokerPos.avgEntryPrice);
            if (repaired) repairsCompleted++;
          }
        }
      }

      let finalAudit = audit;
      if (repairsCompleted > 0) {
        console.log(`🔧 Repaired ${repairsCompleted} positions. Re-auditing system state...`);
        finalAudit = await this.auditPositions();
      }

      const healthLog = new PositionHealthLog();
      healthLog.activePositionsCount = finalAudit.activePositionsCount;
      healthLog.reconciledPositionsCount = finalAudit.reconciledPositionsCount;
      healthLog.orphanPositionsCount = finalAudit.orphanPositionsCount;
      healthLog.mismatchesCount = finalAudit.mismatchesCount;
      healthLog.details = JSON.stringify(finalAudit.details);
      await AppDataSource.getRepository(PositionHealthLog).save(healthLog);

      if (finalAudit.mismatchesCount > 0) {
        console.warn(`🚨 RECONCILIATION WARNING: ${finalAudit.mismatchesCount} position mismatches persist!`);

        const criticalMismatches = finalAudit.details.filter(
          item => item.caseType === "CASE_3_BROKER_MISSING" || item.caseType === "CASE_4_QTY_MISMATCH"
        );

        if (criticalMismatches.length > 0) {
          console.error("❌ CRITICAL: Halting trading bot due to active state reconciliation failure.");
          this.setSystemHalted(true);

          try {
            const todayStr = new Date().toISOString().split("T")[0];
            const trackerRepo = AppDataSource.getRepository(DailyRiskTracker);
            let tracker = await trackerRepo.findOne({ where: { date: todayStr } as any });
            if (tracker) {
              tracker.isHalted = true;
              await trackerRepo.save(tracker);
            }
          } catch (haltErr: any) {
            console.error("Failed to update daily risk tracker halt state:", haltErr.message);
          }

          const alertMsg = `CRITICAL POSITION MISMATCH HALT!\n\nMismatch Details:\n${JSON.stringify(criticalMismatches, null, 2)}`;
          await NotificationService.sendNotification("CRITICAL: Position State Mismatch Halt", alertMsg);
        }
      } else {
        console.log("✓ Position reconciliation complete. System state is HEALTHY.");
      }
    } catch (err: any) {
      console.error("❌ Position reconciliation failed:", err.message);
    }
  }
}
