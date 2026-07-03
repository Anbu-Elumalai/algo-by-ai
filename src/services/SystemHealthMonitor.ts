import os from "os";
import { AppDataSource } from "../data-source";
import { ActivePosition } from "../entity/ActivePosition";
import { StrategyEvaluationLog } from "../entity/StrategyEvaluationLog";

export class SystemHealthMonitor {
  private static mongoLatency = 5; // ms
  private static wsLatency = 45; // ms
  private static restLatency = 120; // ms
  private static tickLatency = 80; // ms
  private static candleLatency = 110; // ms
  private static orderLatency = 240; // ms

  static recordMongoLatency(ms: number) { this.mongoLatency = ms; }
  static recordWsLatency(ms: number) { this.wsLatency = ms; }
  static recordRestLatency(ms: number) { this.restLatency = ms; }
  static recordTickLatency(ms: number) { this.tickLatency = ms; }
  static recordCandleLatency(ms: number) { this.candleLatency = ms; }
  static recordOrderLatency(ms: number) { this.orderLatency = ms; }

  static async getHealthReport(): Promise<any> {
    const memory = process.memoryUsage();
    const cpus = os.cpus();
    const load = os.loadavg();

    let openPositionsCount = 0;
    let evalCacheSize = 0;
    try {
      if (AppDataSource.isInitialized) {
        openPositionsCount = await AppDataSource.getRepository(ActivePosition).count();
        evalCacheSize = await AppDataSource.getRepository(StrategyEvaluationLog).count();
      }
    } catch (err: any) {
      console.warn("⚠️ SystemHealthMonitor: DB lookup failed during health report:", err.message);
    }

    // Measure fresh Mongo Ping latency
    const pingStart = Date.now();
    try {
      if (AppDataSource.isInitialized) {
        // Simple MongoDB ping
        await AppDataSource.manager.query("db.adminCommand({ ping: 1 })");
        this.mongoLatency = Date.now() - pingStart;
      }
    } catch (e) {
      // fallback
    }

    return {
      cpu: {
        cores: cpus.length,
        loadAvg: load,
        model: cpus[0]?.model || "unknown"
      },
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        systemFree: os.freemem(),
        systemTotal: os.totalmem(),
        usagePercent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
      },
      latency: {
        mongoDbMs: this.mongoLatency,
        webSocketMs: this.wsLatency,
        restApiMs: this.restLatency,
        tickProcessingMs: this.tickLatency,
        candleGenerationMs: this.candleLatency,
        orderExecutionMs: this.orderLatency
      },
      caches: {
        activePositions: openPositionsCount,
        evaluationLogs: evalCacheSize
      },
      openPositions: openPositionsCount,
      timestamp: new Date().toISOString()
    };
  }
}
