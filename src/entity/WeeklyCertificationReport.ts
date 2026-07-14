import { Entity, ObjectIdColumn, ObjectId, Column } from "typeorm";

@Entity("weekly_certification_reports")
export class WeeklyCertificationReport {
  @ObjectIdColumn()
  _id!: ObjectId;

  @Column()
  weekIdentifier!: string;

  @Column()
  generatedAt!: Date;

  @Column()
  strategyVersion!: string;

  @Column()
  executiveSummary!: string;

  @Column()
  pdfPath?: string;

  @Column()
  htmlPath?: string;

  @Column()
  datasetValidation!: {
    weekStart: string;
    weekEnd: string;
    timezone: string;
    collectionsCounts: Record<string, number>;
  };

  @Column()
  engineeringHealth!: {
    duplicateEvalsCount: number;
    duplicateBuysCount: number;
    stalePricesCount: number;
    lookaheadBiasCount: number;
    reconciliationMismatch: number;
    overallScore: number;
  };

  @Column()
  strategyMetrics!: {
    totalEvaluations: number;
    buyCount: number;
    sellCount: number;
    holdCount: number;
    buyPct: number;
    sellPct: number;
    holdPct: number;
    crossovers: number;
    completedTrades: number;
    openTrades: number;
  };

  @Column()
  filterEffectiveness!: any[];

  @Column()
  rankedFilters!: any[];

  @Column()
  nearMisses!: any[];

  @Column()
  marketRegime!: any[];

  @Column()
  symbolAnalysis!: any[];

  @Column()
  weekOverWeekTrend!: any[];

  @Column()
  filterAblation!: any[];

  @Column()
  statisticalReadiness!: {
    completedTrades: number;
    profitFactor: number;
    expectancy: number;
    recoveryFactor: number;
    sharpe: number;
    sortino: number;
    calmar: number;
    mdd: number;
    sampleSizeStatus: string;
  };

  @Column()
  confidenceScores!: {
    engineering: number;
    data: number;
    statistical: number;
    strategy: number;
    overall: number;
  };

  @Column()
  finalVerdict!: {
    engineeringPlatformHealthy: boolean;
    strategyBehavingCorrectly: boolean;
    moreOpportunitiesThanLastWeek: boolean;
    mostBlockingFilter: string;
    movingCloser: boolean;
    continuePaperTrading: boolean;
    evidenceEnoughForModification: boolean;
  };
}
