import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { TradeLog } from "../entity/TradeLog";
import { DailyRiskTracker } from "../entity/DailyRiskTracker";
import { OrderJournal } from "../entity/OrderJournal";
import { FeedHealthLog } from "../entity/FeedHealthLog";

async function auditCurrentState() {
  console.log("=== EXECUTING SYSTEM STATUS AUDIT ===");

  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }

  // 1. Fetch DB records
  const activePositions = await AppDataSource.getRepository(ActivePosition).find();
  const tradeLogs = await AppDataSource.getRepository(TradeLog).find();
  const dailyTracker = await AppDataSource.getRepository(DailyRiskTracker).find();
  const orderJournals = await AppDataSource.getRepository(OrderJournal).find();
  const healthLogs = await AppDataSource.getRepository(FeedHealthLog).find();

  console.log("\n--- SECTION 1: SYSTEM STATUS ---");
  console.log(`MongoDB Connected: ${AppDataSource.isInitialized}`);
  console.log(`TRADING_MODE: ${process.env.TRADING_MODE}`);
  console.log(`Active Positions in DB: ${activePositions.length}`);
  console.log(`Trade Logs in DB: ${tradeLogs.length}`);
  console.log(`Daily Trackers in DB: ${dailyTracker.length}`);
  console.log(`Order Journals in DB: ${orderJournals.length}`);

  console.log("\n--- SECTION 4: ACTIVE POSITION AUDIT ---");
  if (activePositions.length === 0) {
    console.log("No active positions found in MongoDB active_positions collection.");
  } else {
    for (const pos of activePositions) {
      console.log(`Symbol: ${pos.symbol} | Qty: ${pos.qty} | Entry: ${pos.avgEntryPrice} | Peak: ${pos.peakPrice} | Stop Loss: ${pos.trailingStopPrice} | Invalid: ${pos.isInvalid}`);
    }
  }

  console.log("\n--- SECTION 5: TRADE AUDIT ---");
  const last20Trades = tradeLogs.slice(-20).reverse();
  if (last20Trades.length === 0) {
    console.log("No trades found in MongoDB trade_logs collection.");
  } else {
    for (const trade of last20Trades) {
      console.log(`Symbol: ${trade.symbol} | Action: ${trade.action} | Price: ₹${trade.price} | Qty: ${trade.qty} | Time: ${trade.createdAt} | Reason: ${trade.signalReason}`);
    }
  }

  console.log("\n--- SECTION 6: DAILY RISK TRACKER ---");
  if (dailyTracker.length === 0) {
    console.log("No daily risk tracker found.");
  } else {
    for (const tracker of dailyTracker) {
      console.log(`Date: ${tracker.date} | Starting: ₹${tracker.startingEquity} | Current: ₹${tracker.currentEquity} | TradeCount: ${tracker.tradeCount} | Halted: ${tracker.isHalted}`);
    }
  }

  console.log("\n--- SECTION 8: ORDER RECOVERY ---");
  const pendingOrders = orderJournals.filter(o => o.status === "INITIATED" || o.status === "SUBMITTED");
  console.log(`Pending/Stuck orders count: ${pendingOrders.length}`);
  for (const order of pendingOrders) {
    console.log(`Order ID: ${order.brokerOrderId} | Symbol: ${order.symbol} | Side: ${order.side} | Status: ${order.status}`);
  }

  await AppDataSource.destroy();
}

auditCurrentState().catch(console.error);
