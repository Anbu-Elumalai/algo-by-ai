import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("runtime_daily_audits")
export class RuntimeDailyAudit {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index({ unique: true })
    date!: string; // YYYY-MM-DD

  @Column("simple-json")
    sessionInfo!: {
      marketOpen: string;
      marketClose: string;
      botUptime: number; // seconds
      tradingMode: string;
      strategyVersion: string;
    };

  @Column("simple-json")
    strategyStats!: {
      evaluations: number;
      buyCount: number;
      sellCount: number;
      holdCount: number;
      ordersExecuted: number;
      ordersRejected: number;
      completedTrades: number;
      openTrades: number;
    };

  @Column("simple-json")
    filterStats!: {
      goldenCrossFailures: number;
      rsiFailures: number;
      adxFailures: number;
      volumeFailures: number;
      trend1HFailures: number;
      riskRewardFailures: number;
      tradeScoreFailures: number;
      sidewaysFailures: number;
      topRejectionReason: string;
      secondRejectionReason: string;
    };

  @Column("simple-json")
    performance!: {
      winRate: number;
      lossRate: number;
      profitFactor: number;
      expectancy: number;
      grossProfit: number;
      grossLoss: number;
      netProfit: number;
      drawdown: number;
      sharpe: number;
      sortino: number;
      calmar: number;
      recoveryFactor: number;
      capitalUtilization: number;
      capitalEfficiency: number;
    };

  @Column("simple-json")
    risk!: {
      startingEquity: number;
      endingEquity: number;
      peakEquity: number;
      lowestEquity: number;
      maxDrawdown: number;
      dailyRiskHalt: boolean;
      circuitBreaker: string; // CLOSED, OPEN
      trailingStopHits: number;
      atrStopHits: number;
    };

  @Column("simple-json")
    infrastructure!: {
      webSocketDisconnects: number;
      webSocketReconnects: number;
      restFailures: number;
      tokenRefreshes: number;
      priceEngineHealth: string;
      feedLatency: number;
      cacheSyncStatus: string;
      positionReconciliationStatus: string;
    };

  @Column("simple-json")
    healthScore!: {
      engineeringScore: number;
      infrastructureScore: number;
      strategyScore: number;
      riskScore: number;
      performanceScore: number;
      overallScore: number;
    };

  @CreateDateColumn()
    createdAt!: Date;
}
