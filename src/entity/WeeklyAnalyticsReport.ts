import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("weekly_analytics_reports")
export class WeeklyAnalyticsReport {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index({ unique: true })
    weekIdentifier!: string; // e.g. YYYY-WW or date string

  @Column("simple-json")
    metrics!: {
      totalTrades: number;
      winRate: number;
      profitFactor: number;
      netProfit: number;
      maxDrawdown: number;
      sharpe: number;
      holdingTimeAvgMinutes: number;
    };

  @Column("simple-json")
    filterEffectiveness!: Record<string, number>;

  @Column("simple-json")
    distributionSymbol!: Record<string, { trades: number; netProfit: number }>;

  @Column("simple-json")
    exitTypeDistribution!: Record<string, number>;

  @CreateDateColumn()
    createdAt!: Date;
}
