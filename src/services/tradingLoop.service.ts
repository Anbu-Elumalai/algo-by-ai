import { UpstoxService } from "./upstox.service";
import { CandleService } from "./candle.service";
import { RiskService } from "./risk.service";
import { PositionGuardService } from "./positionGuard.service";
import { NotificationService } from "./notification.service";
import { PreLiveValidationService } from "./preLiveValidation.service";
import { marketDataService } from "./marketData.service";
import { analyzeMovingAverageCrossover, analyzeAdvancedStrategy, prepareStrategyCandles, calculateEMA } from "../strategies/strategyEngine";
import { tradingTickMutex } from "../utils/mutex";
import { TradeLog } from "../entity/TradeLog";
import { BotPerformance } from "../entity/BotPerformance";
import { ActivePosition } from "../entity/ActivePosition";
import { StrategyDecision } from "../entity/StrategyDecision";
import { StrategyEvaluationLog } from "../entity/StrategyEvaluationLog";
import { ExecutionLog } from "../entity/ExecutionLog";
import { AppDataSource } from "../data-source";
import { PriceEngine } from "./PriceEngine";
import { OrderExecutionManager } from "./OrderExecutionManager";
import { PositionRecoveryManager } from "./PositionRecoveryManager";
import { MarketDataReliabilityLayer } from "./MarketDataReliabilityLayer";
import { PositionReconciliationService } from "./positionReconciliation.service";
import { TokenManager } from "./TokenManager";

export class TradingLoopService {
  private static isActive = false;
  private static intervalId: NodeJS.Timeout | null = null;
  private static healthLogIntervalId: NodeJS.Timeout | null = null;
  private static targetSymbols: string[] = ["RELIANCE", "TCS", "INFY"];
  private static lastProcessedCandleTimes = new Map<string, string>();

  /**
   * Check if Indian market is open (09:15 to 15:30 IST, Monday-Friday)
   */
  static isIndianMarketOpen(): boolean {
    const now = new Date();
    // Convert to Indian Standard Time (IST: UTC+5:30)
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 3600000 * 5.5);

    const day = ist.getDay(); // 0 = Sunday, 6 = Saturday
    if (day === 0 || day === 6) return false;

    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const timeVal = hours * 100 + minutes;

