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
  private hasAuthError = false;
  private subscribedSymbols = new Set<string>();
  private protoRoot: protobuf.Root | null = null;
  private feedResponseType: protobuf.Type | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private mode: "PAPER" | "LIVE" = "PAPER";

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

  async connect(awaitConnection = false): Promise<void> {
    if (this.isConnected) return;

    console.log("📡 Connecting to live Upstox WebSocket market data feed...");
    this.hasAuthError = false; // Reset auth error flag on connect attempt
    await this.loadProtobuf();

    try {
      const authUrlResponse = await axios.get(
        "https://api.upstox.com/v3/feed/market-data-feed/authorize",
        {
          headers: {
            "Authorization": `Bearer ${upstoxConfig.accessToken}`,
            "Accept": "application/json"
          }
        }
      );
      console.log("Authorize Response:", authUrlResponse.data);
      const wsUrl = authUrlResponse.data?.data?.authorized_redirect_uri;
      if (!wsUrl) {
        throw new Error("Authorized redirect URL missing from Upstox authorize API response.");
      }

      console.log("Connecting to WS URL:", wsUrl);

      const wsInstance = new WebSocket(wsUrl, {
        followRedirects: true,
        headers: {
          "Accept": "*/*"
        }
      });

      wsInstance.on("unexpected-response", (req, res) => {
        console.error("Unexpected Response Status:", res.statusCode);
        console.error("Response Headers:", res.headers);
      });
      this.ws = wsInstance;

      wsInstance.binaryType = "nodebuffer";

      if (awaitConnection) {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const timeoutId = setTimeout(() => {
            wsInstance.on("error", () => {}); // Swallow connection abort errors on close
            cleanupHandshake();
            wsInstance.close();
            rejectPromise(new Error("WebSocket connection timed out after 10 seconds."));
          }, 10000);

          const onOpen = () => {
            clearTimeout(timeoutId);
            cleanupHandshake();

            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.hasAuthError = false;
            console.log("✅ Upstox WebSocket connected successfully.");
            this.emit("connected");

            this.setupPersistentListeners(wsInstance);
            resolvePromise();
          };

          const onError = (err: any) => {
            clearTimeout(timeoutId);
            cleanupHandshake();
            console.error("❌ Upstox WebSocket handshake error:", err.message);

            const isAuth = err.message && (err.message.includes("403") || err.message.includes("401") || err.message.includes("410"));
            if (isAuth) {
              this.hasAuthError = true;
              this.emit("criticalError", `Upstox WebSocket authorization failed (${err.message}). Please re-authenticate.`);
            }
            rejectPromise(err);
          };

          const onClose = () => {
            clearTimeout(timeoutId);
            cleanupHandshake();
            rejectPromise(new Error("WebSocket connection closed during handshake."));
          };

          const cleanupHandshake = () => {
            wsInstance.off("open", onOpen);
            wsInstance.off("error", onError);
            wsInstance.off("close", onClose);
          };

          wsInstance.on("open", onOpen);
          wsInstance.on("error", onError);
          wsInstance.on("close", onClose);
        });
      } else {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.hasAuthError = false;

        this.setupPersistentListeners(wsInstance);

        wsInstance.on("open", () => {
          console.log("✅ Upstox WebSocket connected successfully.");
          this.emit("connected");
        });
      }

    } catch (error: any) {
      const status = error.response?.status;
      const isAuthError = status === 401 || status === 403 || status === 410 ||
        (error.message && (error.message.includes("401") || error.message.includes("403") || error.message.includes("410")));

      if (isAuthError) {
        this.hasAuthError = true;
        console.error("❌ WebSocket auth failed (Unauthorized/HTTP 403/410). Reconnection halted.");
        this.emit("criticalError", `Upstox API Authorization failed (${error.message}). Please re-authenticate.`);
      } else {
        console.error("❌ WebSocket auth/connection failed:", error.message);
      }

      if (awaitConnection) {
        throw error;
      } else {
        if (!this.hasAuthError) {
          this.reconnect();
        }
      }
    }
  }

  private setupPersistentListeners(wsInstance: WebSocket) {
    wsInstance.on("message", (data: Buffer) => {
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

    wsInstance.on("close", () => {
      this.isConnected = false;
      console.warn("⚠️ Upstox WebSocket disconnected.");
      this.stopHeartbeat();
      if (this.hasAuthError) {
        console.warn("❌ WebSocket reconnect skipped due to authorization failure. Please authenticate.");
      } else {
        this.reconnect();
      }
    });

    wsInstance.on("error", (err: any) => {
      console.error("❌ Upstox WebSocket error:", err.message);
      const isAuthError = err.message && (err.message.includes("403") || err.message.includes("401") || err.message.includes("410"));
      if (isAuthError) {
        this.hasAuthError = true;
        this.emit("criticalError", `Upstox WebSocket authorization failed (${err.message}). Please re-authenticate.`);
      }
    });

    if (this.subscribedSymbols.size > 0) {
      this.subscribe(Array.from(this.subscribedSymbols));
    }

    this.startHeartbeat();
  }

  private reconnect() {
    this.reconnectAttempts++;
    const backoff = Math.min(this.baseBackoff * Math.pow(2, this.reconnectAttempts), this.maxBackoff);
    console.log(`🔄 Reconnecting to WebSocket in ${(backoff / 1000).toFixed(1)} seconds (Attempt ${this.reconnectAttempts})...`);
    setTimeout(() => {
      this.connect().catch(() => {
        // Suppress background reconnect logs to avoid double-printing stack traces
      });
    }, backoff);
  }

  subscribe(symbols: string[]) {
    symbols.forEach(sym => this.subscribedSymbols.add(sym.toUpperCase()));

    if (!this.isConnected) return;

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

    if (!this.isConnected) return;

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

  isWsOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  healthCheck() {
    return {
      connected: this.isWsOpen(),
      mode: this.mode,
      subscriptions: Array.from(this.subscribedSymbols)
    };
  }

  // Paper stream removed in favor of real market data feed

  private getSymbolFromToken(token: string): string {
    for (const [symbol, instrToken] of Object.entries(upstoxConfig.instruments)) {
      if (instrToken === token) return symbol;
    }
    return token.split("|")[0] || token;
  }
}
export const marketDataService = MarketDataService.getInstance();
