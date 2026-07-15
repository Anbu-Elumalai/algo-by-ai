import axios from "axios";
import { upstoxConfig } from "../config/upstox";
import { HealthService } from "./health.service";
import { AppDataSource } from "../data-source";
import { TradeLog } from "../entity/TradeLog";
import { ActivePosition } from "../entity/ActivePosition";
import { PaperBrokerPosition } from "../entity/PaperBrokerPosition";

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
    if (process.env.TRADING_MODE === "PAPER") {
      return;
    }
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

      const mongoTradeRepo = AppDataSource.getMongoRepository(TradeLog);
      const aggResult = await mongoTradeRepo.aggregate([
        {
          $group: {
            _id: null,
            totalBuy: {
              $sum: {
                $cond: [
                  { $eq: ["$action", "BUY"] },
                  { $add: ["$totalAmount", { $ifNull: ["$transactionFees", 40] }] },
                  0
                ]
              }
            },
            totalSell: {
              $sum: {
                $cond: [
                  { $eq: ["$action", "SELL"] },
                  { $subtract: ["$totalAmount", { $ifNull: ["$transactionFees", 40] }] },
                  0
                ]
              }
            }
          }
        }
      ]).toArray();

      const netPnL = aggResult.length > 0 ? (aggResult[0].totalSell - aggResult[0].totalBuy) : 0;
      const cash = 100000.0 + netPnL;

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
    // Intercept if in PAPER trading mode
    if (process.env.TRADING_MODE === "PAPER") {
      return this.getPaperAccount();
    }

    this.verifyCircuit();

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
   * Fetch active user profile from Upstox (auth token verification)
   */
  static async getProfile(): Promise<any> {
    if (process.env.TRADING_MODE === "PAPER") {
      return { status: "success", data: { email: "paper@trading.sim", name: "Paper Trader" } };
    }

    this.verifyCircuit();

    try {
      if (!upstoxConfig.accessToken) {
        throw new Error("No Upstox Access Token provided! Please authenticate.");
      }

      const response = await axios.get(
        `${upstoxConfig.baseUrl}/user/profile`,
        { headers: this.getHeaders() }
      );

      const data = response.data?.data;
      if (!data) {
        throw new Error("Invalid response schema returned from Upstox Profile API.");
      }

      await HealthService.reportSuccess();
      return data;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getProfile", errorMsg, error.stack);
      throw error;
    }
  }

  /**
   * Fetch active intraday/delivery holdings.
   * In PAPER mode, reads from the independent `paper_broker_positions` collection
   * so that the reconciliation engine can detect divergences between the bot's
   * `active_positions` and the simulated broker's state.
   */
  static async getPositions(): Promise<UpstoxPosition[]> {
    if (process.env.TRADING_MODE === "PAPER") {
      try {
        const repo = AppDataSource.getRepository(PaperBrokerPosition);
        const brokerPositions = await repo.find();

        const formatted: UpstoxPosition[] = [];
        for (const pos of brokerPositions) {
          let currentPrice = pos.currentPrice || pos.avgEntryPrice;
          try {
            const { PriceEngine } = require("./PriceEngine");
            const ltp = await PriceEngine.getLastPrice(pos.symbol);
            if (ltp > 0) {
              currentPrice = ltp;
              // Keep currentPrice fresh in the broker record
              pos.currentPrice = ltp;
              pos.unrealizedPl = (ltp - pos.avgEntryPrice) * pos.qty;
              await repo.save(pos);
            }
          } catch {
            // Keep stored currentPrice as fallback
          }
          formatted.push({
            symbol: pos.symbol,
            qty: pos.qty,
            avgEntryPrice: pos.avgEntryPrice,
            currentPrice: currentPrice,
            unrealizedPl: pos.unrealizedPl,
          });
        }
        return formatted;
      } catch (err: any) {
        console.error("❌ Failed to fetch paper broker positions from DB:", err.message);
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
    // Intercept if in PAPER trading mode — maintain an independent PaperBrokerPosition record
    if (process.env.TRADING_MODE === "PAPER") {
      const mockOrderId = `paper-order-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const sym = symbol.toUpperCase();
      console.log(`📝 [PAPER TRADE] Simulating ${side} order: ${qty} shares of ${sym}`);

      try {
        const repo = AppDataSource.getRepository(PaperBrokerPosition);
        let currentPx = price || 0;
        try {
          const { PriceEngine } = require("./PriceEngine");
          const ltp = await PriceEngine.getLastPrice(sym);
          if (ltp > 0) currentPx = ltp;
        } catch { /* use provided price */ }

        if (side === "BUY") {
          // Create or accumulate broker position
          const existing = await repo.findOne({ where: { symbol: sym } as any });
          if (existing) {
            // Weighted average entry price
            const totalCost = existing.avgEntryPrice * existing.qty + currentPx * qty;
            existing.qty += qty;
            existing.avgEntryPrice = totalCost / existing.qty;
            existing.currentPrice = currentPx;
            existing.unrealizedPl = (currentPx - existing.avgEntryPrice) * existing.qty;
            existing.brokerOrderId = mockOrderId;
            await repo.save(existing);
          } else {
            const newPos = new PaperBrokerPosition();
            newPos.symbol = sym;
            newPos.qty = qty;
            newPos.avgEntryPrice = currentPx;
            newPos.currentPrice = currentPx;
            newPos.unrealizedPl = 0;
            newPos.brokerOrderId = mockOrderId;
            await repo.save(newPos);
          }
          console.log(`📝 [PAPER BROKER] BUY recorded: ${qty} x ${sym} @ ₹${currentPx.toFixed(2)}`);
        } else if (side === "SELL") {
          // Remove or decrement broker position
          const existing = await repo.findOne({ where: { symbol: sym } as any });
          if (existing) {
            if (existing.qty <= qty) {
              await repo.delete({ _id: existing._id });
            } else {
              existing.qty -= qty;
              existing.currentPrice = currentPx;
              existing.unrealizedPl = (currentPx - existing.avgEntryPrice) * existing.qty;
              existing.brokerOrderId = mockOrderId;
              await repo.save(existing);
            }
          }
          console.log(`📝 [PAPER BROKER] SELL recorded: ${qty} x ${sym} @ ₹${currentPx.toFixed(2)}`);
        }
      } catch (paperErr: any) {
        console.error("❌ Failed to update paper broker position:", paperErr.message);
      }

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

      if (ltp <= 0) {
        throw new Error(`Invalid LTP returned from broker: ₹${ltp}`);
      }

      await HealthService.reportSuccess();
      return ltp;
    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      await HealthService.reportFailure("UpstoxService.getLastTradedPrice", errorMsg, error.stack);
      throw new Error(`Market data unavailable for ${symbol}: ${errorMsg}`);
    }
  }
}
