import { MarketDataService } from "../services/marketData.service";
import { MarketDataReliabilityLayer } from "../services/MarketDataReliabilityLayer";
import { PriceEngine } from "../services/PriceEngine";
import { PositionRepairEngine } from "../services/PositionRepairEngine";
import { PriceConsistencyMonitor } from "../services/PriceConsistencyMonitor";
import { TrailingStopValidator } from "../services/TrailingStopValidator";
import { ReportGeneratorService } from "../services/ReportGeneratorService";
import { UpstoxService } from "../services/upstox.service";
import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { TradeLog } from "../entity/TradeLog";
import axios from "axios";

// Mock axios and ws
jest.mock("axios");

let mockWsInstance: any = null;
jest.mock("ws", () => {
  const mockWebSocket: any = jest.fn().mockImplementation(() => {
    const ws = {
      on: jest.fn((event: string, cb: Function) => {
        ws.listeners[event] = cb;
      }),
      close: jest.fn(),
      ping: jest.fn(),
      send: jest.fn(),
      readyState: 1,
      listeners: {} as Record<string, Function>,
    };
    mockWsInstance = ws;
    return ws;
  });
  mockWebSocket.CONNECTING = 0;
  mockWebSocket.OPEN = 1;
  mockWebSocket.CLOSING = 2;
  mockWebSocket.CLOSED = 3;
  return mockWebSocket;
});

// Setup Hoisted Jest Mock Functions
var mockSaveFn = jest.fn((entity: any): Promise<any> => Promise.resolve(entity));
var mockFindFn = jest.fn((): Promise<any[]> => Promise.resolve([]));
var mockFindOneFn = jest.fn((): Promise<any> => Promise.resolve(null));
var mockDeleteFn = jest.fn((): Promise<any> => Promise.resolve({}));

var mockRepositoryObj = {
  save: mockSaveFn,
  find: mockFindFn,
  findOne: mockFindOneFn,
  delete: mockDeleteFn,
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
    getLastTradedPrice: jest.fn((): Promise<number> => Promise.resolve(1000)),
  },
}));

jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn((): Promise<void> => Promise.resolve()),
  },
}));

