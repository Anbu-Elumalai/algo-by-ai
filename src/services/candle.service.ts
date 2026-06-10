import axios from "axios";
import { upstoxConfig } from "../config/upstox";
import { UpstoxBar } from "../strategies/strategyEngine";

export class CandleService {
  private static getHeaders() {
    return {
      "Authorization": `Bearer ${upstoxConfig.accessToken}`,
      "Accept": "application/json",
    };
  }

  /**
   * Validate that all candles are on the correct timeframe, sorted chronologically, and free of duplicates
   */
  static validateCandles(candles: UpstoxBar[]): UpstoxBar[] {
    if (candles.length === 0) return [];

    // Sort chronologically (oldest to newest)
    const sorted = [...candles].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

    const validated: UpstoxBar[] = [];
    const seenTimes = new Set<string>();

    for (const candle of sorted) {
      const timeStr = candle.t;
      if (seenTimes.has(timeStr)) {
        console.warn(`⚠️ Duplicate candle timestamp detected and removed: ${timeStr}`);
        continue; // Skip duplicate candles
      }

      const candleTime = new Date(timeStr).getTime();
      if (isNaN(candleTime)) {
        console.error("❌ Rejecting candle due to invalid timestamp:", candle);
        continue; // Skip invalid dates
      }

      seenTimes.add(timeStr);
      validated.push(candle);
    }

    // Additional check: Ensure consecutive candles are separated by multiples of 15 minutes (900,000 ms)
    // We only alert on this rather than failing, since NSE has a lunch/closing gap where timestamps skip.
    for (let i = 1; i < validated.length; i++) {
      const prevTime = new Date(validated[i - 1].t).getTime();
      const currTime = new Date(validated[i].t).getTime();
      const diffMs = currTime - prevTime;

      // Indian stock market hours are 09:15 to 15:30. Market close gaps are expected.
      // Intra-day gaps not multiples of 15 min are flagged.
      if (diffMs % 900000 !== 0) {
        // Flag warning for anomaly, but don't reject as market could have halts
        console.warn(`⚠️ Candle gap anomaly between ${validated[i - 1].t} and ${validated[i].t} is not a multiple of 15 minutes.`);
      }
    }

    return validated;
  }

  /**
   * Fetch historical 15-minute candles
   * Upstox V3 endpoint: /historical-candle/{instrumentKey}/minutes/15/{toDate}/{fromDate}
   */
  static async getHistoricalCandles(symbol: string, days: number = 5): Promise<UpstoxBar[]> {
    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - days);

      const toStr = toDate.toISOString().split("T")[0]; // YYYY-MM-DD
      const fromStr = fromDate.toISOString().split("T")[0];

      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentToken)}/minutes/15/${toStr}/${fromStr}`;

      console.log(`📥 Fetching historical 15-minute candles for ${symbol} from ${fromStr} to ${toStr}...`);
      const response = await axios.get(url, { headers: this.getHeaders() });

      const rawCandles = response.data?.data?.candles || [];
      const formatted: UpstoxBar[] = rawCandles.map((c: any) => ({
        t: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5] || 0),
      })).reverse(); // Reverse so it goes oldest to newest

      return this.validateCandles(formatted);
    } catch (error: any) {
      console.error(`❌ Error fetching historical 15-minute candles for ${symbol}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Fetch today's intraday 15-minute candles (V3)
   * Upstox V3 endpoint: /historical-candle/intraday/{instrumentKey}/minutes/15
   */
  static async getIntradayCandles(symbol: string): Promise<UpstoxBar[]> {
    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);
      const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentToken)}/minutes/15`;

      const response = await axios.get(url, { headers: this.getHeaders() });

      const rawCandles = response.data?.data?.candles || [];
      const formatted: UpstoxBar[] = rawCandles.map((c: any) => ({
        t: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5] || 0),
      })).reverse();

      return this.validateCandles(formatted);
    } catch (error: any) {
      console.error(`❌ Error fetching intraday 15-minute candles for ${symbol}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Sync and return a complete chronological history of 15-minute candles (historical + intraday)
   */
  static async getSyncedCandles(symbol: string, historicalDays: number = 5): Promise<UpstoxBar[]> {
    const historical = await this.getHistoricalCandles(symbol, historicalDays);

    let intraday: UpstoxBar[] = [];
    try {
      intraday = await this.getIntradayCandles(symbol);
    } catch (err: any) {
      console.warn(`⚠️ Failed to fetch intraday candles for ${symbol}, relying on historical only:`, err.message);
    }

    // Combine and remove overlaps
    const combined = [...historical, ...intraday];
    return this.validateCandles(combined);
  }
}
