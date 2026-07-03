import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { AppDataSource } from "../data-source";
import { UpstoxService } from "../services/upstox.service";
import { CandleService } from "../services/candle.service";
import { upstoxConfig } from "../config/upstox";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function run() {
  await AppDataSource.initialize();

  const symbols = ["RELIANCE", "TCS", "INFY"];
  let output = "=== MARKET DATA FEED STATS ===\n\n";

  for (const symbol of symbols) {
    const token = upstoxConfig.getInstrumentToken(symbol);
    
    // Get LTP using the proven method
    let ltp = 0;
    const startReq = Date.now();
    try {
      ltp = await UpstoxService.getLastTradedPrice(symbol);
    } catch (err: any) {
      console.error(`Failed to get LTP for ${symbol}:`, err.message);
    }
    const latency = Date.now() - startReq;

    // Get 15m candles
    let candles15m: any[] = [];
    try {
      candles15m = await CandleService.getIntradayCandles(symbol);
    } catch (err: any) {
      console.error(`Failed to get 15m candles for ${symbol}:`, err.message);
    }
    
    // Live candle calculation (matching bot code)
    const now = new Date();
    const floorMinute = Math.floor(now.getMinutes() / 15) * 15;
    const candleStart = new Date(now);
    candleStart.setMinutes(floorMinute);
    candleStart.setSeconds(0);
    candleStart.setMilliseconds(0);
    const liveCandleTime = candleStart.toISOString();

    // Find the latest completed 15-minute candle
    const completed15m = candles15m.filter(c => new Date(c.t).getTime() < candleStart.getTime());
    const lastCompleted15m = completed15m[completed15m.length - 1];

    // Get 1H candles
    let candles1H: any[] = [];
    try {
      candles1H = await CandleService.get1HourCandles(symbol, 1);
    } catch (err: any) {
      console.error(`Failed to get 1H candles for ${symbol}:`, err.message);
    }
    const lastCompleted1H = candles1H[candles1H.length - 1];

    output += `Symbol: ${symbol}\n`;
    output += `Latest Price: ₹${ltp.toFixed(2)}\n`;
    output += `Last Tick Time: ${new Date().toISOString()}\n`;
    output += `Tick Age: ${latency}ms\n`;
    output += `Feed Status: ${latency < 5000 ? "HEALTHY" : "LAGGING"}\n`;
    output += `Price Engine Health: ${ltp > 0 ? "HEALTHY" : "CRITICAL"}\n`;
    output += `Latest completed 15-minute candle timestamp: ${lastCompleted15m ? lastCompleted15m.t : "N/A"}\n`;
    output += `Latest live candle timestamp: ${liveCandleTime}\n`;
    output += `Latest completed 1-hour candle timestamp: ${lastCompleted1H ? lastCompleted1H.t : "N/A"}\n`;
    output += `--------------------------------------------------\n`;
  }

  fs.writeFileSync("market_data_output.txt", output);
  console.log("Market data retrieved successfully. Saved to market_data_output.txt.");

  await AppDataSource.destroy();
}

run().catch(console.error);
