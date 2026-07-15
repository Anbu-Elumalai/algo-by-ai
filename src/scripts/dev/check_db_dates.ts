import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { MongoClient } from "mongodb";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  const mongoUri = process.env.MONGO_URI || "";
  const parsedUrl = new URL(mongoUri);
  parsedUrl.pathname = "/Algo";
  const client = new MongoClient(parsedUrl.toString());
  await client.connect();
  const db = client.db();

  console.log("Checking dates in collections...");
  
  const colls = [
    "strategy_evaluation_logs",
    "strategy_decisions",
    "trade_logs",
    "runtime_daily_audits",
    "backtest_runs",
    "monthly_certification_reports",
    "weekly_certification_reports",
    "weekly_strategy_reports"
  ];
  
  for (const c of colls) {
    const col = db.collection(c);
    const count = await col.countDocuments({});
    console.log(`\nCollection: ${c} (Total documents: ${count})`);
    
    if (count > 0) {
      const first = await col.find().sort({ createdAt: 1 }).limit(1).toArray();
      const last = await col.find().sort({ createdAt: -1 }).limit(1).toArray();
      
      console.log(`- Min createdAt: ${first[0]?.createdAt} (Date: ${first[0]?.date || 'N/A'}, Symbol: ${first[0]?.symbol || 'N/A'})`);
      console.log(`- Max createdAt: ${last[0]?.createdAt} (Date: ${last[0]?.date || 'N/A'}, Symbol: ${last[0]?.symbol || 'N/A'})`);
      
      // print first record keys/sample
      console.log(`- Sample record keys:`, Object.keys(first[0]));
      console.log(`- Sample record:`, JSON.stringify(first[0], null, 2));
    }
  }

  await client.close();
}

run().catch(console.error);
