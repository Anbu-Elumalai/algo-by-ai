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
        await marketDataService.connect(true);
        marketDataService.subscribe(targetSymbols);

        if (!marketDataService.isWsOpen()) {
          throw new Error("WebSocket connection state is not OPEN.");
        }

        // Wait up to 5 seconds for the first ticks to arrive
        console.log("⏳ Waiting for initial WebSocket price ticks to arrive...");
        let ticksArrived = false;
        const { PriceEngine } = require("./PriceEngine");
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          let allTicksFresh = true;
          for (const symbol of targetSymbols) {
            const health = await PriceEngine.getPriceHealth(symbol);
            if (health.stale || health.lastTickAgeMs > 5000) {
              allTicksFresh = false;
              break;
            }
          }
          if (allTicksFresh) {
            ticksArrived = true;
            break;
          }
        }

        if (!ticksArrived) {
          throw new Error("Timeout waiting for active market data ticks. Check market hours and broker feed permissions.");
        }

        report.push("✓ WebSocket connection: LIVE (CONNECTED)");
      }
    } catch (err: any) {
      report.push(`✗ WebSocket connection: FAILED (${err.message})`);
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
      const positions = await UpstoxService.getPositions();
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
}
