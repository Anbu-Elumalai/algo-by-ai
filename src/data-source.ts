import { DataSource } from "typeorm";
import dotenv from "dotenv";

dotenv.config();

const ext = __filename.endsWith(".ts") ? "ts" : "js";

const appEnv = process.env.APP_ENV || (process.env.NODE_ENV === "test" ? "TEST" : "PAPER");
let mongoUrl = process.env.MONGO_URI || "";

if (mongoUrl) {
  try {
    const parsed = new URL(mongoUrl);
    const dbName = appEnv === "TEST" ? "AlgoTest" : (appEnv === "LIVE" ? "AlgoLive" : "Algo");
    parsed.pathname = `/${dbName}`;
    mongoUrl = parsed.toString();
    console.log(`🔌 Connecting to MongoDB Database: ${dbName} (${appEnv} mode)`);
  } catch (err: any) {
    console.error("❌ Failed to parse MONGO_URI, using raw connection string:", err.message);
  }
}

export const AppDataSource = new DataSource({
  type: "mongodb",
  url: mongoUrl,
  synchronize: false,
  logging: process.env.NODE_ENV !== "production" && appEnv !== "TEST",

  entities: [`${__dirname}/entity/**/*.${ext}`],
});
