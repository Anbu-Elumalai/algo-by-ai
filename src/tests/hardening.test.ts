import { BoundedTTLCache } from "../middlewares/RateLimitMiddleware";
import { RiskService } from "../services/risk.service";
import { SystemHealthMonitor } from "../services/SystemHealthMonitor";
import { RuntimeAuditService } from "../services/RuntimeAuditService";
import { StrategyAnalyticsService } from "../services/StrategyAnalyticsService";
import { AuditScheduler } from "../services/AuditScheduler";

// Setup mocks
var mockSaveFn = jest.fn((entity: any): Promise<any> => Promise.resolve(entity));
var mockFindFn = jest.fn((): Promise<any[]> => Promise.resolve([]));
var mockFindOneFn = jest.fn((): Promise<any> => Promise.resolve(null));
var mockCountFn = jest.fn((): Promise<number> => Promise.resolve(0));

var mockRepositoryObj = {
  save: mockSaveFn,
  find: mockFindFn,
  findOne: mockFindOneFn,
  count: mockCountFn
};

jest.mock("../data-source", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn(() => mockRepositoryObj),
    manager: {
      save: mockSaveFn,
      query: jest.fn(() => Promise.resolve([]))
    }
  }
}));

jest.mock("../services/upstox.service", () => ({
  UpstoxService: {
    getAccount: jest.fn(() => Promise.resolve({ equity: 100000, cash: 100000, buyingPower: 500000 }))
  }
}));

jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn(() => Promise.resolve())
  }
}));

describe("Algorithmic Trading Hardening & Observability Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("BoundedTTLCache Rate Limiter", () => {
    it("should successfully set and get values within TTL", () => {
      const cache = new BoundedTTLCache<number>(5, 1000);
      cache.set("key1", 100);
      expect(cache.get("key1")).toBe(100);
    });

    it("should clean up / evict oldest values when max keys count limit exceeded", () => {
      const cache = new BoundedTTLCache<number>(2, 1000);
      cache.set("key1", 1);
      cache.set("key2", 2);
      cache.set("key3", 3); // triggers eviction of key1
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBe(2);
      expect(cache.get("key3")).toBe(3);
    });

    it("should expire values after TTL elapsed", async () => {
      const cache = new BoundedTTLCache<number>(5, 5); // 5ms TTL
      cache.set("key1", 42);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(cache.get("key1")).toBeUndefined();
    });
  });

  describe("Centralized Trailing Stop Logic", () => {
    it("should correctly compute trailing stop using ratio values", () => {
      const sl = RiskService.calculateTrailingStop(100, 0.02); // 2% stop
      expect(sl).toBe(98);
    });

    it("should correctly compute trailing stop using absolute distance values", () => {
      const sl = RiskService.calculateTrailingStop(100, 2.5); // ₹2.5 stop distance
      expect(sl).toBe(97.5);
    });
  });

  describe("SystemHealthMonitor", () => {
    it("should collect real-time system metrics", async () => {
      const report = await SystemHealthMonitor.getHealthReport();
      expect(report).toBeDefined();
      expect(report.cpu).toBeDefined();
      expect(report.memory).toBeDefined();
      expect(report.latency).toBeDefined();
    });
  });

  describe("Audit & Rollup Report Services", () => {
    it("should generate a complete RuntimeDailyAudit log schema structure", async () => {
      mockFindFn.mockResolvedValueOnce([]); // evalLogs
      mockFindFn.mockResolvedValueOnce([]); // dailyTrades
      mockFindOneFn.mockResolvedValueOnce({ startingEquity: 100000, currentEquity: 100000, isHalted: false }); // riskTracker
      mockCountFn.mockResolvedValueOnce(0); // open positions count

      const audit = await RuntimeAuditService.generateDailyAudit("2026-07-03");
      expect(audit).toBeDefined();
      expect(audit.date).toBe("2026-07-03");
      expect(audit.sessionInfo.tradingMode).toBeDefined();
      expect(audit.healthScore.overallScore).toBeDefined();
    });

    it("should generate a WeeklyAnalyticsReport aggregation structure", async () => {
      mockFindFn.mockResolvedValue([]); // allTrades, allEvals
      const weekReport = await StrategyAnalyticsService.generateWeeklyReport("2026-W27");
      expect(weekReport).toBeDefined();
      expect(weekReport.weekIdentifier).toBe("2026-W27");
      expect(weekReport.metrics.totalTrades).toBe(0);
    });

    it("should generate a MonthlyCertificationReport audit structure", async () => {
      mockFindFn.mockResolvedValue([]);
      const monthReport = await StrategyAnalyticsService.generateMonthlyReport("2026-07");
      expect(monthReport).toBeDefined();
      expect(monthReport.monthIdentifier).toBe("2026-07");
      expect(monthReport.scores.overallScore).toBeDefined();
    });
  });

  describe("AuditScheduler Utility", () => {
    it("should determine last day of month correctly", () => {
      const endJan = new Date("2026-01-30T12:00:00Z"); // Friday, Jan 30 is last trading day
      expect(AuditScheduler.isLastTradingDayOfMonth(endJan)).toBe(true);

      const midJan = new Date("2026-01-15T12:00:00Z");
      expect(AuditScheduler.isLastTradingDayOfMonth(midJan)).toBe(false);
    });
  });
});
