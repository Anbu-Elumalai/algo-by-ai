// src/scripts/count_collections.ts
import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { MongoClient } from "mongodb";

async function run() {
  const mongoUri = process.env.MONGO_URI || "";
  const parsedUrl = new URL(mongoUri);
  parsedUrl.pathname = "/Algo";
  const client = new MongoClient(parsedUrl.toString());
  await client.connect();
  const db = client.db();

  console.log("Database Collections Count:");
  const collections = ["trade_logs", "strategy_decisions", "active_positions", "paper_broker_positions", "daily_risk_trackers", "strategy_analytics"];
  for (const coll of collections) {
    const count = await db.collection(coll).countDocuments({});
    console.log(`- ${coll}: ${count}`);
  }

  // Also check if there's any other collections
  const list = await db.listCollections().toArray();
  console.log("\nAll collections in database:");
  for (const c of list) {
    console.log(`- ${c.name}`);
  }

  await client.close();
}

run().catch(console.error);