describe("Paper Trading Environment Certification Test Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mockWsInstance = null;
    MarketDataReliabilityLayer.reset();
    PriceConsistencyMonitor.reset();
    
    // Reset MarketDataService singleton state
    const service = MarketDataService.getInstance();
    (service as any).isConnected = false;
    (service as any).reconnectAttempts = 0;
    (service as any).ws = null;
    (service as any).subscribedSymbols = new Set();
    
    // Re-initialize Reliability Layer
    MarketDataReliabilityLayer.initialize(["INFY"]);
  });

  afterAll(() => {
    MarketDataReliabilityLayer.stop();
    PriceConsistencyMonitor.stop();
    PriceEngine.stop();
    TrailingStopValidator.stopDailyAuditJob();
  });

  // Test 1: MarketDataService connection and WebSocket subscription
  test("1. MarketDataService should authorize and establish real WebSocket connection", async () => {
    const mockAuthorizeResponse = {
      data: {
        data: {
          authorized_redirect_uri: "wss://api.upstox.com/feed/market-data-feed/ws",
        },
      },
    };
    (axios.get as jest.Mock).mockResolvedValue(mockAuthorizeResponse);

    const service = MarketDataService.getInstance();
    await service.connect();

    expect(axios.get).toHaveBeenCalledWith(
      "https://api.upstox.com/v3/feed/market-data-feed/authorize",
      expect.any(Object)
    );
    expect(mockWsInstance).not.toBeNull();
    expect(mockWsInstance.on).toHaveBeenCalledWith("open", expect.any(Function));
    expect(mockWsInstance.on).toHaveBeenCalledWith("message", expect.any(Function));

    // Simulate websocket open
    mockWsInstance.listeners["open"]();
    expect(service.healthCheck().connected).toBe(true);
  });

  // Test 2: MarketDataService retry on authorization failure
  test("2. MarketDataService should handle authorization errors gracefully", async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error("Auth Token Expired"));

    const service = MarketDataService.getInstance();
    const reconnectSpy = jest.spyOn(service as any, "reconnect").mockImplementation(() => {});

    // Start connection attempt (will reject and trigger reconnect in try-catch)
    await service.connect();

    // Verify it attempted to reconnect
    expect(reconnectSpy).toHaveBeenCalled();

    reconnectSpy.mockRestore();
  });

  // Test 3: Position Repair Engine scans and repairs corrupted positions
  test("3. PositionRepairEngine should flag and repair corrupted positions when peak is unrealistic", async () => {
    const corruptedPosition: ActivePosition = {
      _id: {} as any,
      symbol: "INFY",
      qty: 4,
      avgEntryPrice: 1118.60,
      peakPrice: 1471.63, // Corrupted peak price (exceeds Math.max(avgEntryPrice, ltp) * 1.05)
      trailingStopPrice: 1442.20,
      stopLossPercent: 0.02,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindFn.mockResolvedValue([corruptedPosition]);
    jest.spyOn(PriceEngine, "getLastPrice").mockResolvedValue(1118.60); // Real LTP

    const report = await PositionRepairEngine.repairAllActivePositions();

    expect(report.corruptedPositionsCount).toBe(1);
    expect(report.repairedPositionsCount).toBe(1);
    
    // Verify recalculated peak: Math.max(avgEntryPrice, ltp) = 1118.60
    expect(mockSaveFn).toHaveBeenCalled();
    const savedPos = mockSaveFn.mock.calls[0][0];
    expect(savedPos.symbol).toBe("INFY");
    expect(savedPos.peakPrice).toBe(1118.60);
    expect(savedPos.trailingStopPrice).toBe(1118.60 * 0.98); // 1096.228
  });

  // Test 4: Price Consistency Monitor detects divergence
  test("4. PriceConsistencyMonitor should halt trading if divergence exceeds 2%", async () => {
    jest.spyOn(PriceEngine, "getLastPriceSync").mockReturnValue(1120.00); // Websocket Cached
    (UpstoxService.getLastTradedPrice as jest.Mock).mockResolvedValue(1050.00); // Real REST LTP (~6.6% divergence)

    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(false);

    await PriceConsistencyMonitor.auditConsistency();

    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(true);
  });

  // Test 5: Trailing Stop Validator checks active positions
  test("5. TrailingStopValidator should flag positions with invalid mathematical relationships", async () => {
    const invalidPosition: ActivePosition = {
      _id: {} as any,
      symbol: "INFY",
      qty: 10,
      avgEntryPrice: 100,
      peakPrice: 90, // EntryPrice (100) > PeakPrice (90) - Mathematically invalid!
      trailingStopPrice: 88,
      stopLossPercent: 0.02,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindFn.mockResolvedValue([invalidPosition]);
    jest.spyOn(PriceEngine, "getLastPrice").mockResolvedValue(100.00);

    const validationResults = await TrailingStopValidator.validatePositions();

    expect(validationResults[0].isValid).toBe(false);
    expect(validationResults[0].failures.length).toBeGreaterThan(0);
    // Verifies it triggered repair
    expect(mockSaveFn).toHaveBeenCalled();
  });

  // Test 6: EOD Report Generator compiles metrics
  test("6. ReportGeneratorService should compile trading session metrics and pass validations", async () => {
    const mockBuyLog = new TradeLog();
    mockBuyLog.symbol = "INFY";
    mockBuyLog.action = "BUY";
    mockBuyLog.qty = 10;
    mockBuyLog.price = 100;
    mockBuyLog.totalAmount = 1000;
    mockBuyLog.createdAt = new Date();
    mockBuyLog.signalReason = "SMA Crossover Entry";

    const mockSellLog = new TradeLog();
    mockSellLog.symbol = "INFY";
    mockSellLog.action = "SELL";
    mockSellLog.qty = 10;
    mockSellLog.price = 105;
    mockSellLog.totalAmount = 1050;
    mockSellLog.createdAt = new Date(Date.now() + 600000); // 10 minutes later
    mockSellLog.signalReason = "Trailing Stop triggered";

    mockFindFn.mockResolvedValueOnce([mockBuyLog, mockSellLog]); // For trade logs
    mockFindFn.mockResolvedValueOnce([]); // For decisions
    mockFindFn.mockResolvedValueOnce([]); // For active open positions

    const report = await ReportGeneratorService.generateEodReport();

    expect(report.buyExecutions).toBe(1);
    expect(report.sellExecutions).toBe(1);
    expect(report.trailingStopExits).toBe(1);
    expect(report.averageHoldTimeMinutes).toBe(10); // 10 minutes difference
    expect(report.certified).toBe(true);
  });
});
