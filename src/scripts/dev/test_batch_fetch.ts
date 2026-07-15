import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import axios from "axios";
import { upstoxConfig } from "../config/upstox";
import { AppDataSource } from "../data-source";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

interface UpstoxBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function fetchCandlesBatch(symbol: string, interval: string, startDate: Date, endDate: Date): Promise<UpstoxBar[]> {
  const token = upstoxConfig.getInstrumentToken(symbol);
  const headers = {
    "Authorization": `Bearer ${upstoxConfig.accessToken}`,
    "Accept": "application/json"
  };

  let currentToDate = new Date(endDate);
  const finalFromDate = new Date(startDate);
  let allCandles: UpstoxBar[] = [];

  console.log(`[Batch Fetch] Starting for ${symbol} (${interval}) from ${finalFromDate.toISOString().split("T")[0]} to ${currentToDate.toISOString().split("T")[0]}`);

  while (currentToDate > finalFromDate) {
    // Determine the fromDate for this 30-day chunk
    let currentFromDate = new Date(currentToDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (currentFromDate < finalFromDate) {
      currentFromDate = finalFromDate;
    }

    const toStr = currentToDate.toISOString().split("T")[0];
    const fromStr = currentFromDate.toISOString().split("T")[0];

    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/${interval}/${toStr}/${fromStr}`;
    console.log(`  Fetching chunk: ${fromStr} -> ${toStr}`);

    try {
      const res = await axios.get(url, { headers, timeout: 10000 });
      const raw = res.data?.data?.candles || [];
      const chunk = raw.map((c: any) => ({
        t: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5] || 0)
      }));

      allCandles.push(...chunk);
      console.log(`  Retrieved ${chunk.length} candles (Total accumulated: ${allCandles.length})`);
    } catch (err: any) {
      console.error(`  Error fetching chunk ${fromStr} -> ${toStr}:`, err.response?.data || err.message);
      // Wait and retry once
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await axios.get(url, { headers, timeout: 10000 });
        const raw = res.data?.data?.candles || [];
        const chunk = raw.map((c: any) => ({
          t: c[0],
          o: parseFloat(c[1]),
          h: parseFloat(c[2]),
          l: parseFloat(c[3]),
          c: parseFloat(c[4]),
          v: parseInt(c[5] || 0)
        }));
        allCandles.push(...chunk);
        console.log(`  Retried and retrieved ${chunk.length} candles.`);
      } catch (retryErr: any) {
        console.error(`  Retry failed:`, retryErr.message);
        break; // Stop fetching on repeated error
      }
    }

    // Move the toDate back for the next iteration (subtract 30 days plus 1 day to avoid overlap)
    currentToDate = new Date(currentFromDate.getTime() - 24 * 60 * 60 * 1000);
    // Rate limit delay
    await new Promise(r => setTimeout(r, 600));
  }

  // De-duplicate and sort chronologically
  const uniqueCandlesMap = new Map<string, UpstoxBar>();
  for (const c of allCandles) {
    uniqueCandlesMap.set(c.t, c);
  }
  const sorted = Array.from(uniqueCandlesMap.values()).sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime()
  );

  console.log(`[Batch Fetch] Completed for ${symbol}. Total unique candles: ${sorted.length}`);
  if (sorted.length > 0) {
    console.log(`  Date Range: ${sorted[0].t} -> ${sorted[sorted.length - 1].t}`);
  }
  return sorted;
}

async function run() {
  await AppDataSource.initialize();
  // Fetch 3 months of data from 2025-01-01 to 2025-03-31
  const start = new Date("2025-01-01");
  const end = new Date("2025-03-31");
  await fetchCandlesBatch("RELIANCE", "minutes/15", start, end);
  await AppDataSource.destroy();
}

run().catch(console.error);
