import { UpstoxService, UpstoxPosition } from "./upstox.service";
import { analyzeMovingAverageCrossover } from "../strategies/movingAverageCrossover";
import { RiskService } from "./risk.service";
import { TradeLog } from "../entity/TradeLog";
import { BotPerformance } from "../entity/BotPerformance";
import { AppDataSource } from "../data-source";

export class TradingLoopService {
  private static isActive = false;
  private static intervalId: NodeJS.Timeout | null = null;
  private static targetSymbols: string[] = ["RELIANCE", "TCS"];
  
  // Store closing prices in memory for each symbol
  private static priceHistory: Map<string, number[]> = new Map();

  /**
   * Status check of the bot
   */
  static getStatus() {
    return {
      isActive: this.isActive,
      symbols: this.targetSymbols,
      cachedBars: Array.from(this.priceHistory.entries()).map(([sym, prices]) => ({
        symbol: sym,
        barCount: prices.length,
      })),
    };
  }

  /**
   * Starts the live trading bot using robust LTP polling
   */
  static async start(): Promise<void> {
    if (this.isActive) {
      console.log("⚠️ Upstox Trading Bot is already running!");
      return;
    }

    console.log("🚀 Starting the Upstox Algorithmic Trading Bot...");
    this.isActive = true;

    try {
      // 1. Validate Upstox API access
      const account = await UpstoxService.getAccount();
      console.log(`🏦 Connected to Upstox Account | Current Account Equity: ₹${account.equity.toFixed(2)} | Available Cash: ₹${account.cash.toFixed(2)}`);

      // 2. Bootstrap sliding window: download historical bars to pre-initialize indicators
      for (const symbol of this.targetSymbols) {
        console.log(`📥 Bootstrapping indicators for ${symbol}...`);
        const historicalBars = await UpstoxService.getHistoricalBars(symbol, 45, "day");
        const closes = historicalBars.map(b => b.c);
        
        // Retain only the last 30 daily closes to populate the sliding window
        const slidingWindow = closes.slice(-30);
        this.priceHistory.set(symbol, slidingWindow);
        console.log(`🎯 Bootstrapped ${slidingWindow.length} historical prices for ${symbol}. Ready for live polling.`);
      }

      // 3. Save initial performance snapshot to DB
      await this.logPerformanceSnapshot(account.equity, account.cash, account.buyingPower, 0);

      // 4. Start Live Polling Loop (polls LTP every 60 seconds)
      console.log("⏱️ Live Indian Market Loop initialized. Polling stock LTP every 60 seconds...");
      
      // Execute first tick immediately
      await this.executeTick();
      
      this.intervalId = setInterval(async () => {
        await this.executeTick();
      }, 60000); // 60,000ms = 1 minute

      console.log("⚡ Upstox Trading Bot is fully operational!");
    } catch (err: any) {
      this.isActive = false;
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      console.error("❌ Failed to start Upstox Trading Bot:", err.message);
      throw err;
    }
  }

  /**
   * Stops the live trading bot
   */
  static stop(): void {
    if (!this.isActive) {
      console.log("⚠️ Upstox Trading Bot is already offline.");
      return;
    }

    console.log("🛑 Stopping the Upstox Algorithmic Trading Bot...");
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isActive = false;
    console.log("🔌 Upstox Bot is offline.");
  }

