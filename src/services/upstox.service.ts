import axios from "axios";
import { upstoxConfig } from "../config/upstox";
import { HealthService } from "./health.service";
import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { ActivePosition } from "../entity/ActivePosition";

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

export class UpstoxService {
  private static getHeaders() {
    return {
      "Authorization": `Bearer ${upstoxConfig.accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
  }

  private static verifyCircuit() {
    if (!HealthService.isTradingAllowed()) {
      throw new Error("❌ API Execution Halted: The Circuit Breaker is OPEN due to repeated API failures.");
    }
  }

  /**
   * Helper to calculate running paper trading account balances from MongoDB logs
   */
  static async getPaperAccount(): Promise<UpstoxAccount> {
    try {
      const tradeRepo = AppDataSource.getRepository(TradeLog);
      const positionRepo = AppDataSource.getRepository(ActivePosition);

      const logs = await tradeRepo.find();
      let cash = 100000.0; // Starting capital

      for (const log of logs) {
        if (log.action === "BUY") {
          cash -= (log.totalAmount + (log.transactionFees || 40));
        } else if (log.action === "SELL") {
          cash += (log.totalAmount - (log.transactionFees || 40));
        }
      }

      const openPositions = await positionRepo.find();
      let openValue = 0;
      for (const pos of openPositions) {
        let currentPrice = pos.avgEntryPrice;
        try {
          const { PriceEngine } = require("./PriceEngine");
          currentPrice = await PriceEngine.getLastPrice(pos.symbol);
        } catch {
          // Keep avgEntryPrice as fallback
        }
        openValue += pos.qty * currentPrice;
      }

      return {
        equity: cash + openValue,
        cash: cash,
        buyingPower: cash * 5,
      };
    } catch (err: any) {
      console.warn("⚠️ Failed to calculate paper account balance, returning static fallback:", err.message);
      return { equity: 100000, cash: 100000, buyingPower: 500000 };
    }
  }

  /**
   * Fetch current account margin and funds balance
   */
  static async getAccount(): Promise<UpstoxAccount> {
    this.verifyCircuit();

    // Intercept if in PAPER trading mode
    if (process.env.TRADING_MODE === "PAPER") {
      return this.getPaperAccount();
    }

    try {
      if (!upstoxConfig.accessToken) {
        throw new Error("No Upstox Access Token provided! Please authenticate.");
      }

      const response = await axios.get(
        `${upstoxConfig.baseUrl}/user/get-funds-and-margin?segment=SEC`,
        { headers: this.getHeaders() }
      );

      const data = response.data?.data?.equity;
      if (!data) {
        throw new Error("Invalid response schema returned from Upstox Margin API.");
      }

      const account: UpstoxAccount = {
        equity: parseFloat(data.utilised_margin || 0) + parseFloat(data.available_margin || 0),
        cash: parseFloat(data.available_margin || 0),
        buyingPower: parseFloat(data.available_margin || 0) * 5,
      };

      await HealthService.reportSuccess();
      return account;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getAccount", errorMsg, error.stack);
      throw error;
    }
  }

  /**
   * Fetch active intraday/delivery holdings
   */
  static async getPositions(): Promise<UpstoxPosition[]> {
    this.verifyCircuit();

    // In paper trading mode, positions are fetched from the database ActivePosition collection cache
    if (process.env.TRADING_MODE === "PAPER") {
      try {
        const repo = AppDataSource.getRepository(ActivePosition);
        const openPositions = await repo.find();

        const formatted: UpstoxPosition[] = [];
        for (const pos of openPositions) {
          let currentPrice = pos.avgEntryPrice;
          try {
            const { PriceEngine } = require("./PriceEngine");
            currentPrice = await PriceEngine.getLastPrice(pos.symbol);
          } catch {
            // Keep average entry
          }
          const unrealized = (currentPrice - pos.avgEntryPrice) * pos.qty;
          formatted.push({
            symbol: pos.symbol,
            qty: pos.qty,
            avgEntryPrice: pos.avgEntryPrice,
            currentPrice: currentPrice,
            unrealizedPl: unrealized,
          });
        }
        return formatted;
      } catch (err: any) {
        console.error("❌ Failed to fetch paper positions from DB:", err.message);
        return [];
      }
    }

    try {
      if (!upstoxConfig.accessToken) {
        throw new Error("No Upstox Access Token provided! Please authenticate.");
      }

      const response = await axios.get(
        `${upstoxConfig.baseUrl}/portfolio/short-term-positions`,
        { headers: this.getHeaders() }
      );

      const positions = response.data?.data || [];
      const formatted: UpstoxPosition[] = positions.map((pos: any) => ({
        symbol: pos.trading_symbol,
        qty: parseInt(pos.quantity || 0),
        avgEntryPrice: parseFloat(pos.average_price || 0),
        currentPrice: parseFloat(pos.last_price || 0),
        unrealizedPl: parseFloat(pos.pnl || 0),
      }));

      await HealthService.reportSuccess();
      return formatted;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getPositions", errorMsg, error.stack);
      throw error;
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
    this.verifyCircuit();

    // Intercept if in PAPER trading mode
    if (process.env.TRADING_MODE === "PAPER") {
      console.log(`📝 [PAPER TRADE] Simulating ${side} order: ${qty} shares of ${symbol}`);
      const mockOrderId = `paper-order-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      return {
        order_id: mockOrderId,
        status: "success",
        message: "Paper order filled successfully."
      };
    }

    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);

