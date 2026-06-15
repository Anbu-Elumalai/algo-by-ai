import { HealthService } from "../services/health.service";
import { OrderExecutionManager } from "../services/OrderExecutionManager";
import { OrderLifecycleManager } from "../services/OrderLifecycleManager";
import { PositionRecoveryManager } from "../services/PositionRecoveryManager";
import { PositionReconciliationService } from "../services/positionReconciliation.service";
import { MarketDataReliabilityLayer } from "../services/MarketDataReliabilityLayer";
import { PriceEngine } from "../services/PriceEngine";
import { UpstoxService } from "../services/upstox.service";
import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { RefreshToken } from "../entity/RefreshToken";
import { PriceConsistencyMonitor } from "../services/PriceConsistencyMonitor";
import { TrailingStopValidator } from "../services/TrailingStopValidator";
import { TradingLoopService } from "../services/tradingLoop.service";

// Define mock variables with 'var' to hoist their declarations to the very top, avoiding TDZ reference errors
var mockSaveFn = jest.fn((entity: any): Promise<any> => Promise.resolve(entity));
var mockFindFn = jest.fn((): Promise<any[]> => Promise.resolve([]));
var mockFindOneFn = jest.fn((): Promise<any> => Promise.resolve(null));
var mockUpdateFn = jest.fn((): Promise<any> => Promise.resolve({}));
var mockDeleteFn = jest.fn((): Promise<any> => Promise.resolve({}));
var mockClearFn = jest.fn((): Promise<any> => Promise.resolve({}));
var mockCountFn = jest.fn((): Promise<number> => Promise.resolve(0));

var mockRepositoryObj = {
  save: mockSaveFn,
  find: mockFindFn,
  findOne: mockFindOneFn,
  update: mockUpdateFn,
  delete: mockDeleteFn,
  clear: mockClearFn,
  count: mockCountFn,
};

jest.mock("../data-source", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn(() => mockRepositoryObj),
    manager: {
      save: mockSaveFn,
    },
  },
}));

jest.mock("../services/upstox.service", () => ({
  UpstoxService: {
    placeOrder: jest.fn((): Promise<any> => Promise.resolve({ order_id: "mock-order-123", status: "success" })),
    getOrderStatus: jest.fn((): Promise<any> => Promise.resolve({ status: "complete" })),
    getPositions: jest.fn((): Promise<any[]> => Promise.resolve([])),
    getPosition: jest.fn((): Promise<any> => Promise.resolve(null)),
    getLastTradedPrice: jest.fn((): Promise<number> => Promise.resolve(100)),
    getAccount: jest.fn((): Promise<any> => Promise.resolve({ equity: 100000, cash: 100000, buyingPower: 500000 })),
  },
}));

jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn((): Promise<void> => Promise.resolve()),
  },
}));

// Retain compatibility with existing test logic variables
const mockSave = mockSaveFn;
const mockFind = mockFindFn;
const mockFindOne = mockFindOneFn;
const mockUpdate = mockUpdateFn;
const mockDelete = mockDeleteFn;
const mockClear = mockClearFn;
const mockCount = mockCountFn;

