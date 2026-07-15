import { AppDataSource } from "../data-source";
import { StrategyEvaluationLog } from "../entity/StrategyEvaluationLog";
import { RuntimeDailyAudit } from "../entity/RuntimeDailyAudit";
import { TradeLog } from "../entity/TradeLog";
import { ActivePosition } from "../entity/ActivePosition";
import { DailyRiskTracker } from "../entity/DailyRiskTracker";
import { SystemHealthMonitor } from "../services/SystemHealthMonitor";

async function main() {
  await AppDataSource.initialize();
  console.log("🔌 Connected to database!");

  const dateStr = "2026-07-03";

  // 1. Fetch Runtime Audit
  const auditRepo = AppDataSource.getRepository(RuntimeDailyAudit);
  const dailyAudit = await auditRepo.findOne({ where: { date: dateStr } as any });
  console.log("\n=== DAILY AUDIT ===");
  console.log(JSON.stringify(dailyAudit, null, 2));

  // 2. Fetch Strategy Evaluation Logs count
  const evalRepo = AppDataSource.getRepository(StrategyEvaluationLog);
  const evals = await evalRepo.find({ where: { date: dateStr } as any });
  console.log("\n=== EVALUATIONS COUNT ===");
  console.log("Total evaluations:", evals.length);
  const signals = { BUY: 0, SELL: 0, HOLD: 0 };
  evals.forEach(e => {
    signals[e.signal] = (signals[e.signal] || 0) + 1;
  });
  console.log("Signals breakdown:", signals);

  // 3. Fetch Trade Logs
  const tradeRepo = AppDataSource.getRepository(TradeLog);
  const trades = await tradeRepo.find();
  const todayTrades = trades.filter(t => t.createdAt.toISOString().split("T")[0] === dateStr);
  console.log("\n=== TODAY'S TRADES ===");
  console.log("Total trades:", todayTrades.length);
  console.log(JSON.stringify(todayTrades, null, 2));

  // 4. Fetch Active Positions
  const posRepo = AppDataSource.getRepository(ActivePosition);
  const activePositions = await posRepo.find();
  console.log("\n=== ACTIVE POSITIONS ===");
  console.log(JSON.stringify(activePositions, null, 2));

  // 5. Fetch Risk Tracker
  const riskRepo = AppDataSource.getRepository(DailyRiskTracker);
  const tracker = await riskRepo.findOne({ where: { date: dateStr } as any });
  console.log("\n=== RISK TRACKER ===");
  console.log(JSON.stringify(tracker, null, 2));

  // 6. Fetch Telemetry
  const telemetry = await SystemHealthMonitor.getHealthReport();
  console.log("\n=== TELEMETRY ===");
  console.log(JSON.stringify(telemetry, null, 2));

  await AppDataSource.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
