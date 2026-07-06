import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("runtime_status_reports")
export class RuntimeStatusReport {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    generatedAt!: Date;

  @Column("simple-json")
    session!: {
      currentTime: string;
      botUptime: number; // seconds
      tradingMode: string; // "PAPER" | "LIVE"
      strategyVersion: string;
      marketStatus: string; // "OPEN" | "CLOSED"
      marketSession: string;
    };

  @Column("simple-json")
    health!: {
      tradingLoop: string;
      webSocket: string;
      priceEngine: string;
      candleEngine: string;
      strategyEngine: string;
      riskEngine: string;
      paperBroker: string;
      positionReconciliation: string;
      cacheStatus: string;
      circuitBreaker: string;
    };

  @Column("simple-json")
    market!: Array<{
      symbol: string;
      latestPrice: number;
      tickAge: number;
      feedStatus: string;
      latestCompleted15mCandle: string;
      currentLiveCandle: string;
      latest1HCandle: string;
    }>;

  @Column("simple-json")
    strategy!: {
      evaluationsCount: number;
      buyCount: number;
      sellCount: number;
      holdCount: number;
      ordersExecuted: number;
      ordersRejected: number;
      completedTrades: number;
      openTrades: number;
      averageTradeScore: number;
      averageRsi: number;
      averageAdx: number;
      averageAtr: number;
    };

  @Column("simple-json")
    filters!: {
      goldenCrossFailures: number;
      rsiFailures: number;
      adxFailures: number;
      volumeFailures: number;
      riskRewardFailures: number;
      tradeScoreFailures: number;
      sidewaysFailures: number;
      topRejectionReasons: string[];
    };

  @Column("simple-json")
    nearMisses!: Array<{
      timestamp: string;
      symbol: string;
      tradeScore: number;
      requiredScore: number;
      riskReward: number;
      adx: number;
      rsi: number;
      reason: string;
    }>;

  @Column("simple-json")
    performance!: {
      currentEquity: number;
      cash: number;
      buyingPower: number;
      dailyPnl: number;
      grossProfit: number;
      grossLoss: number;
      netProfit: number;
      brokerage: number;
      openPositionValue: number;
      drawdown: number;
    };

  @Column("simple-json")
    positions!: Array<{
      symbol: string;
      qty: number;
      averageEntryPrice: number;
      currentPrice: number;
      currentPnl: number;
      trailingStopPrice: number;
      peakPrice: number;
      reconciliationStatus: string;
    }>;

  @Column("simple-json")
    infrastructure!: {
      webSocketDisconnects: number;
      webSocketReconnects: number;
      restFailures: number;
      tokenRefreshes: number;
      mongoDbLatency: number;
      feedLatency: number;
      memoryUsagePercent: number;
      cpuUsagePercent: number;
      nodeHeapUsed: number;
      cacheSize: number;
    };

  @Column("simple-json")
    recommendation!: {
      status: string; // "🟢 Trading Normally" | "🟡 Observation Mode" | "🔴 Engineering Issue Detected"
      explanation: string;
    };

  @Column()
    overallScore!: number;

  @CreateDateColumn()
    createdAt!: Date;
}
