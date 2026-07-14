import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { AppDataSource } from "../data-source";
import { WeeklyReportService } from "../services/WeeklyReportService";

async function run() {
  console.log("🚀 Initializing database connection...");
  await AppDataSource.initialize();
  console.log("🔌 Connected to database!");

  const week = "2026-W28";
  console.log(`⏰ Triggering manual Weekly Strategy Trend Report for week: ${week}...`);
  
  try {
    const report = await WeeklyReportService.generateWeeklyReport(week);
    console.log("\n==================================================");
    console.log("✅ WEEKLY STRATEGY REPORT RUN COMPLETED SUCCESSFULLY!");
    console.log("==================================================");
    console.log("ID:", report._id);
    console.log("Week Identifier:", report.weekIdentifier);
    console.log("Generated At:", report.generatedAt);
    console.log("PDF Path:", report.pdfPath);
    console.log("HTML Path:", report.htmlPath);
    console.log("Email Status:", JSON.stringify(report.emailStatus, null, 2));
    console.log("==================================================\n");
  } catch (err: any) {
    console.error("❌ Failed to generate report:", err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  } finally {
    await AppDataSource.destroy();
    console.log("🔌 Database connection closed.");
  }
}

run().catch(console.error);