describe("Algorithmic Trading Bot Failure Simulation Test Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    HealthService.reportSuccess(); // reset circuit breaker
    PositionReconciliationService.setSystemHalted(false);
    PositionReconciliationService.clearCache();
    MarketDataReliabilityLayer.reset();
  });

  afterAll(() => {
    MarketDataReliabilityLayer.stop();
    PriceConsistencyMonitor.stop();
    PriceEngine.stop();
    TrailingStopValidator.stopDailyAuditJob();
  });

  // 1. API Outage & Circuit Breaker Test
  test("1. Circuit Breaker should trip to OPEN after 3 consecutive failures", async () => {
    expect(HealthService.isTradingAllowed()).toBe(true);

    await HealthService.reportFailure("Test API", "Network timeout");
    await HealthService.reportFailure("Test API", "Network timeout");
    await HealthService.reportFailure("Test API", "Network timeout");

    expect(HealthService.getCircuitState()).toBe("OPEN");
    expect(HealthService.isTradingAllowed()).toBe(false);
  });

  // 2. Circuit Breaker Recovery Test
  test("2. Circuit Breaker should recover to CLOSED on reportSuccess", async () => {
    await HealthService.reportFailure("Test API", "Network timeout");
    await HealthService.reportFailure("Test API", "Network timeout");
    await HealthService.reportFailure("Test API", "Network timeout");

    expect(HealthService.getCircuitState()).toBe("OPEN");

    await HealthService.reportSuccess();

    expect(HealthService.getCircuitState()).toBe("CLOSED");
    expect(HealthService.isTradingAllowed()).toBe(true);
  });

  // 3. Idempotency Lock & Cache Test
  test("3. OrderExecutionManager should place order once for duplicate idempotency keys", async () => {
    const key = "idempotency-key-unique-1";
    
    // First call
    const firstResult = await OrderExecutionManager.executeOrder(key, "corr-1", "INFY", 100, "BUY");
    expect(firstResult.order_id).toBe("mock-order-123");
    
    // Mock save to cache/DB return
    mockFindOne.mockImplementationOnce(() => Promise.resolve({
      idempotencyKey: key,
      status: "SUCCESS",
      brokerOrderId: "mock-order-123",
    }));

    // Second call
    const secondResult = await OrderExecutionManager.executeOrder(key, "corr-1", "INFY", 100, "BUY");
    expect(secondResult.order_id).toBe("mock-order-123");
    expect(secondResult.alreadyExecuted).toBe(true);
    
    expect(UpstoxService.placeOrder).toHaveBeenCalledTimes(1);
  });

  // 4. Mutex Serialization Test
  test("4. OrderExecutionManager should serialize order submissions per symbol", async () => {
    const orderPromises = [
      OrderExecutionManager.executeOrder("k-1", "c-1", "TCS", 10, "BUY"),
      OrderExecutionManager.executeOrder("k-2", "c-2", "TCS", 10, "BUY"),
    ];

    await Promise.all(orderPromises);
    expect(UpstoxService.placeOrder).toHaveBeenCalledTimes(2);
  });

  // 5. Partial Fill Weighted Entry Price Calculation Test
  test("5. OrderLifecycleManager should calculate weighted average prices correctly", async () => {
    const activePositionMock: ActivePosition = {
      _id: {} as any,
      symbol: "INFY",
      qty: 20,
      avgEntryPrice: 100,
      peakPrice: 100,
      trailingStopPrice: 98,
      stopLossPercent: 0.02,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindOne.mockImplementation(() => Promise.resolve(activePositionMock));
    mockFindOne.mockImplementationOnce(() => Promise.resolve({
      brokerOrderId: "ord-999",
      symbol: "INFY",
      side: "BUY",
      status: "PARTIALLY_FILLED",
    }));

    // Perform partial fill: 30 shares at 105
    await OrderLifecycleManager.handleOrderUpdate("ord-999", {
      status: "PARTIALLY_FILLED",
      filledQty: 30,
      avgPrice: 105,
      totalQty: 100,
    });

    expect(mockSave).toHaveBeenCalled();
    const savedPosition = mockSave.mock.calls[mockSave.mock.calls.length - 1][0];
    
    // P_avg_new = (100 * 20 + 105 * 30) / (20 + 30) = (2000 + 3150) / 50 = 5150 / 50 = 103
    expect(savedPosition.qty).toBe(50);
    expect(savedPosition.avgEntryPrice).toBe(103);
  });

  // 6. Partial Fill Position Deletion Test
  test("6. OrderLifecycleManager should delete active positions on full SELL fill", async () => {
    const activePositionMock: ActivePosition = {
      _id: {} as any,
      symbol: "RELIANCE",
      qty: 50,
      avgEntryPrice: 2400,
      peakPrice: 2400,
      trailingStopPrice: 2352,
      stopLossPercent: 0.02,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindOne.mockImplementation(() => Promise.resolve(activePositionMock));
    mockFindOne.mockImplementationOnce(() => Promise.resolve({
      brokerOrderId: "ord-888",
      symbol: "RELIANCE",
      side: "SELL",
      status: "SUBMITTED",
    }));

    await OrderLifecycleManager.handleOrderUpdate("ord-888", {
      status: "FILLED",
      filledQty: 50,
      avgPrice: 2420,
      totalQty: 50,
    });

    expect(mockDelete).toHaveBeenCalled();
  });

  // 7. Startup Reconciliation - CASE 2 (DB Missing) Test
  test("7. Startup Reconciliation should recover database position when missing (CASE 2)", async () => {
    mockFind.mockResolvedValue([]); // DB empty
    (UpstoxService.getPositions as jest.Mock).mockResolvedValue([{
      symbol: "INFY",
      qty: 100,
      avgEntryPrice: 1450,
      currentPrice: 1450,
      unrealizedPl: 0,
    }]);
    (UpstoxService.getPosition as jest.Mock).mockResolvedValue({
      symbol: "INFY",
      qty: 100,
      avgEntryPrice: 1450,
      currentPrice: 1450,
      unrealizedPl: 0,
    });

    await PositionReconciliationService.reconcilePositions();

    expect(mockSave).toHaveBeenCalled();
    const matchedCall = mockSave.mock.calls.find((call: any) => call[0] && call[0].symbol === "INFY");
    expect(matchedCall).toBeDefined();
    const restoredPos = matchedCall ? matchedCall[0] : undefined;
    expect(restoredPos).toBeDefined();
    expect(restoredPos?.qty).toBe(100);
  });

  // 8. Startup Reconciliation - CASE 3 & 4 (Halt State) Test
  test("8. Startup Reconciliation should halt trading on position quantity mismatch (CASE 4)", async () => {
    mockFind.mockResolvedValue([{
      symbol: "INFY",
      qty: 80, // DB has 80
    }]);
    (UpstoxService.getPositions as jest.Mock).mockResolvedValue([{
      symbol: "INFY",
      qty: 100, // Broker has 100
      avgEntryPrice: 1450,
    }]);

    await PositionReconciliationService.reconcilePositions();

    expect(PositionReconciliationService.isSystemHalted()).toBe(true);
  });

  // 9. WebSocket Heartbeat Monitor Failover & Pause Test
  test("9. MarketDataReliabilityLayer should pause trading when WebSocket ticks stop", async () => {
    // Inject health status
    const mockHealthStatus = {
      stale: true, // Websocket connection froze
      lastTickAgeMs: 6000,
      feedDivergencePercent: 0,
      lagMs: 6000,
    };
    jest.spyOn(PriceEngine, "getPriceHealth").mockResolvedValue(mockHealthStatus);

    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(false);

    // Run audit
    await (MarketDataReliabilityLayer as any).auditFeedReliability();

    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(true);
  });

  // 10. WebSocket Heartbeat Monitor Divergence Pause Test
  test("10. MarketDataReliabilityLayer should pause trading on feed price divergence > 1%", async () => {
    const mockHealthStatus = {
      stale: false,
      lastTickAgeMs: 100,
      feedDivergencePercent: 1.5, // 1.5% divergence
      lagMs: 100,
    };
    jest.spyOn(PriceEngine, "getPriceHealth").mockResolvedValue(mockHealthStatus);

    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(false);

    // Run audit
    await (MarketDataReliabilityLayer as any).auditFeedReliability();

    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(true);
  });

  // 11. Position Manager Cache Sync & Trailing Stop Loss Trigger
  test("11. PositionReconciliationService cache updates instantly and trailing stop triggers SELL", async () => {
    const mockActivePos: ActivePosition = {
      _id: {} as any,
      symbol: "RELIANCE",
      qty: 10,
      avgEntryPrice: 1000,
      peakPrice: 1000,
      trailingStopPrice: 980,
      stopLossPercent: 0.02,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Save position (updates DB and memory cache)
    await PositionReconciliationService.savePosition(mockActivePos);

    // Assert cache is updated instantly (Zero lag!)
    expect(PositionReconciliationService.getCachedPosition("RELIANCE")).toBe(mockActivePos);

    // Setup mocks for PositionGuard check and execution flow
    (UpstoxService.getPositions as jest.Mock).mockResolvedValue([{
      symbol: "RELIANCE",
      qty: 10,
      avgEntryPrice: 1000,
      currentPrice: 970,
      unrealizedPl: -300
    }]);
    mockFindOne.mockResolvedValue(mockActivePos);

    // Set active
    (TradingLoopService as any).isActive = true;

    // Simulate price tick that breaches stop loss (970 <= 980)
    await (TradingLoopService as any).processRealtimePriceUpdate("RELIANCE", 970);

    // Assert that the deletePosition was called and positions are deleted
    expect(mockDelete).toHaveBeenCalled();
    expect(PositionReconciliationService.getCachedPosition("RELIANCE")).toBeUndefined();
  });
});
