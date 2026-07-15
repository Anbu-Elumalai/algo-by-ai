import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { MongoClient } from "mongodb";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  const mongoUri = process.env.MONGO_URI || "";
  const parsedUrl = new URL(mongoUri);
  parsedUrl.pathname = "/Algo";
  const client = new MongoClient(parsedUrl.toString());
  await client.connect();
  const db = client.db();

  let log = "";
  const appendLog = (str: string) => {
    log += str + "\n";
  };

  appendLog("=========================================");
  appendLog("RUNNING DETAILED DB AUDIT FOR 2026-07-03");
  appendLog("=========================================");

  // Find all decisions today (July 3, 2026)
  const todayStart = new Date("2026-07-03T00:00:00.000Z");
  const todayEnd = new Date("2026-07-03T23:59:59.999Z");

  const query = {
    createdAt: {
      $gte: todayStart,
      $lte: todayEnd
    }
  };

  const decisions = await db.collection("strategy_decisions").find(query).sort({ createdAt: 1 }).toArray();
  appendLog(`Found ${decisions.length} strategy decisions today.`);

  const buySignals = decisions.filter(d => d.signal === "BUY");
  const sellSignals = decisions.filter(d => d.signal === "SELL");
  const holdSignals = decisions.filter(d => d.signal === "HOLD");

  appendLog(`BUY signals: ${buySignals.length}`);
  appendLog(`SELL signals: ${sellSignals.length}`);
  appendLog(`HOLD signals: ${holdSignals.length}`);

  appendLog("\n--- DECISIONS LIST ---");
  for (const d of decisions) {
    appendLog(`[${d.createdAt.toISOString()}] Symbol: ${d.symbol} | Signal: ${d.signal}`);
    appendLog(`Reason: ${d.reason}`);
    appendLog(`Fast SMA: ${d.fastSma} | SlowSma: ${d.slowSma} | RSI: ${d.rsi} | ADX: ${(d as any).adx} | ATR: ${(d as any).atr} | Score: ${(d as any).score}`);
    appendLog("-----------------------------------------");
  }

  appendLog("\n--- ERROR LOGS ---");
  const errorLogs = await db.collection("error_logs").find({
    createdAt: { $gte: todayStart, $lte: todayEnd }
  }).toArray();
  appendLog(`Found ${errorLogs.length} error logs today.`);
  for (const err of errorLogs) {
    appendLog(`[${err.createdAt.toISOString()}] Context: ${err.context} | Severity: ${err.severity}`);
    appendLog(`Message: ${err.message}`);
    if (err.stack) appendLog(`Stack: ${err.stack}`);
    appendLog("-----------------------------------------");
  }

  appendLog("\n--- DAILY RISK TRACKERS ---");
  const riskTrackers = await db.collection("daily_risk_trackers").find({
    date: "2026-07-03"
  }).toArray();
  appendLog(JSON.stringify(riskTrackers, null, 2));

  appendLog("\n--- SYSTEM HEALTH LOGS ---");
  const systemHealth = await db.collection("system_health_logs").find({
    createdAt: { $gte: todayStart, $lte: todayEnd }
  }).sort({ createdAt: -1 }).limit(10).toArray();
  appendLog(`Found ${systemHealth.length} system health logs today.`);
  for (const sh of systemHealth) {
    appendLog(`[${sh.createdAt.toISOString()}] WS: ${sh.wsStatus} | DB: ${sh.databaseStatus} | ActiveLoop: ${sh.activeTradingLoop} | CPU: ${sh.cpuUsagePercent}% | Memory: ${sh.memoryUsagePercent}%`);
  }

  fs.writeFileSync("audit_output.txt", log);
  console.log("Audit complete. Saved to audit_output.txt.");

  await client.close();
}

run().catch(console.error);
