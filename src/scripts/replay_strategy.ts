import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { StrategyDecision } from "../entity/StrategyDecision";
import { CandleService } from "../services/candle.service";
import { calculateSMA, calculateRSI } from "../strategies/strategyEngine";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();

  const tradeRepo = AppDataSource.getMongoRepository(TradeLog);
  const decisionRepo = AppDataSource.getMongoRepository(StrategyDecision);

  const trades = await tradeRepo.find();
  const buyTrades = trades.filter(t => t.action === "BUY").sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  console.log("=== REPLAYING STRATEGY ON COMPLETED CANDLES FOR ALL BUY TRADES ===");

  for (const buy of buyTrades) {
    const buyTime = new Date(buy.createdAt);
    const sym = buy.symbol.toUpperCase();

    // Fetch candle history as it would have been at the time of the trade
    // We can get candles from CandleService
    const allCandles = await CandleService.getSyncedCandles(sym, 10);
    
    // Filter candles that closed before or exactly at the buy time
    const closedCandles = allCandles.filter(c => new Date(c.t).getTime() < buyTime.getTime());
    
    if (closedCandles.length < 22) {
      console.log(`\nTrade for ${sym} at ${buyTime.toISOString()} | Price: ₹${buy.price}`);
      console.log(`   Insufficient historical candles closed before this trade (${closedCandles.length} candles).`);
      continue;
    }

    const lastCompleted = closedCandles[closedCandles.length - 1];
    const prevCompleted = closedCandles[closedCandles.length - 2];

    const closingPrices = closedCandles.map(c => c.c);
    const prevClosingPrices = closingPrices.slice(0, -1);

    const currentFastSma = calculateSMA(closingPrices, 9);
    const currentSlowSma = calculateSMA(closingPrices, 21);
    const prevFastSma = calculateSMA(prevClosingPrices, 9);
    const prevSlowSma = calculateSMA(prevClosingPrices, 21);
    const rsi = calculateRSI(closingPrices, 14);

    const isGoldenCross = currentFastSma > currentSlowSma && prevFastSma <= prevSlowSma;
    const isRsiOk = rsi < 70;

    console.log(`\nTrade for ${sym} at ${buyTime.toISOString()} | Price: ₹${buy.price}`);
    console.log(`   Latest Completed Candle close time: ${lastCompleted.t} | Close Price: ₹${lastCompleted.c}`);
    console.log(`   Calculated SMAs on completed candles:`);
    console.log(`     - Current: Fast SMA (9) = ₹${currentFastSma.toFixed(2)} | Slow SMA (21) = ₹${currentSlowSma.toFixed(2)}`);
    console.log(`     - Previous: Fast SMA (9) = ₹${prevFastSma.toFixed(2)} | Slow SMA (21) = ₹${prevSlowSma.toFixed(2)}`);
    console.log(`     - RSI (14): ${rsi.toFixed(2)}`);
    console.log(`     - Golden Cross Condition Met? ${isGoldenCross ? "YES ✅" : "NO ❌"}`);
    console.log(`     - RSI Filter Passed? ${isRsiOk ? "YES ✅" : "NO ❌ (Overbought)"}`);
    console.log(`   Conclusion: ${isGoldenCross && isRsiOk ? "TRUE ENTRY ✅" : "FALSE ENTRY ❌"}`);
  }

  await AppDataSource.destroy();
}

run().catch(console.error);