      const body = {
        quantity: qty,
        product: "I",
        validity: "DAY",
        price: orderType === "LIMIT" ? price : 0,
        instrument_token: instrumentToken,
        order_type: orderType,
        transaction_type: side.toUpperCase(),
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
      };

      console.log(`📡 Dispatching ${side} order: ${qty} shares of ${symbol} (${orderType}) to Upstox`);

      const response = await axios.post(
        `${upstoxConfig.baseUrl}/order/place`,
        body,
        { headers: this.getHeaders() }
      );

      const data = response.data?.data || response.data;
      await HealthService.reportSuccess();
      return data;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.placeOrder", errorMsg, error.stack);
      throw error;
    }
  }

  /**
   * Fetch order details from Upstox
   */
  static async getOrderStatus(orderId: string): Promise<any> {
    this.verifyCircuit();

    if (process.env.TRADING_MODE === "PAPER") {
      return {
        status: "complete",
        order_id: orderId,
        average_price: 0,
        filled_quantity: 0,
      };
    }

    try {
      if (!upstoxConfig.accessToken) {
        throw new Error("No Upstox Access Token provided! Please authenticate.");
      }

      const response = await axios.get(
        `${upstoxConfig.baseUrl}/order/details?order_id=${orderId}`,
        { headers: this.getHeaders() }
      );

      const data = response.data?.data;
      await HealthService.reportSuccess();
      return data;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getOrderStatus", errorMsg, error.stack);
      throw error;
    }
  }

  /**
   * Fetch historical candlestick data
   */
  static async getHistoricalBars(
    symbol: string,
    days: number = 30,
    interval: "1minute" | "15minute" | "day" = "day"
  ): Promise<any[]> {
    this.verifyCircuit();
    try {
      const instrumentToken = upstoxConfig.getInstrumentToken(symbol);
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - days);

      const toStr = toDate.toISOString().split("T")[0];
      const fromStr = fromDate.toISOString().split("T")[0];

      const intervalPath = interval === "day" ? "day" : interval === "15minute" ? "minutes/15" : "1minute";

      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentToken)}/${intervalPath}/${toStr}/${fromStr}`;
      const response = await axios.get(url, { headers: { "Accept": "application/json" } });

      const candles = response.data?.data?.candles || [];
      const formatted = candles.map((c: any) => ({
        t: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5] || 0),
      })).reverse();

      await HealthService.reportSuccess();
      return formatted;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getHistoricalBars", errorMsg, error.stack);
      throw error;
    }
  }

  /**
   * Fetch the Last Traded Price (LTP) of a stock
   */
  static async getLastTradedPrice(symbol: string): Promise<number> {
    this.verifyCircuit();
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
      const ltp = parseFloat(ltpData[key]?.last_price || 0);

      await HealthService.reportSuccess();
      return ltp;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getLastTradedPrice", errorMsg, error.stack);
      throw error;
    }
  }
}
