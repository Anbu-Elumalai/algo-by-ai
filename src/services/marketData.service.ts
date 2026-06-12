import WebSocket from "ws";
import protobuf from "protobufjs";
import path from "path";
import axios from "axios";
import { EventEmitter } from "events";
import { upstoxConfig } from "../config/upstox";

export class MarketDataService extends EventEmitter {
  private static instance: MarketDataService;
  public static simulatedPrices = new Map<string, number>();
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxBackoff = 60000; // 60s
  private baseBackoff = 1000;  // 1s
  private subscribedSymbols = new Set<string>();
  private protoRoot: protobuf.Root | null = null;
  private feedResponseType: protobuf.Type | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private mode: "PAPER" | "LIVE" = "PAPER";
  private paperIntervals: NodeJS.Timeout[] = [];

  private constructor() {
    super();
    this.mode = (process.env.TRADING_MODE as "PAPER" | "LIVE") || "PAPER";
  }

  static getInstance(): MarketDataService {
    if (!MarketDataService.instance) {
      MarketDataService.instance = new MarketDataService();
    }
    return MarketDataService.instance;
  }

  getMode() {
    return this.mode;
  }

  async loadProtobuf() {
    if (this.protoRoot) return;
    try {
      const protoPath = path.resolve(__dirname, "../config/MarketDataFeed.proto");
      this.protoRoot = await protobuf.load(protoPath);
      this.feedResponseType = this.protoRoot.lookupType("com.upstox.marketdatafeeder.rpc.proto.FeedResponse");
      console.log("✅ Protobuf definition schema loaded successfully.");
    } catch (err: any) {
      console.error("❌ Failed to load MarketDataFeed.proto:", err.message);
    }
  }

  async connect() {
    if (this.isConnected) return;

    if (this.mode === "PAPER") {
      this.isConnected = true;
      console.log("📝 Running in PAPER Trading Mode. WebSocket data will be simulated.");
      this.startPaperStream();
      return;
    }

    console.log("📡 Connecting to live Upstox WebSocket market data feed...");
    await this.loadProtobuf();

    try {
      const authUrlResponse = await axios.get(
        "https://api.upstox.com/v2/feed/market-data-feed/authorize",
        {
          headers: {
            "Authorization": `Bearer ${upstoxConfig.accessToken}`,
            "Accept": "application/json"
          }
        }
      );

      const wsUrl = authUrlResponse.data?.data?.authorized_redirect_uri;
      if (!wsUrl) {
        throw new Error("Authorized redirect URL missing from Upstox authorize API response.");
      }

      this.ws = new WebSocket(wsUrl, {
        followRedirects: true
      });

      this.ws.binaryType = "nodebuffer";

      this.ws.on("open", () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log("✅ Upstox WebSocket connected successfully.");
        this.emit("connected");

        if (this.subscribedSymbols.size > 0) {
          this.subscribe(Array.from(this.subscribedSymbols));
        }

        this.startHeartbeat();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          if (this.feedResponseType) {
            const message = this.feedResponseType.decode(data);
            const obj = this.feedResponseType.toObject(message, {
              longs: String,
              enums: String,
              bytes: String
            });

            if (obj.feeds) {
              for (const [key, feed] of Object.entries(obj.feeds)) {
                const ltp = (feed as any).ltpc?.ltp || (feed as any).fullFeed?.ltpc?.ltp;
                if (ltp !== undefined) {
                  this.emit("priceUpdate", { symbol: this.getSymbolFromToken(key), ltp });
                }
              }
            }
          }
        } catch (e: any) {
          console.error("❌ Failed to decode incoming WebSocket binary frame:", e.message);
        }
      });

      this.ws.on("close", () => {
        this.isConnected = false;
        console.warn("⚠️ Upstox WebSocket disconnected.");
        this.stopHeartbeat();
        this.reconnect();
      });