  /**
   * Executes a single polling tick across all symbols
   */
  private static async executeTick() {
    if (!this.isActive) return;

    // Fetch account details and all open positions ONCE per tick (reduces API calls by 50%+)
    let account;
    let positions: UpstoxPosition[] = [];
    try {
      account = await UpstoxService.getAccount();
      positions = await UpstoxService.getPositions();
    } catch (err: any) {
      console.error("❌ Error fetching Upstox account status/positions on tick:", err.message);
      // Fallback to avoid stopping the loop
      account = { equity: 100000, cash: 100000, buyingPower: 500000 };
      positions = [];
    }

    for (const symbol of this.targetSymbols) {
      try {
        // A. Fetch current stock price (LTP)
        const currentPrice = await UpstoxService.getLastTradedPrice(symbol);
        if (currentPrice <= 0) continue;

        console.log(`📊 [Live Poll] ${symbol}: Current Price = ₹${currentPrice.toFixed(2)} at ${new Date().toLocaleTimeString()}`);

        // B. Update sliding window in memory
        let prices = this.priceHistory.get(symbol) || [];
        prices.push(currentPrice);
        
        // Keep window bounded to last 30 periods
        if (prices.length > 30) {
          prices.shift();
        }
        this.priceHistory.set(symbol, prices);

        // Find existing position for this symbol from pre-fetched positions
        const position = positions.find(p => p.symbol.toUpperCase() === symbol.toUpperCase()) || null;

        // D. Risk Check: Enforce Stop-Loss if we hold this stock
        if (position) {
          const stopLossResult = RiskService.shouldTriggerStopLoss(position, 0.02); // 2% limit
          
          if (stopLossResult.trigger) {
            console.log(`🚨 STOP LOSS ACTIVATED: Selling holdings of ${symbol} at ₹${currentPrice}`);
            
            // Execute order
            await UpstoxService.placeOrder(symbol, position.qty, "SELL", "MARKET");

            // Save Trade Log to Database
            await this.saveTradeLog(
              symbol,
              "SELL",
              currentPrice,
              position.qty,
              "SMA Crossover (Upstox Live)",
              `STOP LOSS TRIGGERED: Ticker dropped ${(stopLossResult.currentLossPercent * 100).toFixed(2)}% below entry price.`
            );

            await this.logPerformanceSnapshot(account.equity, account.cash, account.buyingPower, 0);
            continue; // Skip strategy logic for this ticker this tick
          }
        }

        // E. Strategy Calculations
        const strategyReport = analyzeMovingAverageCrossover(prices, 9, 21);
        console.log(`⚙️ Strategy check for ${symbol}: Signal is ${strategyReport.signal} | ${strategyReport.reason}`);

        // Case Buy: Triggered and we do not hold shares
        if (strategyReport.signal === "BUY" && !position) {
          // Size position: Max 5% of overall equity
          const qtyToBuy = RiskService.calculatePositionSize(account.equity, currentPrice, 0.05);

          if (qtyToBuy > 0) {
            const totalCost = qtyToBuy * currentPrice;
            
            if (account.cash >= totalCost) {
              const order = await UpstoxService.placeOrder(symbol, qtyToBuy, "BUY", "MARKET");
              console.log(`✅ BUY Order placed successfully on Upstox! Order ID: ${order.order_id || JSON.stringify(order)}`);

              // Save Trade Log to Database
              await this.saveTradeLog(
                symbol,
                "BUY",
                currentPrice,
                qtyToBuy,
                "SMA Crossover (Upstox Live)",
                strategyReport.reason
              );

              await this.logPerformanceSnapshot(account.equity, account.cash - totalCost, account.buyingPower, 0);
            } else {
              console.log(`⚠️ Insufficient cash (₹${account.cash.toFixed(2)}) to place ₹${totalCost.toFixed(2)} order for ${symbol}`);
            }
          }
        }

        // Case Sell: Triggered and we hold active shares
        else if (strategyReport.signal === "SELL" && position) {
          const order = await UpstoxService.placeOrder(symbol, position.qty, "SELL", "MARKET");
          console.log(`✅ SELL Order placed successfully on Upstox! Order ID: ${order.order_id || JSON.stringify(order)}`);

          // Save Trade Log to Database
          await this.saveTradeLog(
            symbol,
            "SELL",
            currentPrice,
            position.qty,
            "SMA Crossover (Upstox Live)",
            strategyReport.reason
          );

          await this.logPerformanceSnapshot(account.equity, account.cash + (position.qty * currentPrice), account.buyingPower, 0);
        }

      } catch (err: any) {
        console.error(`❌ Error in polling tick for ${symbol}:`, err.message);
      }
    }
  }

  /**
   * Helper to write executed trade record to MongoDB
   */
  private static async saveTradeLog(
    symbol: string,
    action: "BUY" | "SELL",
    price: number,
    qty: number,
    strategy: string,
    reason: string
  ): Promise<void> {
    try {
      if (!AppDataSource.isInitialized) return;

      const log = new TradeLog();
      log.symbol = symbol;
      log.action = action;
      log.price = price;
      log.qty = qty;
      log.totalAmount = price * qty;
      log.strategy = strategy;
      log.signalReason = reason;

      await AppDataSource.manager.save(log);
      console.log(`💾 Saved trade execution log to MongoDB for ${action} ${qty} ${symbol}`);
    } catch (e: any) {
      console.error("❌ Error saving trade log to database:", e.message);
    }
  }

  /**
   * Helper to write account snapshot performance metrics to MongoDB
   */
  private static async logPerformanceSnapshot(
    equity: number,
    cash: number,
    buyingPower: number,
    unrealizedPl: number
  ): Promise<void> {
    try {
      if (!AppDataSource.isInitialized) return;

      const snapshot = new BotPerformance();
      snapshot.equity = equity;
      snapshot.cash = cash;
      snapshot.buyingPower = buyingPower;
      snapshot.unrealizedPl = unrealizedPl;

      await AppDataSource.manager.save(snapshot);
      console.log("💾 Saved bot performance snapshot to MongoDB");
    } catch (e: any) {
      console.error("❌ Error saving performance snapshot to database:", e.message);
    }
  }
}
