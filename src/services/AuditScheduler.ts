import { RuntimeAuditService } from "./RuntimeAuditService";
import { StrategyAnalyticsService } from "./StrategyAnalyticsService";

export class AuditScheduler {
  private static intervalId: NodeJS.Timeout | null = null;
  private static lastDailyRun = "";
  private static lastWeeklyRun = "";
  private static lastMonthlyRun = "";

  static getISTDate(): Date {
    const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
    return new Date(utc + 3600000 * 5.5);
  }

  static isLastTradingDayOfMonth(date: Date): boolean {
    const currentMonth = date.getMonth();
    const temp = new Date(date.getTime());
    // Find next trading day
    while (true) {
      temp.setDate(temp.getDate() + 1);
      const day = temp.getDay();
      if (day !== 0 && day !== 6) {
        return temp.getMonth() !== currentMonth;
      }
    }
  }

  static start(): void {
    if (this.intervalId) return;

    console.log("⏱️ AuditScheduler: Background timer registered.");
    this.intervalId = setInterval(async () => {
      try {
        const ist = this.getISTDate();
        const dateStr = ist.toISOString().split("T")[0];
        const hours = ist.getHours();
        const minutes = ist.getMinutes();
        const dayOfWeek = ist.getDay();

        // 1. Every Trading Day (Monday-Friday) at 15:45 IST
        if (dayOfWeek !== 0 && dayOfWeek !== 6 && hours === 15 && minutes === 45 && this.lastDailyRun !== dateStr) {
          console.log(`⏰ Triggering Scheduled Daily Audit for ${dateStr}...`);
          this.lastDailyRun = dateStr;
          await RuntimeAuditService.generateDailyAudit(dateStr);
        }

        // 2. Weekly (Saturday) at 15:45 IST
        if (dayOfWeek === 6 && hours === 15 && minutes === 45 && this.lastWeeklyRun !== dateStr) {
          console.log(`⏰ Triggering Scheduled Weekly Report for ${dateStr}...`);
          this.lastWeeklyRun = dateStr;
          const weekVal = `${ist.getFullYear()}-W${Math.ceil(ist.getDate() / 7)}`;
          await StrategyAnalyticsService.generateWeeklyReport(weekVal);
        }

        // 3. Monthly (Last Trading Day) at 15:45 IST
        if (dayOfWeek !== 0 && dayOfWeek !== 6 && hours === 15 && minutes === 45 && this.isLastTradingDayOfMonth(ist) && this.lastMonthlyRun !== dateStr) {
          console.log(`⏰ Triggering Scheduled Monthly Report for ${dateStr}...`);
          this.lastMonthlyRun = dateStr;
          const monthVal = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}`;
          await StrategyAnalyticsService.generateMonthlyReport(monthVal);
        }
      } catch (err: any) {
        console.error("❌ AuditScheduler execution error:", err.message);
      }
    }, 15000); // Check every 15s

    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("🔌 AuditScheduler timer stopped.");
    }
  }

  static async triggerManualDaily(dateStr: string) {
    return await RuntimeAuditService.generateDailyAudit(dateStr);
  }

  static async triggerManualWeekly(weekStr: string) {
    return await StrategyAnalyticsService.generateWeeklyReport(weekStr);
  }

  static async triggerManualMonthly(monthStr: string) {
    return await StrategyAnalyticsService.generateMonthlyReport(monthStr);
  }
}
