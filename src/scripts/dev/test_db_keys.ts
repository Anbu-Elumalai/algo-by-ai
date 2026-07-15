import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { AppDataSource } from "../data-source";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();
  console.log("CONNECTED TO DATABASE.");

  console.log("Keys on AppDataSource:", Object.keys(AppDataSource));
  console.log("Keys on AppDataSource.manager:", Object.keys(AppDataSource.manager));
  console.log("Keys on AppDataSource.driver:", Object.keys(AppDataSource.driver));

  const driver = AppDataSource.driver as any;
  if (driver.client) {
    console.log("Found client on driver! Keys:", Object.keys(driver.client));
  } else {
    console.log("No client on driver.");
  }

  const manager = AppDataSource.manager as any;
  if (manager.mongoEntityManager) {
    console.log("Found mongoEntityManager on manager!");
  }

  // Let's inspect connection or database name
  console.log("Database Name:", AppDataSource.options.database);

  // Let's check how we can get raw DB.
  // Often in TypeORM Mongo:
  // AppDataSource.manager.queryRunner or connection
  if (driver.queryRunner) {
    console.log("Found queryRunner on driver!");
  }
  
  const runner = AppDataSource.createQueryRunner() as any;
  console.log("Keys on QueryRunner:", Object.keys(runner));
  if (runner.databaseConnection) {
    console.log("Found databaseConnection on QueryRunner!");
    console.log("Keys on databaseConnection:", Object.keys(runner.databaseConnection));
    if (runner.databaseConnection.db) {
      console.log("Found db on databaseConnection! Result of db() keys:", Object.keys(runner.databaseConnection.db()));
    }
  }

  await AppDataSource.destroy();
}

run().catch(console.error);
