import { AppDataSource } from "../data-source";
import { OrderJournal } from "../entity/OrderJournal";
import { ActivePosition } from "../entity/ActivePosition";
import { NotificationService } from "./notification.service";

export class OrderLifecycleManager {
  /**
   * Handles and processes status updates for orders, implementing the order state machine.
   * Also computes the weighted average price on partial fills.
   */
  static async handleOrderUpdate(
    brokerOrderId: string,
    update: {
      status: "NEW" | "PENDING" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";
      filledQty: number;      // Currently filled quantity in this update/transaction
      avgPrice: number;       // Average price of the fill in this update
      totalQty: number;       // Total target order quantity
      errorMessage?: string;
    }
  ): Promise<void> {
    const journalRepo = AppDataSource.getRepository(OrderJournal);
    const positionRepo = AppDataSource.getRepository(ActivePosition);

    // Find the order journal
    const order = await journalRepo.findOne({ where: { brokerOrderId } as any });
    if (!order) {
      console.warn(`⚠️ Received order update for unrecognized brokerOrderId: ${brokerOrderId}`);
      return;
    }

    const prevStatus = order.status;
    const newStatus = update.status;

    // Validate state transitions (e.g. FILLED is terminal)
    if (prevStatus === "FILLED" || prevStatus === "CANCELLED" || prevStatus === "REJECTED") {
      console.log(`ℹ️ Order ${brokerOrderId} is already in terminal state ${prevStatus}. Ignoring update.`);
      return;
    }

    console.log(`🔄 Order ${brokerOrderId} state transition: ${prevStatus} -> ${newStatus}`);

    // Update journal status
    order.status = newStatus as any;
    if (update.errorMessage) {
      order.errorMessage = update.errorMessage;
    }
    await journalRepo.save(order);

    // If there is filled quantity, adjust the position
    if (update.filledQty > 0) {
      let dbPos = await positionRepo.findOne({ where: { symbol: order.symbol } as any });

      if (order.side === "BUY") {
        if (!dbPos) {
          // Create new position for partial fill
          dbPos = new ActivePosition();
          dbPos.symbol = order.symbol;
          dbPos.qty = update.filledQty;
          dbPos.avgEntryPrice = update.avgPrice;
          dbPos.peakPrice = update.avgPrice;
          dbPos.trailingStopPrice = update.avgPrice * 0.98;
          dbPos.stopLossPercent = 0.02;
        } else {
          // Weighted average price formula:
          // P_avg_new = (P_avg_old * Q_old + P_fill * Q_fill) / (Q_old + Q_fill)
          const newQty = dbPos.qty + update.filledQty;
          const newAvgPrice = (dbPos.avgEntryPrice * dbPos.qty + update.avgPrice * update.filledQty) / newQty;

          dbPos.qty = newQty;
          dbPos.avgEntryPrice = newAvgPrice;
          if (newAvgPrice > dbPos.peakPrice) {
            dbPos.peakPrice = newAvgPrice;
            dbPos.trailingStopPrice = newAvgPrice * (1 - dbPos.stopLossPercent);
          }
        }
        const { PositionReconciliationService } = require("./positionReconciliation.service");
        await PositionReconciliationService.savePosition(dbPos);
        console.log(`📈 Position BUY update for ${order.symbol}: Qty=${dbPos.qty}, AvgPrice=₹${dbPos.avgEntryPrice.toFixed(2)}`);
      } else if (order.side === "SELL") {
        if (dbPos) {
          const newQty = Math.max(0, dbPos.qty - update.filledQty);
          if (newQty === 0) {
            const { PositionReconciliationService } = require("./positionReconciliation.service");
            await PositionReconciliationService.deletePosition(order.symbol);
            console.log(`📉 Position SELL update for ${order.symbol}: Position fully closed.`);
          } else {
            dbPos.qty = newQty;
            const { PositionReconciliationService } = require("./positionReconciliation.service");
            await PositionReconciliationService.savePosition(dbPos);
            console.log(`📉 Position SELL update for ${order.symbol}: Remaining Qty=${dbPos.qty}`);
          }
        }
      }

      // Send notifications when fully filled
      if (newStatus === "FILLED") {
        await NotificationService.sendNotification(
          "ORDER COMPLETED",
          `Order ${order.side} ${order.symbol} (${order.qty} shares) fully filled at average price ₹${update.avgPrice.toFixed(2)}`
        );
      }
    }
  }
}
