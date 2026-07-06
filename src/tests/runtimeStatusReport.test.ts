import { RuntimeStatusReportScheduler } from "../services/RuntimeStatusReportScheduler";
import { RuntimeStatusReportService } from "../services/RuntimeStatusReportService";
import { AppDataSource } from "../data-source";
import { RuntimeStatusReport } from "../entity/RuntimeStatusReport";

describe("Runtime Status Report Tests", () => {
  
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
  });

  afterAll(async () => {
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
