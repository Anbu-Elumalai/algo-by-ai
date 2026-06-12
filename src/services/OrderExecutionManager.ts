import { AppDataSource } from "../data-source";
import { OrderJournal } from "../entity/OrderJournal";
import { UpstoxService } from "./upstox.service";
import { Mutex } from "../utils/mutex";

const symbolMutexes = new Map<string, Mutex>();

export class OrderExecutionManager {
  private static getSymbolMutex(symbol: string): Mutex {
    let mutex = symbolMutexes.get(symbol);
    if (!mutex) {
      mutex = new Mutex();
      symbolMutexes.set(symbol, mutex);
    }
    return mutex;
  }

  /**
   * Place an order with symbol mutex locking and idempotency tracking.
   */
  static async executeOrder(
    idempotencyKey: string,
    correlationId: string,
    symbol: string,
    qty: number,
    side: "BUY" | "SELL",
    orderType: "MARKET" | "LIMIT" = "MARKET",
    price?: number
  ): Promise<any> {
    const mutex = this.getSymbolMutex(symbol);
    const release = await mutex.acquire();

    try {
      const journalRepo = AppDataSource.getRepository(OrderJournal);

      // Check for existing transaction
      const existing = await journalRepo.findOne({ where: { idempotencyKey } as any });
      if (existing) {
        console.log(`⚠️ Order with idempotencyKey ${idempotencyKey} already exists. Status: ${existing.status}`);
        if (existing.status === "SUCCESS" || existing.status === "FILLED") {
          return {
            order_id: existing.brokerOrderId,
            status: "success",
            alreadyExecuted: true,
          };
        }
        if (existing.status === "INITIATED" || existing.status === "SUBMITTED") {
          throw new Error(`Order execution in progress for key: ${idempotencyKey}`);
        }
      }

      // 1. Create a new journal entry
      const journal = new OrderJournal();
      journal.idempotencyKey = idempotencyKey;
      journal.correlationId = correlationId;
      journal.symbol = symbol;
      journal.qty = qty;
      journal.side = side;
      journal.orderType = orderType;
      journal.price = price;
      journal.status = "INITIATED";
      await journalRepo.save(journal);

      // 2. Submit order to broker
      journal.status = "SUBMITTED";
      await journalRepo.save(journal);

      try {
        const orderResult = await UpstoxService.placeOrder(symbol, qty, side, orderType, price);
        
        // 3. Update journal on success
        journal.status = "SUCCESS";
        journal.brokerOrderId = orderResult.order_id || JSON.stringify(orderResult);
        await journalRepo.save(journal);

        return orderResult;
      } catch (err: any) {
        // 4. Update journal on failure
        journal.status = "FAILED";
        journal.errorMessage = err.message;
        await journalRepo.save(journal);
        throw err;
      }
    } finally {
      release();
    }
  }

  /**
   * Boot-time recovery: Find any pending/stuck orders and reconcile their actual status with the broker.
   */
  static async recoverPendingTransactions(): Promise<void> {
    console.log("🔄 Running Order Execution Manager boot recovery check...");
    try {
      const journalRepo = AppDataSource.getRepository(OrderJournal);
      // Find all INITIATED or SUBMITTED orders
      const pendingOrders = await journalRepo.find({
        where: {
          $or: [
            { status: "INITIATED" },
            { status: "SUBMITTED" }
          ]
        } as any
      });

      if (pendingOrders.length === 0) {
        console.log("✅ No stuck order transactions found.");
        return;
      }

      console.warn(`⚠️ Found ${pendingOrders.length} pending/stuck order transactions on boot. Reconciling...`);

      for (const order of pendingOrders) {
        try {
          if (!order.brokerOrderId) {
            // If it never got a brokerOrderId, it likely failed before placing. Mark as FAILED.
            order.status = "FAILED";
            order.errorMessage = "Process crashed before order submission returned.";
            await journalRepo.save(order);
            console.log(`❌ Stuck order ${order.idempotencyKey} (no broker ID) marked as FAILED.`);
            continue;
          }

          // Query broker to see if order was completed
          const brokerDetails = await UpstoxService.getOrderStatus(order.brokerOrderId);
          if (brokerDetails && (brokerDetails.status === "complete" || brokerDetails.status === "success" || brokerDetails.status === "filled")) {
            order.status = "SUCCESS";
            await journalRepo.save(order);
            console.log(`✅ Stuck order ${order.idempotencyKey} matched broker complete. Recovered as SUCCESS.`);
          } else {
            order.status = "FAILED";
            order.errorMessage = `Broker status: ${brokerDetails?.status || "unknown"}`;
            await journalRepo.save(order);
            console.log(`❌ Stuck order ${order.idempotencyKey} matched broker failed/incomplete. Recovered as FAILED.`);
          }
        } catch (err: any) {
          console.error(`❌ Failed to reconcile stuck order ${order.idempotencyKey}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error("❌ Order recovery failed:", err.message);
    }
  }
}
