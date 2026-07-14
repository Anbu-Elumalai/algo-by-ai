import { WeeklyReportScheduler } from "../services/WeeklyReportScheduler";
import { WeeklyReportService } from "../services/WeeklyReportService";
import { AppDataSource } from "../data-source";
import { WeeklyStrategyReport } from "../entity/WeeklyStrategyReport";
import * as fs from "fs";

describe("Weekly Strategy Report Tests", () => {
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

  it("should correctly identify ISO week numbers", () => {
    // 2026-07-10 is Friday (Week 28 of 2026)
    const date = new Date("2026-07-10T10:00:00Z");
    const weekNo = WeeklyReportScheduler.getISOWeekNumber(date);
    expect(weekNo).toBe(28);
  });

  it("should correctly identify the last trading day of the week", () => {
    // 2026-07-10 is a Friday, and it is not a holiday
    const friday = new Date("2026-07-10T12:00:00Z");
    expect(WeeklyReportScheduler.isLastTradingDayOfWeek(friday)).toBe(true);

    // 2026-07-09 is a Thursday, and Friday is not a holiday
    const thursday = new Date("2026-07-09T12:00:00Z");
    expect(WeeklyReportScheduler.isLastTradingDayOfWeek(thursday)).toBe(false);

    // Let's test a week where Good Friday (2026-04-10) is a holiday.
    // Thursday (2026-04-09) should be the last trading day of the week.
    const goodFriday = new Date("2026-04-10T12:00:00Z");
    const HolyThursday = new Date("2026-04-09T12:00:00Z");
    expect(WeeklyReportScheduler.isLastTradingDayOfWeek(goodFriday)).toBe(false); // Holiday
    expect(WeeklyReportScheduler.isLastTradingDayOfWeek(HolyThursday)).toBe(true); // Last trading day of that week
  });

  it("should compile metrics and generate HTML & PDF reports", async () => {
    const week = "2026-W99";
    const report = await WeeklyReportService.generateWeeklyReport(week);

    expect(report).toBeDefined();
    expect(report._id).toBeDefined();
    expect(report.weekIdentifier).toBe(week);
    expect(fs.existsSync(report.pdfPath)).toBe(true);
    expect(fs.existsSync(report.htmlPath)).toBe(true);

    // Retrieve from database
    const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
    const persisted = await repo.findOne({ where: { weekIdentifier: week } as any });
    expect(persisted).toBeDefined();
    expect(persisted!.pdfPath).toBe(report.pdfPath);

    // Clean up files and database record
    if (fs.existsSync(report.pdfPath)) fs.unlinkSync(report.pdfPath);
    if (fs.existsSync(report.htmlPath)) fs.unlinkSync(report.htmlPath);
    await repo.delete(report._id);
  });
});
