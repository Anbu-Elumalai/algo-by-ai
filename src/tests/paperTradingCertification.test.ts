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
    MarketDataReliabilityLayer.reset();
    MarketDataService.simulatedPrices.clear();
    PriceConsistencyMonitor.reset();
    // Re-initialize Reliability Layer
    MarketDataReliabilityLayer.initialize(["INFY"]);
  });

  // Test 1: Simulator startup dynamic initialization success
  test("1. Simulator should fetch live LTP from Upstox and initialize successfully", async () => {
    (UpstoxService.getLastTradedPrice as jest.Mock).mockResolvedValue(1118.60);

    const service = MarketDataService.getInstance();
    // Simulate subscribed symbol list
    (service as any).subscribedSymbols = new Set(["INFY"]);

    await (service as any).startPaperStream();

    expect(UpstoxService.getLastTradedPrice).toHaveBeenCalledWith("INFY");
    expect(MarketDataService.simulatedPrices.get("INFY")).toBe(1118.60);
    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(false);

    // Stop intervals generated during test
    (service as any).paperIntervals.forEach(clearInterval);
  });

  // Test 2: Simulator startup dynamic initialization retry and failure handling
  test("2. Simulator should retry 3 times on LTP fetch failure, pause trading, and trigger alert", async () => {
    (UpstoxService.getLastTradedPrice as jest.Mock).mockRejectedValue(new Error("Upstox connection timeout"));

    const service = MarketDataService.getInstance();
    (service as any).subscribedSymbols = new Set(["INFY"]);

    await (service as any).startPaperStream();

    // Verify 3 retries occurred
    expect(UpstoxService.getLastTradedPrice).toHaveBeenCalledTimes(3);
    // Verify trading is paused due to simulator failure
    expect(MarketDataReliabilityLayer.isTradingPaused()).toBe(true);
  });

  // Test 3: Position Repair Engine scans and repairs corrupted positions
  test("3. PositionRepairEngine should flag and repair corrupted positions when peak is unrealistic", async () => {
    const corruptedPosition: ActivePosition = {
      _id: {} as any,
      symbol: "INFY",
      qty: 4,
      avgEntryPrice: 1118.60,
      peakPrice: 1471.63, // Corrupted peak price (exceeds 1.05 * 1118.60)
      trailingStopPrice: 1442.20,
      stopLossPercent: 0.02,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindFn.mockResolvedValue([corruptedPosition]);
    (UpstoxService.getLastTradedPrice as jest.Mock).mockResolvedValue(1118.60); // Real LTP

    const report = await PositionRepairEngine.repairAllActivePositions();

    expect(report.corruptedPositionsCount).toBe(1);
    expect(report.repairedPositionsCount).toBe(1);
    
    // Verify recalculated peak: Math.max(1118.60, 1118.60) = 1118.60
    expect(mockSaveFn).toHaveBeenCalled();
    const savedPos = mockSaveFn.mock.calls[0][0];
    expect(savedPos.symbol).toBe("INFY");
    expect(savedPos.peakPrice).toBe(1118.60);
    expect(savedPos.trailingStopPrice).toBe(1118.60 * 0.98); // 1096.228
  });

  // Test 4: Price Consistency Monitor detects divergence
  test("4. PriceConsistencyMonitor should halt trading if divergence exceeds 2%", async () => {
    // Inject prices that diverge
    jest.spyOn(PriceEngine, "getLastPriceSync").mockReturnValue(1120.00); // Cached
    MarketDataService.simulatedPrices.set("INFY", 1120.00);               // Simulator
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
    (UpstoxService.getLastTradedPrice as jest.Mock).mockResolvedValue(100.00);

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
