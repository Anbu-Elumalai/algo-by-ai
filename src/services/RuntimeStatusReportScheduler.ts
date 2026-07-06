import { RuntimeStatusReportService } from "./RuntimeStatusReportService";

export class RuntimeStatusReportScheduler {
  private static intervalId: NodeJS.Timeout | null = null;
  private static lastRunKey = "";

  // Official NSE Trading Holidays in 2026 (YYYY-MM-DD)
  private static readonly TRADING_HOLIDAYS_2026 = new Set<string>([
    "2026-01-26", // Republic Day
    "2026-03-06", // Holi
    "2026-03-27", // Ramzan Id
    "2026-04-02", // Ram Navami
    "2026-04-10", // Good Friday
    "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
    "2026-05-01", // Maharashtra Day
    "2026-08-15", // Independence Day
    "2026-09-04", // Id-E-Milad
    "2026-10-02", // Mahatma Gandhi Jayanti
    "2026-10-22", // Dussehra
    "2026-11-12", // Diwali Laxmi Puja
    "2026-11-27", // Guru Nanak Jayanti
    "2026-12-25"  // Christmas
  ]);

  static isHoliday(dateStr: string): boolean {
    return this.TRADING_HOLIDAYS_2026.has(dateStr);
  }

  static getISTDate(d = new Date()): Date {
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    return new Date(utc + 3600000 * 5.5);
  }

  static start(): void {
    if (this.intervalId) return;

    console.log("⏱️ RuntimeStatusReportScheduler: Background timer registered.");

    this.intervalId = setInterval(async () => {
      try {
        const ist = this.getISTDate();
        const dayOfWeek = ist.getDay(); // 0 = Sunday, 6 = Saturday
        const dateStr = ist.toISOString().split("T")[0];
        const hours = ist.getHours();
        const minutes = ist.getMinutes();
        const timeKey = `${hours}:${minutes}`;

        // Define scheduled report times (IST)
        const scheduledTimes = ["09:15", "11:15", "13:15", "15:15", "15:35"];

        if (scheduledTimes.includes(timeKey)) {
          const runKey = `${dateStr}_${timeKey}`;
          if (this.lastRunKey === runKey) {
            return; // Already executed for this minute
          }

          console.log(`⏱️ RuntimeStatusReportScheduler: Checking run conditions for ${runKey}...`);

          // 1. Avoid Weekends
          if (dayOfWeek === 0 || dayOfWeek === 6) {
            console.log(`⏱️ RuntimeStatusReportScheduler: Skipping run. Today is a weekend (${dateStr}).`);
            this.lastRunKey = runKey; // mark run as skipped
            return;
          }

          // 2. Avoid Trading Holidays
          if (this.isHoliday(dateStr)) {
            console.log(`⏱️ RuntimeStatusReportScheduler: Skipping run. Today is an official NSE trading holiday (${dateStr}).`);
            this.lastRunKey = runKey; // mark run as skipped
            return;
          }

          this.lastRunKey = runKey;
          console.log(`⏰ Triggering automated 2-hour status report for ${runKey}...`);
          await RuntimeStatusReportService.generateAndSendReport();
        }
      } catch (err: any) {
        console.error("❌ RuntimeStatusReportScheduler execution error:", err.message);
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
      console.log("🔌 RuntimeStatusReportScheduler timer stopped.");
    }
  }
}
