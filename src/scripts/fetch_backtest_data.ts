import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
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

const CACHE_DIR = path.resolve(process.cwd(), "cache_backtest");

function ensureDirectoryExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function fetchCandlesInChunks(
  symbol: string,
  interval: string,
  startDate: Date,
  endDate: Date
): Promise<UpstoxBar[]> {
  const token = upstoxConfig.getInstrumentToken(symbol);
  const headers = {
    "Authorization": `Bearer ${upstoxConfig.accessToken}`,
    "Accept": "application/json"
  };

  const cleanIntervalName = interval.replace("/", "_");
  const symbolCachePath = path.join(CACHE_DIR, `${symbol}_${cleanIntervalName}_raw.json`);

  // Check if we already have the complete dataset cached
  if (fs.existsSync(symbolCachePath)) {
    console.log(`📦 Found existing full cache for ${symbol} (${interval}) at ${symbolCachePath}. Loading...`);
    const data = JSON.parse(fs.readFileSync(symbolCachePath, "utf8"));
    return data;
  }

  let currentToDate = new Date(endDate);
  const finalFromDate = new Date(startDate);
  let allCandles: UpstoxBar[] = [];

  console.log(`📡 Fetching ${symbol} (${interval}) from ${startDate.toISOString().split("T")[0]} to ${endDate.toISOString().split("T")[0]}`);

  while (currentToDate > finalFromDate) {
    const currentFromDate = new Date(currentToDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const actualFromDate = currentFromDate < finalFromDate ? finalFromDate : currentFromDate;

    const toStr = currentToDate.toISOString().split("T")[0];
    const fromStr = actualFromDate.toISOString().split("T")[0];

    const chunkCacheName = `${symbol}_${cleanIntervalName}_${fromStr}_${toStr}.json`;
    const chunkCachePath = path.join(CACHE_DIR, "chunks", chunkCacheName);

    ensureDirectoryExists(path.dirname(chunkCachePath));

    if (fs.existsSync(chunkCachePath)) {
      console.log(`  - Loading cached chunk: ${fromStr} -> ${toStr}`);
      const chunk = JSON.parse(fs.readFileSync(chunkCachePath, "utf8"));
      allCandles.push(...chunk);
    } else {
      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(token)}/${interval}/${toStr}/${fromStr}`;
      console.log(`  - Fetching from Upstox: ${fromStr} -> ${toStr}`);

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

        fs.writeFileSync(chunkCachePath, JSON.stringify(chunk, null, 2), "utf8");
        allCandles.push(...chunk);
        console.log(`    Retrieved ${chunk.length} candles (Total: ${allCandles.length})`);
      } catch (err: any) {
        console.error(`    Error fetching chunk ${fromStr} -> ${toStr}:`, err.response?.data || err.message);
        // Wait and retry
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
          fs.writeFileSync(chunkCachePath, JSON.stringify(chunk, null, 2), "utf8");
          allCandles.push(...chunk);
          console.log(`    Retried and retrieved ${chunk.length} candles.`);
        } catch (retryErr: any) {
          console.error(`    Retry failed! Skipping this chunk.`);
        }
      }
      // Rate limit spacing
      await new Promise(r => setTimeout(r, 500));
    }

    currentToDate = new Date(actualFromDate.getTime() - 24 * 60 * 60 * 1000);
  }

  // De-duplicate and sort chronologically
  const uniqueMap = new Map<string, UpstoxBar>();
  for (const c of allCandles) {
    uniqueMap.set(c.t, c);
  }
  const sorted = Array.from(uniqueMap.values()).sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime()
  );

  // Write complete dataset cache
  ensureDirectoryExists(CACHE_DIR);
  fs.writeFileSync(symbolCachePath, JSON.stringify(sorted, null, 2), "utf8");
  console.log(`💾 Saved complete sorted cache to ${symbolCachePath} (${sorted.length} candles)`);

  return sorted;
}

export async function fetchAllBacktestData() {
  ensureDirectoryExists(CACHE_DIR);
  const start = new Date("2024-01-01T00:00:00.000Z");
  const end = new Date("2025-12-31T23:59:59.000Z");

  const symbols = ["RELIANCE", "TCS", "INFY"];

  for (const symbol of symbols) {
    console.log(`\n=========================================`);
    console.log(`Sourcing candles for ${symbol}`);
    console.log(`=========================================`);

    // Fetch 15m
    await fetchCandlesInChunks(symbol, "minutes/15", start, end);
    // Fetch 1H
    await fetchCandlesInChunks(symbol, "minutes/60", start, end);
  }

  console.log("\n✅ Sourcing of all historical backtest data complete!");
}

async function main() {
  await AppDataSource.initialize();
  await fetchAllBacktestData();
  await AppDataSource.destroy();
}

if (require.main === module) {
  main().catch(console.error);
}
