import { calculateSMA, calculateRSI, analyzeMovingAverageCrossover } from "./strategyEngine";

describe("Shared Strategy Engine Tests", () => {
  describe("calculateSMA", () => {
    it("should return 0 if there are insufficient data points", () => {
      const result = calculateSMA([100, 101], 5);
      expect(result).toBe(0);
    });

    it("should correctly compute the moving average of the specified window", () => {
      const result = calculateSMA([10, 20, 30, 40, 50], 3);
      expect(result).toBe((30 + 40 + 50) / 3);
    });
  });

  describe("calculateRSI", () => {
    it("should return 50 (neutral) if there are insufficient data points", () => {
      const result = calculateRSI([100, 101], 14);
      expect(result).toBe(50);
    });

    it("should return 100 if there are only price gains", () => {
      const result = calculateRSI([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250], 14);
      expect(result).toBe(100);
    });
  });

  describe("analyzeMovingAverageCrossover", () => {
    it("should signal HOLD if there are insufficient prices", () => {
      const result = analyzeMovingAverageCrossover([100, 101], 9, 21);
      expect(result.signal).toBe("HOLD");
      expect(result.reason).toContain("Insufficient data");
    });

    it("should signal HOLD when no crossover has occurred", () => {
      const prices = Array(30).fill(100);
      const result = analyzeMovingAverageCrossover(prices, 9, 21);
      expect(result.signal).toBe("HOLD");
    });
  });
});
