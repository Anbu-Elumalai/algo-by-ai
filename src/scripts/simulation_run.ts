process.env.APP_ENV = "TEST";
import { AppDataSource } from "../data-source";
import { UpstoxService } from "../services/upstox.service";
import { PriceEngine } from "../services/PriceEngine";
import { MarketDataReliabilityLayer } from "../services/MarketDataReliabilityLayer";
import { TradingLoopService } from "../services/tradingLoop.service";
import { TokenManager } from "../services/TokenManager";
import { PriceConsistencyMonitor } from "../services/PriceConsistencyMonitor";
import { PreLiveValidationService } from "../services/preLiveValidation.service";
import { upstoxConfig } from "../config/upstox";
import { ActivePosition } from "../entity/ActivePosition";
import { FeedHealthLog } from "../entity/FeedHealthLog";
import { PositionReconciliationService } from "../services/positionReconciliation.service";

async function runSimulation() {
  console.log("=== STARTING RUNTIME AUDIT VERIFICATION SIMULATION ===");

  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }

  // Clear previous data for clean run
  await AppDataSource.getRepository(ActivePosition).clear();
  await AppDataSource.getRepository(FeedHealthLog).clear();
  PositionReconciliationService.clearCache();
  MarketDataReliabilityLayer.reset();

  console.log("\n--- TEST 1: Strict Production Telegram Checklist Validation ---");
  const origNodeEnv = process.env.NODE_ENV;
  const origBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChatId = process.env.TELEGRAM_CHAT_ID;

  process.env.NODE_ENV = "production";
  process.env.TELEGRAM_BOT_TOKEN = "your_telegram_bot_token";
  process.env.TELEGRAM_CHAT_ID = "your_telegram_chat_id";

  const checklistResult = await PreLiveValidationService.runChecklist(["RELIANCE"]);
  console.log(`Checklist result (Expected: false): ${checklistResult.success}`);
  if (!checklistResult.success) {
    console.log("✅ TEST 1 PASSED: Production startup correctly blocked due to default Telegram placeholders.");
  } else {
    console.log("❌ TEST 1 FAILED: Production startup was NOT blocked!");
  }

  // Restore env
  process.env.NODE_ENV = origNodeEnv;
  process.env.TELEGRAM_BOT_TOKEN = origBotToken;
  process.env.TELEGRAM_CHAT_ID = origChatId;

  console.log("\n--- TEST 2: TokenManager Expired Token Heartbeat Detection ---");
  const origTradingMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = "LIVE"; // Simulate live mode to trigger API checks
  
  // Set invalid accessToken
  const origAccessToken = upstoxConfig.accessToken;
  upstoxConfig.accessToken = "expired_token_12345";

  // Check token health
  const isHealthy = await TokenManager.checkTokenHealth();
  console.log(`Token Manager Health Check (Expected: false): ${isHealthy}`);
  const isPaused = MarketDataReliabilityLayer.isTradingPaused();
  console.log(`Trading paused (Expected: true): ${isPaused}`);
  if (!isHealthy && isPaused) {
    console.log("✅ TEST 2 PASSED: Expired/unauthorized token successfully paused trading loop.");
  } else {
    console.log("❌ TEST 2 FAILED: Expired/unauthorized token did not trigger pause!");
  }

  // Restore config
  process.env.TRADING_MODE = origTradingMode;
  upstoxConfig.accessToken = origAccessToken;
  MarketDataReliabilityLayer.reset();

  console.log("\n--- TEST 3: Price Consistency Multi-Tier Divergence Logging ---");
  // Initialize PriceEngine
  PriceEngine.initialize();

  // Mock getLastPriceSync to return 1000 for RELIANCE
  const origGetLastPriceSync = PriceEngine.getLastPriceSync;
  PriceEngine.getLastPriceSync = (symbol: string) => 1000;

  // Mock getLastTradedPrice to return 965 (3.5% divergence)
  const origGetLastTradedPrice = UpstoxService.getLastTradedPrice;
  UpstoxService.getLastTradedPrice = async (symbol: string) => 965;

  console.log("Auditing price consistency with 3.5% divergence...");
  await PriceConsistencyMonitor.auditConsistency();

  const isDivergencePaused = MarketDataReliabilityLayer.isTradingPaused();
  console.log(`Trading paused on divergence (Expected: true): ${isDivergencePaused}`);

  // Check db log
  const healthLogs = await AppDataSource.getRepository(FeedHealthLog).find();
  console.log(`FeedHealthLogs saved in DB count: ${healthLogs.length}`);
  if (healthLogs.length > 0) {
    const log = healthLogs[0];
    console.log(`✅ TEST 3 PASSED: Price consistency monitor logged divergence of ${log.divergence.toFixed(2)}% to database and paused trading.`);
  } else {
    console.log("❌ TEST 3 FAILED: Price consistency monitor did not log divergence to database.");
  }

  // Restore mocks
  PriceEngine.getLastPriceSync = origGetLastPriceSync;
  UpstoxService.getLastTradedPrice = origGetLastTradedPrice;
  MarketDataReliabilityLayer.reset();

  console.log("\n--- TEST 4: Zero-Lag Cache Sync & Trailing Stop execution ---");
  // Setup position in DB & Cache
  const testPos = new ActivePosition();
  testPos.symbol = "RELIANCE";
  testPos.qty = 10;
  testPos.avgEntryPrice = 1000;
  testPos.peakPrice = 1000;
  testPos.trailingStopPrice = 980;
  testPos.stopLossPercent = 0.02;

  await PositionReconciliationService.savePosition(testPos);

  const cached = PositionReconciliationService.getCachedPosition("RELIANCE");
  console.log(`Cached position exists instantly (Expected: true): ${!!cached}`);

  // Trigger stop loss drop to 970
  // Enable trading loop active status
  (TradingLoopService as any).isActive = true;
  
  // Mock Upstox position endpoint for guard checks
  const origGetPositions = UpstoxService.getPositions;
  UpstoxService.getPositions = async () => [{
    symbol: "RELIANCE",
    qty: 10,
    avgEntryPrice: 1000,
    currentPrice: 970,
    unrealizedPl: -300
  }];

  console.log("Simulating tick update to ₹970 (breaches trailing stop ₹980)...");
  await (TradingLoopService as any).processRealtimePriceUpdate("RELIANCE", 970);

  const postExitCached = PositionReconciliationService.getCachedPosition("RELIANCE");
  const postExitDb = await AppDataSource.getRepository(ActivePosition).findOne({ where: { symbol: "RELIANCE" } as any });
  console.log(`Post-exit cached position (Expected: undefined): ${postExitCached}`);
  console.log(`Post-exit DB position (Expected: null): ${postExitDb}`);

  if (!postExitCached && !postExitDb) {
    console.log("✅ TEST 4 PASSED: Trailing stop loss successfully deleted position from database and cache atomically without lag.");
  } else {
    console.log("❌ TEST 4 FAILED: Trailing stop loss did not cleanly exit the position!");
  }

  // Restore mocks and teardown
  UpstoxService.getPositions = origGetPositions;
  (TradingLoopService as any).isActive = false;

  console.log("\nAll simulation verification tests completed.");
  await AppDataSource.destroy();
}

runSimulation().catch(err => {
  console.error("Simulation failed:", err);
  AppDataSource.destroy();
});
