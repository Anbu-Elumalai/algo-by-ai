import axios from "axios";
import { upstoxConfig } from "../config/upstox";

export interface UpstoxAccount {
  equity: number;
  cash: number;
  buyingPower: number;
}

export interface UpstoxPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPl: number;
}

export interface UpstoxBar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

export class UpstoxService {
  private static getHeaders() {
    return {
      "Authorization": `Bearer ${upstoxConfig.accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
  }

  /**
   * Fetch current account margin and funds balance
   */
  static async getAccount(): Promise<UpstoxAccount> {
    try {
      if (!upstoxConfig.accessToken) {
        throw new Error("No Upstox Access Token provided inside .env! Please configure UPSTOX_ACCESS_TOKEN.");
      }

      // Segment=SEC means Securities (Stocks) segment
      const response = await axios.get(
        `${upstoxConfig.baseUrl}/user/get-funds-and-margin?segment=SEC`,
        { headers: this.getHeaders() }
      );

      const data = response.data?.data?.equity || {};
      
      return {
        equity: parseFloat(data.utilised_margin || 0) + parseFloat(data.available_margin || 100000), // Fallback to 100k play money for demo if zero
        cash: parseFloat(data.available_margin || 100000),
        buyingPower: parseFloat(data.available_margin || 100000) * 5, // 5x leverage for Intraday stocks
      };
    } catch (error: any) {
      console.error("❌ Error fetching Upstox account margin:", error.response?.data || error.message);
      // Return simulated backup account details for testing if authorization is not fully loaded yet
      return {
        equity: 100000,
        cash: 100000,
        buyingPower: 500000,
      };
    }
  }

  /**
   * Fetch active intraday/delivery holdings
   */
  static async getPositions(): Promise<UpstoxPosition[]> {
    try {
      if (!upstoxConfig.accessToken) return [];

      const response = await axios.get(
        `${upstoxConfig.baseUrl}/portfolio/short-term-positions`,
        { headers: this.getHeaders() }
      );

      const positions = response.data?.data || [];
      
      return positions.map((pos: any) => ({
        symbol: pos.trading_symbol,
        qty: parseInt(pos.quantity || 0),
        avgEntryPrice: parseFloat(pos.average_price || 0),
        currentPrice: parseFloat(pos.last_price || 0),
        unrealizedPl: parseFloat(pos.pnl || 0),
      }));
    } catch (error: any) {
      console.error("❌ Error fetching Upstox positions:", error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Fetch a single active position by symbol
   */
  static async getPosition(symbol: string): Promise<UpstoxPosition | null> {
    const all = await this.getPositions();
    const match = all.find(p => p.symbol.toUpperCase() === symbol.toUpperCase());
    return match || null;
  }

  /**
   * Submit an Intraday Stock Order (Market or Limit)
   */
  static async placeOrder(
    symbol: string,
    qty: number,
    side: "BUY" | "SELL",
    orderType: "MARKET" | "LIMIT" = "MARKET",
    price?: number
  ): Promise<any> {
    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);

      const body = {
        quantity: qty,
        product: "I", // "I" represents Intraday Product Type
        validity: "DAY",
        price: orderType === "LIMIT" ? price : 0,
        instrument_token: instrumentToken,
        order_type: orderType,
        transaction_type: side.toUpperCase(),
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
      };

      console.log(`📡 Sending ${side} order: ${qty} shares of ${symbol} (${orderType}) to Upstox`);
      
      const response = await axios.post(
        `${upstoxConfig.baseUrl}/order/place`,
        body,
        { headers: this.getHeaders() }
      );

      return response.data?.data || response.data;
    } catch (error: any) {
      console.error(`❌ Error placing order for ${symbol} on Upstox:`, error.response?.data || error.message);
      throw new Error(`Upstox Order Failed: ${JSON.stringify(error.response?.data || error.message)}`);
    }
  }

  /**
   * Fetch historical candlestick data
   */
  static async getHistoricalBars(
    symbol: string,
    days: number = 30,
    interval: "1minute" | "30minute" | "day" = "day"
  ): Promise<UpstoxBar[]> {
    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - days);

      const toStr = toDate.toISOString().split("T")[0]; // YYYY-MM-DD
      const fromStr = fromDate.toISOString().split("T")[0];

      // End-point: /historical-candle/{instrumentKey}/{interval}/{toDate}/{fromDate}
      const response = await axios.get(
        `${upstoxConfig.baseUrl}/historical-candle/${encodeURIComponent(instrumentToken)}/${interval}/${toStr}/${fromStr}`,
        {
          headers: {
            "Accept": "application/json",
          }
        }
      );

      const candles = response.data?.data?.candles || [];
      
      // Upstox candles list: [ [timestamp, open, high, low, close, volume, open_interest], ... ]
      // Returned oldest to newest
      const formattedBars: UpstoxBar[] = candles.map((c: any) => ({
        t: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5] || 0),
      })).reverse(); // Reverse so array is in chronological order (oldest to newest)

      return formattedBars;
    } catch (error: any) {
      console.error(`❌ Error fetching Upstox historical bars for ${symbol}:`, error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Helper REST API to fetch the Last Traded Price (LTP) of a stock
   * Extremely simple, stable, and highly robust for 1-minute live loops!
   */
  static async getLastTradedPrice(symbol: string): Promise<number> {
    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);
      
      const response = await axios.get(
        `${upstoxConfig.baseUrl}/market-quote/ltp`,
        {
          headers: this.getHeaders(),
          params: {
            instrument_key: instrumentToken
          }
        }
      );

      const ltpData = response.data?.data || {};
      const key = Object.keys(ltpData)[0];
      return parseFloat(ltpData[key]?.last_price || 0);
    } catch (error: any) {
      console.error(`❌ Error getting LTP for ${symbol}:`, error.response?.data || error.message);
      throw error;
    }
  }
}
