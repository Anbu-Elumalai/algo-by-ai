import dotenv from "dotenv";
dotenv.config();

export const upstoxConfig = {
  apiKey: process.env.UPSTOX_API_KEY || "",
  apiSecret: process.env.UPSTOX_API_SECRET || "",
  redirectUri: process.env.UPSTOX_REDIRECT_URI || "http://localhost:4000/api/trading/upstox/callback",
  accessToken: process.env.UPSTOX_ACCESS_TOKEN || "",

  baseUrl: "https://api.upstox.com/v2",

  // Simple, bulletproof mapping of top liquid Nifty 50 stocks to Upstox Instrument Keys
  // This saves beginners from downloading massive 20MB instrument mapping CSVs!
  instruments: {
    RELIANCE: "NSE_EQ|INE002A01018",
    TCS: "NSE_EQ|INE467B01029",
    INFY: "NSE_EQ|INE009A01021",
    SBIN: "NSE_EQ|INE062A01020",
    TATASTEEL: "NSE_EQ|INE081A01020",
    HDFCBANK: "NSE_EQ|INE040A01034",
    ICICIBANK: "NSE_EQ|INE090A01021",
  } as Record<string, string>,

  /**
   * Helper to fetch the instrument token for a given symbol
   */
  getInstrumentToken(symbol: string): string {
    const sym = symbol.toUpperCase();
    const token = this.instruments[sym];
    if (!token) {
      throw new Error(`Symbol '${symbol}' is not configured in Upstox instrument mapping. Available: ${Object.keys(this.instruments).join(", ")}`);
    }
    return token;
  }
};
