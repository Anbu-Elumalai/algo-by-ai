jest.mock("nodemailer", () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue({ messageId: "mock-message-id" })
  })
}));

jest.mock("axios", () => ({
  get: jest.fn().mockResolvedValue({
    data: {
      data: {
        candles: [
          ["2026-07-15T12:00:00Z", 100, 105, 95, 102, 1000]
        ]
      }
    }
  }),
  post: jest.fn().mockResolvedValue({ data: { success: true } })
}));

import { RuntimeStatusReportScheduler } from "../services/RuntimeStatusReportScheduler";
import { RuntimeStatusReportService } from "../services/RuntimeStatusReportService";
import { AppDataSource } from "../data-source";
import { RuntimeStatusReport } from "../entity/RuntimeStatusReport";
import { PriceEngine } from "../services/PriceEngine";

describe("Runtime Status Report Tests", () => {
  
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
  });

  afterAll(async () => {
    PriceEngine.stop();
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  });

  it("should correctly identify trading holidays in 2026", () => {
    expect(RuntimeStatusReportScheduler.isHoliday("2026-01-26")).toBe(true); // Republic Day
    expect(RuntimeStatusReportScheduler.isHoliday("2026-12-25")).toBe(true); // Christmas
    expect(RuntimeStatusReportScheduler.isHoliday("2026-07-06")).toBe(false); // Normal trading day
  });

  it("should generate a status report and save it to MongoDB", async () => {
    const report = await RuntimeStatusReportService.generateAndSendReport();
    
    expect(report).toBeDefined();
    expect(report._id).toBeDefined();
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(report.session.strategyVersion).toBe("2.0");

    // Fetch the report from database to verify persistence
    const reportRepo = AppDataSource.getRepository(RuntimeStatusReport);
    const persisted = await reportRepo.findOne({ where: { _id: report._id } as any });
    
    expect(persisted).toBeDefined();
    expect(persisted!.session.strategyVersion).toBe("2.0");
    
    // Clean up
    await reportRepo.delete(report._id);
  });
});
