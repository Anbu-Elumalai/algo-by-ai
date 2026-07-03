import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { AppDataSource } from "../data-source";
import { StrategyDecision } from "../entity/StrategyDecision";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getMongoRepository(StrategyDecision);
  
  // Find decisions around 2026-06-24T04:13:38
  const start = new Date("2026-06-24T04:10:00Z");
  const end = new Date("2026-06-24T04:16:00Z");

  const decisions = await repo.find({
    where: {
      symbol: "TCS",
      createdAt: { $gte: start, $lte: end }
    } as any
  });

  console.log(`Found ${decisions.length} decisions for TCS around 2026-06-24 09:40-09:46 IST:`);
  console.log(JSON.stringify(decisions, null, 2));

  await AppDataSource.destroy();
}

run().catch(console.error);
