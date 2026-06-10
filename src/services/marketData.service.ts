import WebSocket from "ws";
import protobuf from "protobufjs";
import path from "path";
import axios from "axios";
import { EventEmitter } from "events";
import { upstoxConfig } from "../config/upstox";

export class MarketDataService extends EventEmitter {
  private static instance: MarketDataService;
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

  private startPaperStream() {
    this.paperIntervals.forEach(clearInterval);
    this.paperIntervals = [];

    const initialPrices: Record<string, number> = {
      RELIANCE: 2450.0,
      TCS: 3200.0,
      INFY: 1450.0
    };

    this.subscribedSymbols.forEach(symbol => {
      let currentPrice = initialPrices[symbol] || 1000.0;

      const interval = setInterval(() => {
        const changePercent = (Math.random() - 0.5) * 0.002;
        currentPrice += currentPrice * changePercent;
        this.emit("priceUpdate", { symbol, ltp: currentPrice });
      }, 2000);

      this.paperIntervals.push(interval);
    });
  }

  private getSymbolFromToken(token: string): string {
    for (const [symbol, instrToken] of Object.entries(upstoxConfig.instruments)) {
      if (instrToken === token) return symbol;
    }
    return token.split("|")[0] || token;
  }
}
export const marketDataService = MarketDataService.getInstance();
