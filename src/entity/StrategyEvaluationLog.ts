import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("strategy_evaluation_logs")
export class StrategyEvaluationLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index()
    date!: string; // YYYY-MM-DD for fast date aggregation

  @Column()
    timestamp!: string; // ISO timestamp string

  @Column()
  @Index()
    symbol!: string;

  @Column()
    strategyVersion!: string;

  @Column()
    candleTimestamp!: string;

  @Column()
    signal!: "BUY" | "HOLD" | "SELL";

  @Column()
    reason!: string;

  @Column()
    tradeScore!: number;

  @Column("simple-json")
    indicators!: {
      fastSMA: number;
      slowSMA: number;
      rsi: number;
      adx: number;
      atr: number;
      volume: number;
      averageVolume: number;
      ema50_1H: number;
      riskReward: number;
      choppiness: number;
      bbw: number;
    };

  @Column("simple-json")
    filters!: {
      goldenCross: boolean;
      rsi: boolean;
      adx: boolean;
      volume: boolean;
      trend1H: boolean;
      riskReward: boolean;
      sideways: boolean;
      tradeScore: boolean;
    };

  @Column("simple-json")
    execution!: {
      orderPlaced: boolean;
      blockedReason?: string;
    };

  @CreateDateColumn()
    createdAt!: Date;
}