      this.ws.on("error", (err: any) => {
        console.error("❌ Upstox WebSocket error:", err.message);
      });

    } catch (error: any) {
      console.error("❌ WebSocket auth/connection failed:", error.message);
      this.reconnect();
    }
  }

  private reconnect() {
    this.reconnectAttempts++;
    const backoff = Math.min(this.baseBackoff * Math.pow(2, this.reconnectAttempts), this.maxBackoff);
    console.log(`🔄 Reconnecting to WebSocket in ${(backoff / 1000).toFixed(1)} seconds (Attempt ${this.reconnectAttempts})...`);
    setTimeout(() => {
      this.connect();
    }, backoff);
  }

  subscribe(symbols: string[]) {
    symbols.forEach(sym => this.subscribedSymbols.add(sym.toUpperCase()));

    if (!this.isConnected) return;

    if (this.mode === "PAPER") {
      this.startPaperStream();
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const keys = symbols.map(sym => upstoxConfig.getInstrumentToken(sym));
      const subPayload = {
        guid: "sub-guid-123",
        method: "sub",
        data: {
          mode: "ltpc",
          instrumentKeys: keys
        }
      };

      this.ws.send(Buffer.from(JSON.stringify(subPayload)));
      console.log(`📡 WebSocket subscription sent for: ${symbols.join(", ")}`);
    }
  }

  unsubscribe(symbols: string[]) {
    symbols.forEach(sym => this.subscribedSymbols.delete(sym.toUpperCase()));

    if (!this.isConnected || this.mode === "PAPER") return;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const keys = symbols.map(sym => upstoxConfig.getInstrumentToken(sym));
      const unsubPayload = {
        guid: "unsub-guid-123",
        method: "unsub",
        data: {
          instrumentKeys: keys
        }
      };
      this.ws.send(Buffer.from(JSON.stringify(unsubPayload)));
      console.log(`📡 WebSocket unsubscribe sent for: ${symbols.join(", ")}`);
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  healthCheck() {
    return {
      connected: this.isConnected,
      mode: this.mode,
      subscriptions: Array.from(this.subscribedSymbols)
    };
  }

  private async startPaperStream() {
    this.paperIntervals.forEach(clearInterval);
    this.paperIntervals = [];

    const symbols = Array.from(this.subscribedSymbols);
    const resolvedPrices = new Map<string, number>();

    const { UpstoxService } = require("./upstox.service");

    for (const symbol of symbols) {
      let currentPrice = 0;
      let success = false;
      const attempts = 3;
      const delayMs = 1000;
      let lastError: any = null;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          currentPrice = await UpstoxService.getLastTradedPrice(symbol);
          if (currentPrice > 0) {
            success = true;
            break;
          }
          throw new Error(`Fetched price is zero or negative: ₹${currentPrice}`);
        } catch (err: any) {
          lastError = err;
          console.warn(`⚠️ Simulator initialization attempt ${attempt}/${attempts} failed for ${symbol}: ${err.message}`);
          if (attempt < attempts) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      }

      if (!success) {
        const errorReason = `Simulator failed to fetch live LTP for ${symbol} after ${attempts} attempts: ${lastError?.message || "Unknown error"}`;
        console.error(`❌ ${errorReason}`);
        
        // Emit critical error event to pause trading
        this.emit("criticalError", errorReason);
        return;
      }

      resolvedPrices.set(symbol, currentPrice);
      MarketDataService.simulatedPrices.set(symbol, currentPrice);
      console.log(`📡 Simulator initialized ${symbol} dynamically from real LTP: ₹${currentPrice.toFixed(2)}`);
    }

    // Start paper ticks only if all prices resolved successfully
    for (const symbol of symbols) {
      let currentPrice = resolvedPrices.get(symbol)!;
      const interval = setInterval(() => {
        const changePercent = (Math.random() - 0.5) * 0.002;
        currentPrice += currentPrice * changePercent;
        MarketDataService.simulatedPrices.set(symbol, currentPrice);
        this.emit("priceUpdate", { symbol, ltp: currentPrice });
      }, 2000);

      this.paperIntervals.push(interval);
    }
  }

  private getSymbolFromToken(token: string): string {
    for (const [symbol, instrToken] of Object.entries(upstoxConfig.instruments)) {
      if (instrToken === token) return symbol;
    }
    return token.split("|")[0] || token;
  }
}
export const marketDataService = MarketDataService.getInstance();
