import { WeeklyReportService } from "./WeeklyReportService";

export class WeeklyReportScheduler {
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

  /**
   * Evaluates if a given date is the last trading day of its week (Mon-Fri).
   * E.g. normally Friday, but if Friday is a holiday, then Thursday, etc.
   */
  static isLastTradingDayOfWeek(date: Date): boolean {
    const day = date.getDay(); // 0 = Sunday, 6 = Saturday
    const dateStr = date.toISOString().split("T")[0];

    // If it's a weekend or trading holiday, today is not a trading day at all
    if (day === 0 || day === 6 || this.isHoliday(dateStr)) {
      return false;
    }

    // Loop through remaining days of this week (from tomorrow up to Saturday)
    // and check if any subsequent day is a valid trading day.
    const temp = new Date(date.getTime());
    for (let d = day + 1; d <= 6; d++) {
      temp.setDate(temp.getDate() + 1);
      const tempDay = temp.getDay();
      const tempDateStr = temp.toISOString().split("T")[0];

      // If a subsequent day in the current week is NOT weekend and NOT holiday,
      // then today is NOT the last trading day of the week.
      if (tempDay !== 0 && tempDay !== 6 && !this.isHoliday(tempDateStr)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Calculates the standard ISO week number of the year for a given date.
   */
  static getISOWeekNumber(d: Date): number {
    const temp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    temp.setUTCDate(temp.getUTCDate() + 4 - (temp.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
    return Math.ceil((((temp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  static start(): void {
    if (this.intervalId) return;

    console.log("⏱️ WeeklyReportScheduler: Background timer registered.");

    this.intervalId = setInterval(async () => {
      try {
        const ist = this.getISTDate();
        const dateStr = ist.toISOString().split("T")[0];
        const hours = ist.getHours();
        const minutes = ist.getMinutes();
        const timeKey = `${hours}:${minutes}`;

        // The scheduled report is executed every Friday after close at 15:45 IST
        if (timeKey === "15:45") {
          const runKey = `${dateStr}_15:45`;
          if (this.lastRunKey === runKey) {
            return; // already run for this minute
          }

          // Check if today is the last trading day of the week
          if (this.isLastTradingDayOfWeek(ist)) {
            this.lastRunKey = runKey;
            const weekNo = this.getISOWeekNumber(ist);
            const weekIdentifier = `${ist.getFullYear()}-W${String(weekNo).padStart(2, "0")}`;

            console.log(`⏰ [WeeklyReportScheduler] Triggering Weekly Strategy Report for ${weekIdentifier} at ${runKey} IST...`);
            const startTime = Date.now();
            await WeeklyReportService.generateWeeklyReport(weekIdentifier);
            const duration = Date.now() - startTime;
            console.log(`⏱️ [WeeklyReportScheduler] Generation completed in ${duration}ms.`);
          }
        }
      } catch (err: any) {
        console.error("❌ [WeeklyReportScheduler] execution error:", err.message);
      }
    }, 15000); // check every 15 seconds

    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("🔌 WeeklyReportScheduler timer stopped.");
    }
  }
}
