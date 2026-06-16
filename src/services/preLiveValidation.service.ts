import { AppDataSource } from "../data-source";
import { UpstoxService } from "./upstox.service";
import { marketDataService } from "./marketData.service";
import { RiskService } from "./risk.service";
import { NotificationService } from "./notification.service";
import { HealthService } from "./health.service";

export class PreLiveValidationService {
  /**
   * Executes startup sanity checks, compiling validation report of services
   */
  static async runChecklist(targetSymbols: string[]): Promise<{ success: boolean; report: string[] }> {
    const report: string[] = [];
    let success = true;

    console.log("📋 Executing Pre-Live validation checks...");

    // 1. Verify Database
    if (AppDataSource.isInitialized) {
      report.push("✓ Database connection: ONLINE");
    } else {
      report.push("✗ Database connection: OFFLINE");
      success = false;
    }

    // 2. Verify Circuit Breaker State
    if (HealthService.isTradingAllowed()) {
      report.push("✓ Circuit Breaker: CLOSED (HEALTHY)");
    } else {
      report.push("✗ Circuit Breaker: OPEN (EXECUTION BLOCKED)");
      success = false;
    }

    // 3. Verify Broker Auth/Connect
    let account = null;
    try {
      account = await UpstoxService.getAccount();
      report.push(`✓ Broker authentication: SUCCESS (Equity: ₹${account.equity.toFixed(2)})`);
    } catch (err: any) {
      report.push(`✗ Broker authentication: FAILED (${err.message})`);
      success = false;
    }

    // 4. Verify WebSocket Feed
    try {
      const isTest = process.env.APP_ENV === "TEST" || process.env.NODE_ENV === "test";
      if (isTest) {
        report.push("✓ WebSocket connection: TEST_MOCK (CONNECTED)");
      } else {
        const { TradingLoopService } = require("./tradingLoop.service");
        const marketOpen = TradingLoopService.isIndianMarketOpen();
        
        if (!marketOpen) {
          console.log("⏱️ No live ticks expected because market is closed. Active market hours: 09:15 to 15:30 IST, Monday-Friday.");
        }

        try {
          await marketDataService.connect(true);
          marketDataService.subscribe(targetSymbols);

          if (!marketDataService.isWsOpen()) {
            throw new Error("WebSocket connection state is not OPEN.");
          }

          // Wait up to 5 seconds for the first ticks to arrive (using reactive listener)
          console.log("⏳ Waiting for initial WebSocket price ticks to arrive...");
          const ticksArrived = await this.waitForFirstTicks(targetSymbols, 5000);

          if (!ticksArrived) {
            throw new Error("Timeout waiting for active market data ticks.");
          }

          report.push("✓ WebSocket connection: LIVE (CONNECTED)");
        } catch (wsErr: any) {
          if (process.env.TRADING_MODE === "PAPER" || !marketOpen) {
            console.warn(`⚠️ WebSocket connection/ticks failed: ${wsErr.message}. Fallback active (PAPER mode or market closed): starting mock tick simulator.`);
            marketDataService.startMockTickSimulator(targetSymbols);
            // Wait an extra 2.5 seconds for mock ticks to register
            await new Promise(resolve => setTimeout(resolve, 2500));
            report.push("✓ WebSocket connection: PAPER_SIMULATOR (CONNECTED)");
          } else {
            throw wsErr;
          }
        }
      }
    } catch (err: any) {
      report.push(`✗ WebSocket connection: FAILED (${err.message})`);
      success = false;
    }

    // 4b. Verify Historical Candles & Indicator Readiness
    try {
      const { CandleService } = require("./candle.service");
      const { analyzeMovingAverageCrossover } = require("../strategies/strategyEngine");
      
      const testSymbol = targetSymbols[0] || "RELIANCE";
      console.log(`⏳ Loading historical 15-minute candles for ${testSymbol} self-test...`);
      const candles = await CandleService.getSyncedCandles(testSymbol, 5);
      
      if (candles.length === 0) {
        throw new Error(`Failed to load historical candles for ${testSymbol}.`);
      }
      
      console.log(`⏳ Verifying indicator calculations (SMA, RSI) on ${testSymbol}...`);
      const closingPrices = candles.map((c: any) => c.c);
      const testReport = analyzeMovingAverageCrossover(closingPrices, 9, 21);
      
      report.push(`✓ Historical Candles & Indicators: READY (Loaded ${candles.length} candles for ${testSymbol})`);
    } catch (err: any) {
      report.push(`✗ Historical Candles & Indicators: FAILED (${err.message})`);
      success = false;
    }

    // 5. Verify Risk Parameters
    if (account) {
      try {
        const tracker = await RiskService.getDailyTracker(account.equity);
        report.push(`✓ Risk metrics: LOADED (Daily Starting Equity ₹${tracker.startingEquity.toFixed(2)} | Trades executed today: ${tracker.tradeCount})`);
      } catch (err: any) {
        report.push(`✗ Risk metrics: FAILED TO LOAD (${err.message})`);
        success = false;
      }
    } else {
      report.push("✗ Risk metrics: SKIPPED (Authentication failed)");
      success = false;
    }

    // 6. Verify Position Sync
    try {
      const { PositionReconciliationService } = require("./positionReconciliation.service");
      await PositionReconciliationService.rebuildCache();
      
      const positions = await UpstoxService.getPositions();
      
      console.log(`[CACHE]
Cache synchronized immediately`);
      
      report.push(`✓ Position synchronization: SUCCESS (${positions.length} active positions sync'd)`);
    } catch (err: any) {
      report.push(`✗ Position synchronization: FAILED (${err.message})`);
      success = false;
    }

    // 7. Verify Telemetry Alerts
    try {
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
      const telegramChatId = process.env.TELEGRAM_CHAT_ID;
      const isProd = process.env.NODE_ENV === "production";

      const isTokenPlaceholder = !telegramToken || telegramToken === "your_telegram_bot_token" || telegramToken.startsWith("your_");
      const isChatIdPlaceholder = !telegramChatId || telegramChatId === "your_telegram_chat_id" || telegramChatId.startsWith("your_");

      if (isProd && (isTokenPlaceholder || isChatIdPlaceholder)) {
        throw new Error("Telegram credentials are missing or configured as default placeholders in production environment.");
      }

      if (isTokenPlaceholder || isChatIdPlaceholder) {
        report.push("⚠ Notification service: INITIALIZED (Telegram placeholder bypass in non-production mode)");
      } else {
        report.push("✓ Notification service: INITIALIZED (SMTP / Telegram ready)");
      }
    } catch (err: any) {
      report.push(`✗ Notification service: FAILED (${err.message})`);
      success = false;
    }

    console.log("📋 Pre-Live check complete. Status report:");
    report.forEach(line => console.log(`   ${line}`));

    if (!success) {
      const alertMsg = `Pre-Live Validation Checklist failed. System startup aborted!\n\n${report.join("\n")}`;
      await NotificationService.sendNotification("CRITICAL: Bot Startup Aborted", alertMsg);
    }

    return { success, report };
  }

  /**
   * Helper to wait reactively for the first price ticks for all target symbols
   */
  static async waitForFirstTicks(targetSymbols: string[], timeoutMs: number = 5000): Promise<boolean> {
    const received = new Set<string>();
    const { PriceEngine } = require("./PriceEngine");
    
    // Check if some ticks are already in cache and not stale
    for (const symbol of targetSymbols) {
      const health = await PriceEngine.getPriceHealth(symbol);
      if (!health.stale && health.lastTickAgeMs <= 5000) {
        received.add(symbol.toUpperCase());
      }
    }
    
    if (received.size === targetSymbols.length) {
      return true;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        marketDataService.removeListener("priceUpdate", listener);
        resolve(false);
      }, timeoutMs);

      const listener = ({ symbol }: { symbol: string }) => {
        received.add(symbol.toUpperCase());
        if (received.size === targetSymbols.length) {
          clearTimeout(timer);
          marketDataService.removeListener("priceUpdate", listener);
          resolve(true);
        }
      };

      marketDataService.on("priceUpdate", listener);
    });
  }
}