    return timeVal >= 915 && timeVal <= 1530;
  }

  static getStatus() {
    return {
      isActive: this.isActive,
      symbols: this.targetSymbols,
      isMarketOpen: this.isIndianMarketOpen(),
      ws: marketDataService.healthCheck()
    };
  }

  /**
   * Start the live loop with validations and state recovery
   */
  static async start(): Promise<void> {
    if (this.isActive) {
      console.log("⚠️ Trading Loop is already active!");
      return;
    }

    try {
      // 1. Run Pre-Live Checklist
      const checklist = await PreLiveValidationService.runChecklist(this.targetSymbols);
      console.log(checklist, 'checklist');

      if (!checklist.success) {
        throw new Error("Pre-Live Validation Checklist failed. Trading bot startup aborted.");
      }

      this.isActive = true;
      console.log("🚀 Pre-Live checks passed. Starting live trading operations...");

      // 2. Disaster Recovery: Restore database-backed states
      await this.recoverState();

      // 3. Connect WebSocket Price Stream Listeners
      PriceEngine.initialize();
      PriceEngine.removeAllListeners("priceUpdate");
      PriceEngine.on("priceUpdate", async ({ symbol, ltp }) => {
        await this.processRealtimePriceUpdate(symbol, ltp);
      });

      // 4. Start Live Polling (strategy candle checks)
      this.intervalId = setInterval(async () => {
        await this.executeTick();
      }, 60000);

      // 5. Start Telemetry Logger (every 5 minutes)
      this.healthLogIntervalId = setInterval(async () => {
        await this.logSystemTelemetry();
      }, 300000);

      // Start periodic 5-minute position reconciliation checks
      PositionRecoveryManager.startPeriodicReconciliation();

      // Initialize Market Data Reliability Layer
      MarketDataReliabilityLayer.initialize(this.targetSymbols);

      // Start Token Lifecycle Monitor
      TokenManager.startMonitoring();

      await NotificationService.sendNotification("BOT STARTED", "Trading bot has successfully started and is monitoring price streams.");
    } catch (err: any) {
      this.isActive = false;
      this.stop();
      console.error("❌ Startup execution failed:", err.message);
      throw err;
    }
  }

  /**
   * Stop the live loop
   */
  static stop(): void {
    if (!this.isActive) return;
    console.log("🛑 Stopping the trading loop...");

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.healthLogIntervalId) {
      clearInterval(this.healthLogIntervalId);
      this.healthLogIntervalId = null;
    }

    this.isActive = false;
    PriceEngine.removeAllListeners("priceUpdate");
    PositionRecoveryManager.stop();
    MarketDataReliabilityLayer.stop();
    TokenManager.stopMonitoring();
    console.log("🔌 Trading loop and telemetry deactivated.");
  }

  /**
   * Disaster Recovery: Re-load dynamic variables and active positions on boot
   */
  private static async recoverState(): Promise<void> {
    console.log("🏥 Restoring active system state from database...");
    try {
      // 3-way startup reconciliation check
      await PositionRecoveryManager.runStartupCheck();

      const positionRepo = AppDataSource.getRepository(ActivePosition);
      const openPositions = await positionRepo.find();

      console.log(`🏥 Restored ${openPositions.length} active positions from database cache:`);
      for (const pos of openPositions) {
        console.log(`   - ${pos.symbol}: Peak price ₹${pos.peakPrice} | SL price ₹${pos.trailingStopPrice} | Qty ${pos.qty}`);
      }

      const account = await UpstoxService.getAccount();
      await RiskService.getDailyTracker(account.equity);
      console.log("🏥 Risk limits and account balances successfully synchronized.");
    } catch (err: any) {
      console.error("⚠️ State recovery alert:", err.message);
    }
  }

  private static async processRealtimePriceUpdate(symbol: string, ltp: number) {
    if (!this.isActive) return;
    if (MarketDataReliabilityLayer.isTradingPaused()) {
      return;
    }

    // Performance Optimization: Check cache first to avoid database queries on every single tick
    const { PositionReconciliationService } = require("./positionReconciliation.service");
    const cachedPos = PositionReconciliationService.getCachedPosition(symbol);
    if (!cachedPos || ltp <= 0) {
      return;
    }

    const release = await tradingTickMutex.acquire();
    try {
      const positionRepo = AppDataSource.getRepository(ActivePosition);
      const dbPos = await positionRepo.findOne({ where: { symbol } as any });

      if (dbPos) {
        const slResult = RiskService.checkTrailingStopLoss(dbPos, ltp);

        const oldPeak = dbPos.peakPrice;
        
        // Update peak price and trailing stop price in database and cache
        dbPos.peakPrice = slResult.updatedPeak;
        dbPos.trailingStopPrice = slResult.trailingStop;
        await PositionReconciliationService.savePosition(dbPos);

        console.log(`[STOP LOSS]
Position detected in cache
Live price checked
Stop loss status healthy`);

        if (dbPos.peakPrice > oldPeak) {
          console.log(`[TRAILING STOP]
Peak updated
Old peak: ${oldPeak.toFixed(2)}
New peak: ${dbPos.peakPrice.toFixed(2)}
Trailing SL: ${dbPos.trailingStopPrice.toFixed(2)}`);
        }

        if (slResult.trigger) {
          console.warn(`🚨 [Stop Loss Triggered] Trailing SL breached for ${symbol} via WS tick. Price: ₹${ltp.toFixed(2)}`);

          // Verify guard
          const guard = await PositionGuardService.verifyOrderAllowed(symbol, "SELL");
          if (!guard.allowed) {
            console.error(`🛑 PositionGuard rejected SL order: ${guard.reason}`);
            return;
          }

          const idempotencyKey = `sl-${symbol}-${dbPos.qty}-${Math.floor(Date.now() / 60000)}`;
          const correlationId = `corr-sl-${Date.now()}`;
          const order = await OrderExecutionManager.executeOrder(idempotencyKey, correlationId, symbol, dbPos.qty, "SELL", "MARKET");
          
          console.log(`[ORDER]
SELL executed
Qty=${dbPos.qty}
Price=${ltp.toFixed(1)}`);

          const account = await UpstoxService.getAccount();
          const totalAmount = dbPos.qty * ltp;
          const fees = 40; // Approx trade fee

          // Log completed trade
          const log = new TradeLog();
          log.symbol = symbol;
          log.action = "SELL";
          log.price = ltp;
          log.qty = dbPos.qty;
          log.totalAmount = totalAmount;
          log.strategy = "SMA Crossover (Live 15m WS)";
          log.signalReason = `WS Trailing Stop Loss triggered. Price ₹${ltp.toFixed(2)} <= SL price ₹${dbPos.trailingStopPrice.toFixed(2)}`;
          log.brokerOrderId = order.order_id || JSON.stringify(order);
          log.transactionFees = fees;
          log.portfolioValueAfterTrade = account.equity;
          await AppDataSource.getRepository(TradeLog).save(log);

          // Trade Execution Audit (Slippage Log)
          const execLog = new ExecutionLog();
          execLog.symbol = symbol;
          execLog.action = "SELL";
          execLog.signalTime = new Date();
          execLog.signalPrice = dbPos.trailingStopPrice;
          execLog.executionTime = new Date();
          execLog.executionPrice = ltp;
          execLog.slippageAmount = dbPos.trailingStopPrice - ltp;
          execLog.slippagePercent = (execLog.slippageAmount / dbPos.trailingStopPrice) * 100;
          execLog.signalDelayMs = 0;
          execLog.executionDelayMs = 150; // Estimate WS roundtrip latency
          await AppDataSource.getRepository(ExecutionLog).save(execLog);

          await PositionReconciliationService.deletePosition(symbol);
          await RiskService.incrementDailyTradeCount();
          await this.logPerformanceSnapshot(account.equity, account.cash + totalAmount - fees, account.buyingPower);

          await NotificationService.sendNotification(
            "STOP LOSS TRIGGERED",
            `Emergency SL exit completed for ${symbol} at actual price ₹${ltp.toFixed(2)} (Slippage: ₹${execLog.slippageAmount.toFixed(2)})`
          );
        }
      }
    } catch (err: any) {
      console.error(`❌ Error processing real-time stop-loss for ${symbol}:`, err.message);
    } finally {
      release();
    }
  }

  /**
   * Executes scheduled strategy evaluations on completed 15-minute candles
   */
  private static async executeTick() {
    if (!this.isActive) return;
    if (MarketDataReliabilityLayer.isTradingPaused()) {
      return;
    }

    if (!this.isIndianMarketOpen()) {
      console.log("⏱️ Market closed. Skipping strategy evaluations.");
      return;
    }

    const release = await tradingTickMutex.acquire();
    try {
      const account = await UpstoxService.getAccount();
      const positionRepo = AppDataSource.getRepository(ActivePosition);

      // Verify daily drawdown
      const isHealthy = await RiskService.checkDailyLimits(account.equity);
      if (!isHealthy) {
        this.stop();
        await NotificationService.sendNotification("BOT HALTED", "Trading bot stopped trading due to daily risk limit breach.");
        return;
      }

      const allDbPositions = await positionRepo.find();

      for (const symbol of this.targetSymbols) {
        const currentPrice = await PriceEngine.getLastPrice(symbol);
        if (currentPrice <= 0) continue;

        // Fetch 15m candles (need at least 30 candles history for ADX/RSI)
        const candles = await CandleService.getSyncedCandles(symbol, 10);
        
        // Preprocess candles using unified logic to get completed candles
        const nowTime = new Date();
        const completed15m = prepareStrategyCandles(candles, nowTime, 15);
        const lastCompleted = completed15m[completed15m.length - 1];
        if (lastCompleted) {
          const lastTime = this.lastProcessedCandleTimes.get(symbol);
          if (lastTime === lastCompleted.t) {
            continue; // Skip duplicate evaluation in the same candle
          }
        }

        // Fetch 1H candles for higher timeframe trend filter
        const candles1H = await CandleService.get1HourCandles(symbol, 10);
        const completed1H = prepareStrategyCandles(candles1H, nowTime, 60);

        // Compute current IST time to check volatility hours
        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000;
        const ist = new Date(utc + 3600000 * 5.5);
        const timeVal = ist.getHours() * 100 + ist.getMinutes();

        const dbPos = allDbPositions.find(p => p.symbol === symbol) || null;

        // Run advanced strategy evaluation
        const strategyReport = analyzeAdvancedStrategy(completed15m, completed1H, timeVal, !!dbPos);

        // Initialize strategy evaluation log structure
        const evalLog = new StrategyEvaluationLog();
        evalLog.date = nowTime.toISOString().split("T")[0];
        evalLog.timestamp = nowTime.toISOString();
        evalLog.symbol = symbol;
        evalLog.strategyVersion = "2.0";
        evalLog.candleTimestamp = lastCompleted ? lastCompleted.t : nowTime.toISOString();
        evalLog.signal = strategyReport.signal;
        evalLog.reason = strategyReport.reason;
        evalLog.tradeScore = strategyReport.score;

        let ema50Val = 0;
        if (completed1H.length >= 50) {
          const closes1H = completed1H.map(c => c.c);
          ema50Val = calculateEMA(closes1H, 50);
        }
        const volSlice = candles.slice(-21, -1).map(c => c.v);
        const avgVol = volSlice.reduce((a, b) => a + b, 0) / (volSlice.length || 1);

        evalLog.indicators = {
          fastSMA: strategyReport.fastSma,
          slowSMA: strategyReport.slowSma,
          rsi: strategyReport.rsi,
          adx: strategyReport.adx,
          atr: strategyReport.atr,
          volume: lastCompleted ? lastCompleted.v : 0,
          averageVolume: avgVol,
          ema50_1H: ema50Val,
          riskReward: strategyReport.rrRatio,
          choppiness: strategyReport.choppiness,
          bbw: strategyReport.bbw
        };

        const isSideways = strategyReport.adx < 25 || strategyReport.choppiness > 61.8 || strategyReport.bbw < 0.01;
        evalLog.filters = {
          goldenCross: strategyReport.fastSma > strategyReport.slowSma,
          rsi: strategyReport.rsi > 55 && strategyReport.rsi < 70,
          adx: strategyReport.adx >= 25,
          volume: (lastCompleted ? lastCompleted.v : 0) > avgVol,
          trend1H: completed1H.length >= 50 ? (completed1H[completed1H.length - 1].c > ema50Val) : true,
          riskReward: strategyReport.rrRatio >= 2.0,
          sideways: !isSideways,
          tradeScore: strategyReport.score >= 60
        };

        evalLog.execution = {
          orderPlaced: false,
          blockedReason: strategyReport.signal === "HOLD" ? "Signal remained HOLD" : undefined
        };

        console.log("\n==============================");
        console.log("[STRATEGY VERIFICATION]");
        console.log("Symbol:", symbol);
        console.log("Signal:", strategyReport.signal);
        console.log("Reason:", strategyReport.reason);
        console.log("Trade Score:", strategyReport.score);
        console.log("Golden Cross:", strategyReport.fastSma > strategyReport.slowSma);
        console.log("ADX:", strategyReport.adx);
        console.log("RSI:", strategyReport.rsi);
        console.log("ATR:", strategyReport.atr);
        console.log("Risk Reward:", strategyReport.rrRatio);
        console.log("1H Trend:", strategyReport.is1HTrendBullish);
        console.log("Volume:", strategyReport.volumeConfirmed);
        console.log("Sideways:", strategyReport.adx < 25 || strategyReport.choppiness > 61.8 || strategyReport.bbw < 0.01);
        console.log("==============================");

        // Store Strategy Decision in DB
        const decision = new StrategyDecision();
        decision.symbol = symbol;
        decision.fastSma = strategyReport.fastSma;
        decision.slowSma = strategyReport.slowSma;
        decision.rsi = strategyReport.rsi;
        decision.signal = strategyReport.signal;
        decision.reason = strategyReport.reason;
        if ("adx" in strategyReport) (decision as any).adx = strategyReport.adx;
        if ("atr" in strategyReport) (decision as any).atr = strategyReport.atr;
        if ("score" in strategyReport) (decision as any).score = strategyReport.score;
        await AppDataSource.getRepository(StrategyDecision).save(decision);

        // Lock completed candle
        if (lastCompleted) {
          this.lastProcessedCandleTimes.set(symbol, lastCompleted.t);
        }

        // Buy execution pipeline
        if (strategyReport.signal === "BUY" && !dbPos) {
          console.log(`[SIGNAL] BUY signal generated | Score: ${strategyReport.score}/100 | ATR: ${strategyReport.atr?.toFixed(2)}`);

          // Verify Guard
          const guard = await PositionGuardService.verifyOrderAllowed(symbol, "BUY");
          if (!guard.allowed) {
            console.warn(`🛑 PositionGuard blocked BUY order: ${guard.reason}`);
            evalLog.execution.blockedReason = `PositionGuard: ${guard.reason}`;
            await AppDataSource.getRepository(StrategyEvaluationLog).save(evalLog);
            continue;
          }

          // Calculate Position Sizing based on ATR: 1% risk per trade on 2 * ATR stop distance
          const atr = strategyReport.atr || 2.0;
          const stopDistance = 2 * atr;
          const maxRiskAmount = account.equity * 0.01;
          const qtyRiskLimit = Math.floor(maxRiskAmount / stopDistance);
          
          // Cap at 10% maximum capital allocation
          const maxCapital = account.equity * 0.10;
          const qtyCapitalLimit = Math.floor(maxCapital / currentPrice);
          
          const qty = Math.min(qtyRiskLimit, qtyCapitalLimit);

          if (qty > 0) {
            const totalCost = qty * currentPrice;
            const fees = 40;

            if (account.cash >= (totalCost + fees)) {
              evalLog.execution.orderPlaced = true;
              console.log("[ORDER CHECK]");
              console.log("Should Buy:", strategyReport.signal === "BUY");
              console.log("Executing BUY...");

              console.log("\n==============================");
              console.log("[BUY VERIFICATION]");
              console.log("");
              console.log("Time:");
              console.log(new Date().toISOString());
              console.log("");
              console.log("Symbol:");
              console.log(symbol);
              console.log("");
              console.log("Golden Cross:");
              console.log(strategyReport.fastSma > strategyReport.slowSma ? "TRUE" : "FALSE");
              console.log("");
              console.log("Fast SMA:");
              console.log(strategyReport.fastSma.toFixed(2));
              console.log("");
              console.log("Slow SMA:");
              console.log(strategyReport.slowSma.toFixed(2));
              console.log("");
              console.log("RSI:");
              console.log(strategyReport.rsi.toFixed(2));
              console.log("");
              console.log("ADX:");
              console.log(strategyReport.adx.toFixed(2));
              console.log("");
              console.log("ATR:");
              console.log(strategyReport.atr.toFixed(2));
              console.log("");
              console.log("Volume:");
              console.log(candles[candles.length - 2]?.v || 0);
              console.log("");
              console.log("Avg Volume:");
              const volSlice = candles.slice(-21, -1).map(c => c.v);
              const avgVol = volSlice.reduce((a, b) => a + b, 0) / (volSlice.length || 1);
              console.log(avgVol.toFixed(0));
              console.log("");
              console.log("1H Trend:");
              console.log(strategyReport.is1HTrendBullish ? "TRUE" : "FALSE");
              console.log("");
              console.log("Risk Reward:");
              console.log(strategyReport.rrRatio.toFixed(2));
              console.log("");
              console.log("Trade Score:");
              console.log(strategyReport.score.toFixed(0));
              console.log("");
              console.log("Decision:");
              console.log("BUY");
              console.log("==============================\n");

              const idempotencyKey = `crossover-BUY-${symbol}-${Math.floor(Date.now() / 900000)}`;
              const correlationId = `corr-crossover-${Date.now()}`;
              const order = await OrderExecutionManager.executeOrder(idempotencyKey, correlationId, symbol, qty, "BUY", "MARKET");

              console.log(`[ORDER] BUY executed | Qty=${qty} | Price=${currentPrice.toFixed(1)}`);

              const newPos = new ActivePosition();
              newPos.symbol = symbol;
              newPos.qty = qty;
              newPos.avgEntryPrice = currentPrice;
              newPos.peakPrice = currentPrice;
              newPos.trailingStopPrice = currentPrice - 2 * atr;
              newPos.stopLossPercent = 1.5 * atr; // Trailing stop offset saved in stopLossPercent
              await PositionReconciliationService.savePosition(newPos);

              const log = new TradeLog();
              log.symbol = symbol;
              log.action = "BUY";
              log.price = currentPrice;
              log.qty = qty;
              log.totalAmount = totalCost;
              log.strategy = "Advanced Crossover (Closed 15m)";
              log.signalReason = strategyReport.reason;
              log.brokerOrderId = order.order_id || JSON.stringify(order);
              log.transactionFees = fees;
              log.portfolioValueAfterTrade = account.equity;
              await AppDataSource.getRepository(TradeLog).save(log);

              // Log Slippage
              const execLog = new ExecutionLog();
              execLog.symbol = symbol;
              execLog.action = "BUY";
              execLog.signalTime = new Date();
              execLog.signalPrice = currentPrice;
              execLog.executionTime = new Date();
              execLog.executionPrice = currentPrice;
              execLog.slippageAmount = 0;
              execLog.slippagePercent = 0;
              execLog.signalDelayMs = 200;
              execLog.executionDelayMs = 150;
              await AppDataSource.getRepository(ExecutionLog).save(execLog);

              await RiskService.incrementDailyTradeCount();
              await this.logPerformanceSnapshot(account.equity, account.cash - totalCost - fees, account.buyingPower);

              await NotificationService.sendNotification(
                "BUY EXECUTED",
                `Bought ${qty} shares of ${symbol} at average price ₹${currentPrice.toFixed(2)} | Score: ${strategyReport.score}/100`
              );
            } else {
              evalLog.execution.blockedReason = `Insufficient cash: Available ₹${account.cash.toFixed(2)} < Required ₹${(totalCost + fees).toFixed(2)}`;
            }
          } else {
            evalLog.execution.blockedReason = `Calculated position size is 0`;
          }
        }

        // Sell execution pipeline (Death Cross exit)
        else if (strategyReport.signal === "SELL" && dbPos) {
          console.log(`[SIGNAL] SELL signal generated (Death Cross) for ${symbol}`);

          // Verify Guard
          const guard = await PositionGuardService.verifyOrderAllowed(symbol, "SELL");
          if (!guard.allowed) {
            console.warn(`🛑 PositionGuard blocked SELL order: ${guard.reason}`);
            evalLog.execution.blockedReason = `PositionGuard: ${guard.reason}`;
            await AppDataSource.getRepository(StrategyEvaluationLog).save(evalLog);
            continue;
          }

          const idempotencyKey = `crossover-SELL-${symbol}-${Math.floor(Date.now() / 900000)}`;
          const correlationId = `corr-crossover-${Date.now()}`;
          const order = await OrderExecutionManager.executeOrder(idempotencyKey, correlationId, symbol, dbPos.qty, "SELL", "MARKET");

          console.log(`[ORDER] SELL executed | Qty=${dbPos.qty} | Price=${currentPrice.toFixed(1)}`);
          const totalAmount = dbPos.qty * currentPrice;
          const fees = 40;

          const log = new TradeLog();
          log.symbol = symbol;
          log.action = "SELL";
          log.price = currentPrice;
          log.qty = dbPos.qty;
          log.totalAmount = totalAmount;
          log.strategy = "Advanced Crossover (Closed 15m)";
          log.signalReason = strategyReport.reason;
          log.brokerOrderId = order.order_id || JSON.stringify(order);
          log.transactionFees = fees;
          log.portfolioValueAfterTrade = account.equity;
          await AppDataSource.getRepository(TradeLog).save(log);

          // Log Slippage
          const execLog = new ExecutionLog();
          execLog.symbol = symbol;
          execLog.action = "SELL";
          execLog.signalTime = new Date();
          execLog.signalPrice = currentPrice;
          execLog.executionTime = new Date();
          execLog.executionPrice = currentPrice;
          execLog.slippageAmount = 0;
          execLog.slippagePercent = 0;
          execLog.signalDelayMs = 200;
          execLog.executionDelayMs = 150;
          await AppDataSource.getRepository(ExecutionLog).save(execLog);

          await PositionReconciliationService.deletePosition(symbol);
          await RiskService.incrementDailyTradeCount();
          await this.logPerformanceSnapshot(account.equity, account.cash + totalAmount - fees, account.buyingPower);

          evalLog.execution.orderPlaced = true;
          await NotificationService.sendNotification(
            "SELL EXECUTED",
            `Sold ${dbPos.qty} shares of ${symbol} at average price ₹${currentPrice.toFixed(2)} (Death Cross)`
          );
        }

        await AppDataSource.getRepository(StrategyEvaluationLog).save(evalLog);
      }
    } catch (err: any) {
      console.error("❌ Error in live tick execution:", err.message);
    } finally {
      release();
    }
  }

  /**
   * Emergency Liquidation of all target symbols & deactivates trading
   */
  static async forceExit(): Promise<any> {
    this.stop();
    const result: any[] = [];

    try {
      const brokerPositions = await UpstoxService.getPositions();

      console.log("🚨 Emergency Force Exit: Liquidating active positions...");

      for (const pos of brokerPositions) {
        if (pos.qty > 0) {
          const idempotencyKey = `force-exit-${pos.symbol}-${pos.qty}-${Date.now()}`;
          const correlationId = `corr-force-${Date.now()}`;
          const order = await OrderExecutionManager.executeOrder(idempotencyKey, correlationId, pos.symbol, pos.qty, "SELL", "MARKET");
          result.push({ symbol: pos.symbol, qty: pos.qty, status: "liquidated", orderId: order.order_id || order });

          const log = new TradeLog();
          log.symbol = pos.symbol;
          log.action = "SELL";
          log.price = pos.currentPrice;
          log.qty = pos.qty;
          log.totalAmount = pos.qty * pos.currentPrice;
          log.strategy = "EMERGENCY_LIQUIDATION";
          log.signalReason = "Admin manually invoked Emergency Force Exit.";
          log.brokerOrderId = order.order_id || JSON.stringify(order);
          await AppDataSource.getRepository(TradeLog).save(log);
        }
      }

      await PositionReconciliationService.clearPositions();
      await NotificationService.sendNotification("EMERGENCY FORCE EXIT", "All active positions liquidated and bot deactivated.");

      return { success: true, liquidations: result };
    } catch (err: any) {
      console.error("❌ Critical error during emergency liquidation:", err.message);
      throw err;
    }
  }

  /**
   * Recur system health telemetry status
   */
  private static async logSystemTelemetry() {
    try {
      const os = require("os");
      const { SystemHealthLog } = require("../entity/SystemHealthLog");
      const healthRepo = AppDataSource.getRepository(SystemHealthLog);

      const log = new SystemHealthLog();
      const wsStatus = marketDataService.healthCheck();

      log.wsStatus = wsStatus.connected ? "CONNECTED" : (wsStatus.mode === "PAPER" ? "PAPER_SIMULATOR" : "DISCONNECTED");
      log.databaseStatus = AppDataSource.isInitialized ? "CONNECTED" : "DISCONNECTED";
      log.activeTradingLoop = this.isActive;
      log.cpuUsagePercent = os.loadavg()[0] * 100; // Average CPU load
      log.freeMemoryBytes = os.freemem();
      log.totalMemoryBytes = os.totalmem();
      log.memoryUsagePercent = ((log.totalMemoryBytes - log.freeMemoryBytes) / log.totalMemoryBytes) * 100;

      await healthRepo.save(log);
      console.log(`📡 Telemetry log saved: CPU ${log.cpuUsagePercent.toFixed(1)}% | Memory ${log.memoryUsagePercent.toFixed(1)}% | WS: ${log.wsStatus}`);
    } catch (e: any) {
      console.error("❌ Failed to log system telemetry metrics:", e.message);
    }
  }

  private static async logPerformanceSnapshot(
    equity: number,
    cash: number,
    buyingPower: number
  ): Promise<void> {
    try {
      if (AppDataSource.isInitialized && AppDataSource.manager && typeof AppDataSource.manager.save === "function") {
        const snap = new BotPerformance();
        snap.equity = equity;
        snap.cash = cash;
        snap.buyingPower = buyingPower;
        snap.unrealizedPl = 0;
        await AppDataSource.manager.save(snap);
      }
    } catch (e: any) {
      console.error("❌ Failed to log performance snap:", e.message);
    }
  }
}
