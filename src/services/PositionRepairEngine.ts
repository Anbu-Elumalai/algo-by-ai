import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { UpstoxService } from "./upstox.service";
import { NotificationService } from "./notification.service";
import { PriceEngine } from "./PriceEngine";

export interface RepairReportItem {
  symbol: string;
  qty: number;
  entryPrice: number;
  marketPrice: number;
  oldPeakPrice: number;
  newPeakPrice: number;
  oldTrailingStop: number;
  newTrailingStop: number;
  corrupted: boolean;
  repaired: boolean;
  error?: string;
}

export interface RepairReport {
  timestamp: Date;
  totalPositionsChecked: number;
  corruptedPositionsCount: number;
  repairedPositionsCount: number;
  details: RepairReportItem[];
}

export class PositionRepairEngine {
  /**
   * Scans all active positions, flags corrupted ones, and performs the repair procedure.
   * Native MongoDB query equivalent:
   * db.collection("active_positions").updateOne(
   *   { _id: pos._id },
   *   { $set: { peakPrice: recalculatedPeak, trailingStopPrice: recalculatedStop, isInvalid: false } }
   * )
   */
  static async repairAllActivePositions(): Promise<RepairReport> {
    console.log("🛠️ PositionRepairEngine: Starting position integrity check and repairs...");
    const report: RepairReport = {
      timestamp: new Date(),
      totalPositionsChecked: 0,
      corruptedPositionsCount: 0,
      repairedPositionsCount: 0,
      details: []
    };

    try {
      const positionRepo = AppDataSource.getRepository(ActivePosition);
      const positions = await positionRepo.find();
      report.totalPositionsChecked = positions.length;

      for (const pos of positions) {
        const item: RepairReportItem = {
          symbol: pos.symbol,
          qty: pos.qty,
          entryPrice: pos.avgEntryPrice,
          marketPrice: 0,
          oldPeakPrice: pos.peakPrice,
          newPeakPrice: pos.peakPrice,
          oldTrailingStop: pos.trailingStopPrice,
          newTrailingStop: pos.trailingStopPrice,
          corrupted: false,
          repaired: false
        };

        try {
          // 1. Fetch real LTP
          const ltp = await PriceEngine.getLastPrice(pos.symbol);
          item.marketPrice = ltp;

          if (ltp <= 0) {
            throw new Error(`Fetched invalid LTP: ₹${ltp}`);
          }

          // Rule: If PeakPrice > Math.max(pos.avgEntryPrice, ltp) * 1.05, it is CORRUPTED
          if (pos.peakPrice > Math.max(pos.avgEntryPrice, ltp) * 1.05) {
            item.corrupted = true;
            report.corruptedPositionsCount++;

            // Repair Procedure:
            // 2. Recalculate peak price (Math.max of avgEntryPrice and real LTP)
            const recalculatedPeak = Math.max(pos.avgEntryPrice, ltp);
            
            // 3. Recalculate trailing stop
            const recalculatedStop = recalculatedPeak * (1 - pos.stopLossPercent);

            item.newPeakPrice = recalculatedPeak;
            item.newTrailingStop = recalculatedStop;

            // Update database state
            pos.peakPrice = recalculatedPeak;
            pos.trailingStopPrice = recalculatedStop;
            pos.isInvalid = false; // Reset invalid flag if it was set
            
            // 4. Save repaired state
            await positionRepo.save(pos);
            item.repaired = true;
            report.repairedPositionsCount++;

            const msg = `🔧 Repaired corrupted position for ${pos.symbol}: Peak ₹${item.oldPeakPrice} -> ₹${recalculatedPeak}, SL ₹${item.oldTrailingStop} -> ₹${recalculatedStop}`;
            console.log(msg);
            await NotificationService.sendNotification(
              "POSITION REPAIRED",
              `Corrupted position for ${pos.symbol} was automatically repaired.\n` +
              `Old Peak: ₹${item.oldPeakPrice.toFixed(2)} | New Peak: ₹${recalculatedPeak.toFixed(2)}\n` +
              `Old SL: ₹${item.oldTrailingStop.toFixed(2)} | New SL: ₹${recalculatedStop.toFixed(2)}\n` +
              `Current LTP: ₹${ltp.toFixed(2)}`
            );
          }
        } catch (err: any) {
          item.error = err.message;
          console.error(`❌ Error repairing position ${pos.symbol}:`, err.message);
        }

        report.details.push(item);
      }
    } catch (err: any) {
      console.error("❌ Failed to complete Position Repair Engine check:", err.message);
    }

    return report;
  }
}
