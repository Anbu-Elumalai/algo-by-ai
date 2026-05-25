import { DataSource } from "typeorm";
import dotenv from "dotenv";

dotenv.config();

const ext = __filename.endsWith(".ts") ? "ts" : "js";

export const AppDataSource = new DataSource({
  type: "mongodb",
  url: process.env.MONGO_URI || "",
  synchronize: false,
  logging: process.env.NODE_ENV !== "production",

  entities: [`${__dirname}/entity/**/*.${ext}`],
});
