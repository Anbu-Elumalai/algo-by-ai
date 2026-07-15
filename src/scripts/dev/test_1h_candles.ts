import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import axios from "axios";
import { AppDataSource } from "../data-source";
import { upstoxConfig } from "../config/upstox";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();
  const token = upstoxConfig.getInstrumentToken("RELIANCE");
  console.log("RELIANCE Token:", token);

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - 10);
  const toStr = toDate.toISOString().split("T")[0];
  const fromStr = fromDate.toISOString().split("T")[0];

  const headers = {
    "Authorization": `Bearer ${upstoxConfig.accessToken}`,
    "Accept": "application/json"
  };

  const tryInterval = async (interval: string) => {
    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/${interval}/${toStr}/${fromStr}`;
    console.log(`Trying URL: ${url}`);
    try {
      const res = await axios.get(url, { headers });
      console.log(`Success for ${interval}! Raw count:`, res.data?.data?.candles?.length);
      if (res.data?.data?.candles?.length > 0) {
        console.log("Sample candle:", res.data.data.candles[0]);
      }
      return true;
    } catch (err: any) {
      console.log(`Error for ${interval}:`, err.response?.data || err.message);
      return false;
    }
  };

  await tryInterval("1hour");
  await tryInterval("minutes/60");
  await tryInterval("hour/1");

  await AppDataSource.destroy();
}

run().catch(console.error);
