import { AppDataSource } from "../data-source";
import { AuditScheduler } from "../services/AuditScheduler";

async function main() {
  console.log("🚀 Starting manual report generator...");
  await AppDataSource.initialize();
  console.log("🔌 Database connected!");

  const dateStr = "2026-07-03";
  console.log(`\n1. Generating Daily Audit for ${dateStr}...`);
  const daily = await AuditScheduler.triggerManualDaily(dateStr);
  console.log(JSON.stringify(daily, null, 2));

  const weekStr = "2026-W27";
  console.log(`\n2. Generating Weekly Report for ${weekStr}...`);
  const weekly = await AuditScheduler.triggerManualWeekly(weekStr);
  console.log(JSON.stringify(weekly, null, 2));

  const monthStr = "2026-07";
  console.log(`\n3. Generating Monthly Certification for ${monthStr}...`);
  const monthly = await AuditScheduler.triggerManualMonthly(monthStr);
  console.log(JSON.stringify(monthly, null, 2));

  await AppDataSource.destroy();
  console.log("\n🔌 Database connection closed. Done!");
}

main().catch(err => {
  console.error("❌ Failed to generate manual reports:", err);
  process.exit(1);
});
