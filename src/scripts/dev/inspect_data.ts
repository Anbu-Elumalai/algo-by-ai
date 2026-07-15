import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { AppDataSource } from "../data-source";
import { FeedHealthLog } from "../entity/FeedHealthLog";
import { PositionHealthLog } from "../entity/PositionHealthLog";
import { DailyRiskTracker } from "../entity/DailyRiskTracker";
import { OrderJournal } from "../entity/OrderJournal";
import { ActivePosition } from "../entity/ActivePosition";
import { PaperBrokerPosition } from "../entity/PaperBrokerPosition";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();
  
  const entities = [
    { name: "FeedHealthLog", repo: AppDataSource.getMongoRepository(FeedHealthLog) },
    { name: "PositionHealthLog", repo: AppDataSource.getMongoRepository(PositionHealthLog) },
    { name: "DailyRiskTracker", repo: AppDataSource.getMongoRepository(DailyRiskTracker) },
    { name: "OrderJournal", repo: AppDataSource.getMongoRepository(OrderJournal) },
    { name: "ActivePosition", repo: AppDataSource.getMongoRepository(ActivePosition) },
    { name: "PaperBrokerPosition", repo: AppDataSource.getMongoRepository(PaperBrokerPosition) },
  ];

  for (const ent of entities) {
    const count = await ent.repo.count();
    console.log(`${ent.name} count: ${count}`);
    if (count > 0) {
      const records = await ent.repo.find({ take: 5 } as any);
      console.log(`Sample ${ent.name} records:`, JSON.stringify(records, null, 2));
    }
  }

  await AppDataSource.destroy();
}

run().catch(console.error);
