import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import axios from "axios";
import { upstoxConfig } from "../config/upstox";
import { AppDataSource } from "../data-source";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();
  const token = upstoxConfig.getInstrumentToken("RELIANCE");
  console.log("RELIANCE Token:", token);

  const headers = {
    "Authorization": `Bearer ${upstoxConfig.accessToken}`,
    "Accept": "application/json"
  };

  const testFetch = async (toDate: string, fromDate: string, interval: string) => {
    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/${interval}/${toDate}/${fromDate}`;
    console.log(`Querying ${interval} from ${fromDate} to ${toDate}...`);
    try {
      const res = await axios.get(url, { headers, timeout: 10000 });
      const count = res.data?.data?.candles?.length || 0;
      console.log(`Success! Found ${count} candles.`);
      if (count > 0) {
        console.log(`First candle in response (newest):`, res.data.data.candles[0]);
        console.log(`Last candle in response (oldest):`, res.data.data.candles[count - 1]);
      }
    } catch (err: any) {
      console.log(`Error:`, err.response?.data || err.message);
    }
  };

  // Test 1: Recent 30 days
  const toStrRecent = new Date().toISOString().split("T")[0];
  const fromDate30d = new Date();
  fromDate30d.setDate(fromDate30d.getDate() - 30);
  const fromStr30d = fromDate30d.toISOString().split("T")[0];
  await testFetch(toStrRecent, fromStr30d, "minutes/15");

  // Test 2: Try fetching 1 year ago (say 2025-01-01 to 2025-02-01)
  await testFetch("2025-02-01", "2025-01-01", "minutes/15");
  await testFetch("2025-02-01", "2025-01-01", "minutes/60");

  // Test 3: Try fetching 2 years ago (2024-01-01 to 2024-02-01)
  await testFetch("2024-02-01", "2024-01-01", "minutes/15");

  await AppDataSource.destroy();
}

run().catch(console.error);
