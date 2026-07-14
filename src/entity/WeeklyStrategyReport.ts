import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("weekly_strategy_reports")
export class WeeklyStrategyReport {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index({ unique: true })
    weekIdentifier!: string; // e.g. "2026-W28" or YYYY-MM-DD representing Friday close

  @Column()
    generatedAt!: Date;

  @Column()
    strategyVersion!: string;

  @Column()
    executiveSummary!: string;

  @Column("simple-json")
    evaluationStatistics!: {
      totalEvaluations: number;
      buyCount: number;
      sellCount: number;
      holdCount: number;
      buyPct: number;
      holdPct: number;
      avgTradeScore: number;
      avgAdx: number;
      avgRsi: number;
      avgAtr: number;
      avgRiskReward: number;
      avgVolumeRatio: number;
    };

  @Column("simple-json")
    filterAnalysis!: {
      filterStats: Array<{
        filter: string;
        passed: number;
        failed: number;
        passPct: number;
        failPct: number;
      }>;
      blockedCrossoverCount: number;
      blockedRanking: Array<{
        filter: string;
        failed: number;
        pct: number;
      }>;
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
      failedFiltersCount: number;
      failedFilters: string;
    }>;

  @Column("simple-json")
    marketRegime!: Array<{
      regime: string;
      evaluations: number;
      buyCount: number;
      buyPct: number;
    }>;

  @Column("simple-json")
    symbolAnalysis!: Array<{
      symbol: string;
      evaluations: number;
      buys: number;
      avgScore: number;
      avgRr: number;
      avgAdx: number;
      avgRsi: number;
      avgVolRatio: number;
      mostFailedFilter: string;
    }>;

  @Column("simple-json")
    engineeringHealth!: {
      duplicateEvalsCount: number;
      duplicateBuysCount: number;
      incompleteCandlesCount: number;
      lookaheadBiasCount: number;
      stalePricesCount: number;
      reconciliationMismatch: number;
      missingStrategyLogs: string;
      overallScore: number;
    };

  @Column("simple-json")
    strategyHealth!: {
      winRate: number;
      profitFactor: number;
      netProfit: number;
      completedTrades: number;
      openTrades: number;
      overallScore: number;
    };

  @Column("simple-json")
    recommendation!: {
      status: string;
      explanation: string;
    };

  @Column("simple-json")
    reportJson!: any;

  @Column()
    pdfPath!: string;

  @Column()
    htmlPath!: string;

  @Column("simple-json")
    emailStatus!: {
      emailSent: boolean;
      emailSentAt?: Date;
      recipientList: string[];
      deliveryStatus: "PENDING" | "SENT" | "FAILED";
      errorMessage?: string;
      retryCount: number;
    };

  @CreateDateColumn()
    createdAt!: Date;
}
