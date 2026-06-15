import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { UpstoxService } from "./upstox.service";
import { NotificationService } from "./notification.service";
import { PositionRepairEngine } from "./PositionRepairEngine";
import { PriceEngine } from "./PriceEngine";

export interface ValidationResult {
  symbol: string;
  entryPrice: number;
  peakPrice: number;
  trailingStop: number;
  marketPrice: number;
  isValid: boolean;
  failures: string[];
  repaired: boolean;
}

export class TrailingStopValidator {
  private static auditInterval: NodeJS.Timeout | null = null;

  /**
   * Run trailing stop verification on all active positions
   */
  static async validatePositions(): Promise<ValidationResult[]> {
    console.log("🕵️ TrailingStopValidator: Auditing active position states...");
    const results: ValidationResult[] = [];
    const positionRepo = AppDataSource.getRepository(ActivePosition);

    try {
      const positions = await positionRepo.find();

      for (const pos of positions) {
        const result: ValidationResult = {
          symbol: pos.symbol,
          entryPrice: pos.avgEntryPrice,
          peakPrice: pos.peakPrice,
          trailingStop: pos.trailingStopPrice,
          marketPrice: 0,
          isValid: true,
          failures: [],
          repaired: false
        };

        try {
          const ltp = await PriceEngine.getLastPrice(pos.symbol);
          result.marketPrice = ltp;

          if (ltp <= 0) {
            throw new Error(`Fetched invalid LTP for validator: ₹${ltp}`);
          }

          // Verification checks:
          // Rule 1: EntryPrice <= PeakPrice
          if (pos.avgEntryPrice > pos.peakPrice) {
            result.isValid = false;
            result.failures.push(`EntryPrice (₹${pos.avgEntryPrice}) exceeds PeakPrice (₹${pos.peakPrice})`);
          }

          // Rule 2: TrailingStop <= PeakPrice
          if (pos.trailingStopPrice > pos.peakPrice) {
            result.isValid = false;
            result.failures.push(`TrailingStop (₹${pos.trailingStopPrice}) exceeds PeakPrice (₹${pos.peakPrice})`);
          }

          // Rule 3: PeakPrice <= Math.max(pos.avgEntryPrice, ltp) * 1.05
          if (pos.peakPrice > Math.max(pos.avgEntryPrice, ltp) * 1.05) {
            result.isValid = false;
            result.failures.push(`PeakPrice (₹${pos.peakPrice}) is unrealistically high compared to Math.max(Entry, LTP) (₹${Math.max(pos.avgEntryPrice, ltp)} * 1.05 = ₹${(Math.max(pos.avgEntryPrice, ltp) * 1.05).toFixed(2)})`);
          }

          if (!result.isValid) {
            console.warn(`🚨 Position validation failed for ${pos.symbol}:`, result.failures.join("; "));

            // 1. Mark position invalid (Write to DB)
            pos.isInvalid = true;
            await positionRepo.save(pos);

            // 2. Trigger investigation alert
            const alertMsg = `Position integrity validation failed for ${pos.symbol}.\n\n` +
              `Failures:\n- ${result.failures.join("\n- ")}\n\n` +
              `Current State:\n` +
              `- Entry Price: ₹${pos.avgEntryPrice.toFixed(2)}\n` +
              `- Peak Price: ₹${pos.peakPrice.toFixed(2)}\n` +
              `- Trailing Stop: ₹${pos.trailingStopPrice.toFixed(2)}\n` +
              `- Market LTP: ₹${ltp.toFixed(2)}\n\n` +
              `Triggering automatic repair...`;
            
            await NotificationService.sendNotification(
              "CRITICAL: Position Integrity Alert",
              alertMsg
            );

            // 3. Automatic repair logic
            const repairReport = await PositionRepairEngine.repairAllActivePositions();
            
            const repairedPos = repairReport.details.find(d => d.symbol === pos.symbol);
            if (repairedPos && repairedPos.repaired) {
              result.repaired = true;
              console.log(`✓ Position ${pos.symbol} successfully repaired by validator automation.`);
            }
          }
        } catch (err: any) {
          result.isValid = false;
          result.failures.push(`Audit execution failed: ${err.message}`);
          console.error(`❌ Validation error for ${pos.symbol}:`, err.message);
        }

        results.push(result);
      }
    } catch (err: any) {
      console.error("❌ Failed to query positions for TrailingStopValidator audit:", err.message);
    }

    return results;
  }

  /**
   * Daily Audit Job scheduling (once every 24 hours).
   */
  static startDailyAuditJob(): void {
    if (this.auditInterval) {
      clearInterval(this.auditInterval);
    }

    // Run audit every 24 hours
    const dailyMs = 24 * 60 * 60 * 1000;
    this.auditInterval = setInterval(async () => {
      try {
        console.log("⏱️ Starting Scheduled Daily Position Audit Job...");
        await this.validatePositions();
      } catch (err: any) {
        console.error("❌ Scheduled Daily Position Audit Job encountered an error:", err.message);
      }
    }, dailyMs);

    console.log("📅 Daily Scheduled Position Audit Job registered.");
  }

  /**
   * Stop daily scheduled job
   */
  static stopDailyAuditJob(): void {
    if (this.auditInterval) {
      clearInterval(this.auditInterval);
      this.auditInterval = null;
      console.log("🔌 Daily Scheduled Position Audit Job unregistered.");
    }
  }
}
