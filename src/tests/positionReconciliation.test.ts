/**
 * Position Reconciliation & Recovery System Test Suite
 *
 * Tests the 3-way reconciliation engine (DB <-> Cache <-> Broker) under all
 * critical failure scenarios. Validates that:
 *   - CASE 1: Healthy state passes without halting.
 *   - CASE 2: DB-missing position is auto-repaired from broker data.
 *   - CASE 3: Broker-missing position (ghost) triggers a system halt.
 *   - CASE 4: Quantity mismatch triggers a system halt.
 *   - Capital Protection: A halted system blocks ALL orders via PositionGuardService.
 */

import { PositionReconciliationService } from "../services/positionReconciliation.service";
import { PositionGuardService } from "../services/positionGuard.service";
import { ActivePosition } from "../entity/ActivePosition";
import { PaperBrokerPosition } from "../entity/PaperBrokerPosition";

// ──────────────────────────────────────────────────────────────────────────────
// MOCKS
// ──────────────────────────────────────────────────────────────────────────────

// Shared mock repository state — set per test
let mockDbPositions: ActivePosition[] = [];
let mockBrokerPositions: PaperBrokerPosition[] = [];
let mockTradeLogs: any[] = [];

const mockSaveFn = jest.fn((entity: any): Promise<any> => Promise.resolve(entity));
const mockDeleteFn = jest.fn((): Promise<any> => Promise.resolve({}));
const mockClearFn = jest.fn((): Promise<void> => Promise.resolve());

// Each entity type gets its own find/findOne behaviour
function makeMockRepo(entityClass: any) {
  return {
    save: mockSaveFn,
    delete: mockDeleteFn,
    clear: mockClearFn,
    find: jest.fn((): Promise<any[]> => {
      if (entityClass.name === "ActivePosition") return Promise.resolve([...mockDbPositions]);
      if (entityClass.name === "PaperBrokerPosition") return Promise.resolve([...mockBrokerPositions]);
      return Promise.resolve([]);
    }),
    findOne: jest.fn(({ where }: any): Promise<any> => {
      const sym = where?.symbol;
      if (entityClass.name === "ActivePosition")
        return Promise.resolve(mockDbPositions.find(p => p.symbol === sym) ?? null);
      if (entityClass.name === "TradeLog")
        return Promise.resolve(mockTradeLogs.find(t => t.symbol === sym && t.action === where?.action) ?? null);
      return Promise.resolve(null);
    }),
  };
}

jest.mock("../data-source", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn((entityClass: any) => makeMockRepo(entityClass)),
  },
}));

// UpstoxService returns broker positions from the mockBrokerPositions array
jest.mock("../services/upstox.service", () => ({
  UpstoxService: {
    getPositions: jest.fn((): Promise<any[]> =>
      Promise.resolve(
        mockBrokerPositions.map(p => ({
          symbol: p.symbol,
          qty: p.qty,
          avgEntryPrice: p.avgEntryPrice,
          currentPrice: p.currentPrice,
          unrealizedPl: p.unrealizedPl,
        }))
      )
    ),
    getPosition: jest.fn((sym: string): Promise<any> =>
      Promise.resolve(
        mockBrokerPositions.find(p => p.symbol.toUpperCase() === sym.toUpperCase())
          ? {
              symbol: sym,
              qty: mockBrokerPositions.find(p => p.symbol.toUpperCase() === sym.toUpperCase())!.qty,
              avgEntryPrice: mockBrokerPositions.find(p => p.symbol.toUpperCase() === sym.toUpperCase())!.avgEntryPrice,
              currentPrice: mockBrokerPositions.find(p => p.symbol.toUpperCase() === sym.toUpperCase())!.currentPrice,
              unrealizedPl: 0,
            }
          : null
      )
    ),
  },
}));

jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn((): Promise<void> => Promise.resolve()),
  },
}));

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────

function makeActivePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return Object.assign(new ActivePosition(), {
    _id: {} as any,
    symbol: "RELIANCE",
    qty: 10,
    avgEntryPrice: 2500,
    peakPrice: 2500,
    trailingStopPrice: 2450,
    stopLossPercent: 0.02,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function makePaperBrokerPosition(overrides: Partial<PaperBrokerPosition> = {}): PaperBrokerPosition {
  return Object.assign(new PaperBrokerPosition(), {
    _id: {} as any,
    symbol: "RELIANCE",
    qty: 10,
    avgEntryPrice: 2500,
    currentPrice: 2500,
    unrealizedPl: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST SUITE
// ──────────────────────────────────────────────────────────────────────────────

describe("Position Reconciliation & Recovery System", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset in-memory state
    mockDbPositions = [];
    mockBrokerPositions = [];
    mockTradeLogs = [];

    // Reset service state
    PositionReconciliationService.clearCache();
    PositionReconciliationService.setSystemHalted(false);
  });

  // ── CASE 1 ──────────────────────────────────────────────────────────────────
  describe("CASE 1 — Healthy State: DB=0, Broker=0", () => {
    test("reconcilePositions() should complete without halting when no positions exist", async () => {
      mockDbPositions = [];
      mockBrokerPositions = [];

      await PositionReconciliationService.reconcilePositions();

      expect(PositionReconciliationService.isSystemHalted()).toBe(false);
    });

    test("cache is rebuilt correctly reflecting empty state", async () => {
      await PositionReconciliationService.rebuildCache();
      expect(PositionReconciliationService.getCachedPositions()).toHaveLength(0);
    });
  });

  // ── CASE 1b ─────────────────────────────────────────────────────────────────
  describe("CASE 1b — Healthy State: DB=1, Broker=1, Cache=1 (all aligned)", () => {
    test("reconcilePositions() should pass with zero mismatches and NOT halt", async () => {
      mockDbPositions = [makeActivePosition()];
      mockBrokerPositions = [makePaperBrokerPosition()];

      await PositionReconciliationService.rebuildCache();
      await PositionReconciliationService.reconcilePositions();

      expect(PositionReconciliationService.isSystemHalted()).toBe(false);
      expect(PositionReconciliationService.getCachedPosition("RELIANCE")).toBeDefined();
    });
  });

  // ── CACHE REBUILD ───────────────────────────────────────────────────────────
  describe("Cache Recovery — rebuilds from DB after flush", () => {
    test("cache is rebuilt from DB after clearCache()", async () => {
      mockDbPositions = [makeActivePosition({ symbol: "TCS", qty: 5 })];

      PositionReconciliationService.clearCache();
      expect(PositionReconciliationService.getCachedPositions()).toHaveLength(0);

      await PositionReconciliationService.rebuildCache();
      expect(PositionReconciliationService.getCachedPositions()).toHaveLength(1);
      expect(PositionReconciliationService.getCachedPosition("TCS")).toBeDefined();
    });
  });

  // ── CASE 2 ──────────────────────────────────────────────────────────────────
  describe("CASE 2 — DB Missing: DB=0, Broker=1 (orphan at broker)", () => {
    test("reconcilePositions() should auto-repair the DB and NOT halt", async () => {
      mockDbPositions = [];
      mockBrokerPositions = [makePaperBrokerPosition({ symbol: "INFY", qty: 7, avgEntryPrice: 1500 })];
      mockTradeLogs = [
        {
          symbol: "INFY",
          action: "BUY",
          price: 1500,
          brokerOrderId: "paper-order-999",
          createdAt: new Date(),
        },
      ];

      await PositionReconciliationService.reconcilePositions();

      // System should NOT be halted — CASE 2 is auto-repairable
      expect(PositionReconciliationService.isSystemHalted()).toBe(false);

      // DB save should have been called to create the repaired position
      expect(mockSaveFn).toHaveBeenCalled();
      const savedArg = mockSaveFn.mock.calls.find(
        call => call[0]?.symbol === "INFY"
      )?.[0];
      expect(savedArg).toBeDefined();
      expect(savedArg.qty).toBe(7);
    });

    test("repairPosition() reconstructs entry from the last BUY trade log", async () => {
      mockDbPositions = [];
      mockTradeLogs = [
        {
          symbol: "WIPRO",
          action: "BUY",
          price: 460,
          brokerOrderId: "paper-order-abc",
          createdAt: new Date(),
        },
      ];

      const repaired = await PositionReconciliationService.repairPosition("WIPRO", 3, 460);

      expect(repaired).toBe(true);
      expect(mockSaveFn).toHaveBeenCalled();
      const savedArg = mockSaveFn.mock.calls[0][0];
      expect(savedArg.symbol).toBe("WIPRO");
      expect(savedArg.avgEntryPrice).toBe(460);
      expect(savedArg.trailingStopPrice).toBe(460 * 0.98);
    });
  });

  // ── CASE 3 ──────────────────────────────────────────────────────────────────
  describe("CASE 3 — Broker Missing: DB=1, Broker=0 (ghost in DB)", () => {
    test("reconcilePositions() MUST halt the system — capital is at risk", async () => {
      mockDbPositions = [makeActivePosition({ symbol: "HDFCBANK", qty: 5 })];
      mockBrokerPositions = []; // Broker shows nothing — position may have been closed externally

      await PositionReconciliationService.rebuildCache();
      await PositionReconciliationService.reconcilePositions();

      expect(PositionReconciliationService.isSystemHalted()).toBe(true);
    });

    test("PositionGuardService must block ALL orders when system is halted", async () => {
      PositionReconciliationService.setSystemHalted(true);

      const buyResult = await PositionGuardService.verifyOrderAllowed("HDFCBANK", "BUY");
      const sellResult = await PositionGuardService.verifyOrderAllowed("HDFCBANK", "SELL");

      expect(buyResult.allowed).toBe(false);
      expect(buyResult.reason).toContain("SYSTEM HALTED");
      expect(sellResult.allowed).toBe(false);
      expect(sellResult.reason).toContain("SYSTEM HALTED");
    });
  });

  // ── CASE 4 ──────────────────────────────────────────────────────────────────
  describe("CASE 4 — Quantity Mismatch: DB=5 shares, Broker=10 shares", () => {
    test("reconcilePositions() MUST halt the system — state is inconsistent", async () => {
      mockDbPositions = [makeActivePosition({ symbol: "WIPRO", qty: 5 })];
      mockBrokerPositions = [makePaperBrokerPosition({ symbol: "WIPRO", qty: 10 })];

      await PositionReconciliationService.rebuildCache();
      await PositionReconciliationService.reconcilePositions();

      expect(PositionReconciliationService.isSystemHalted()).toBe(true);
    });

    test("validatePosition() returns invalid with detailed mismatch reason", async () => {
      mockDbPositions = [makeActivePosition({ symbol: "WIPRO", qty: 5 })];
      // Seed cache manually with qty=5 to simulate DB-cache alignment
      const cachedPos = makeActivePosition({ symbol: "WIPRO", qty: 5 });
      PositionReconciliationService.setCachedPosition(cachedPos);
      // Broker shows qty=10
      mockBrokerPositions = [makePaperBrokerPosition({ symbol: "WIPRO", qty: 10 })];

      const result = await PositionReconciliationService.validatePosition("WIPRO");

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Mismatch");
    });
  });

  // ── CAPITAL PROTECTION ──────────────────────────────────────────────────────
  describe("Capital Protection Gate", () => {
    test("PositionGuardService blocks BUY when system is already halted", async () => {
      PositionReconciliationService.setSystemHalted(true);
      const result = await PositionGuardService.verifyOrderAllowed("RELIANCE", "BUY");

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/SYSTEM HALTED/);
    });

    test("PositionGuardService allows BUY when system is healthy and no existing position", async () => {
      PositionReconciliationService.setSystemHalted(false);
      mockDbPositions = [];
      mockBrokerPositions = [];

      const result = await PositionGuardService.verifyOrderAllowed("RELIANCE", "BUY");

      expect(result.allowed).toBe(true);
    });

    test("PositionGuardService blocks duplicate BUY when broker already holds position", async () => {
      PositionReconciliationService.setSystemHalted(false);
      mockDbPositions = [makeActivePosition({ symbol: "TCS", qty: 3 })];
      mockBrokerPositions = [makePaperBrokerPosition({ symbol: "TCS", qty: 3 })];

      const result = await PositionGuardService.verifyOrderAllowed("TCS", "BUY");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("active position");
    });
  });
});
