import { Entity, ObjectIdColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("strategy_metrics")
export class StrategyMetrics {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    symbol!: string;

  @Column()
    totalTrades!: number;

  @Column()
    winRatePercent!: number;

  @Column()
    lossRatePercent!: number;

  @Column()
    profitFactor!: number;

  @Column()
    sharpeRatio!: number;

  @Column()
    sortinoRatio!: number;

  @Column()
    maxDrawdownPercent!: number;

  @Column()
    avgWin!: number;

  @Column()
    avgLoss!: number;

  @Column()
    expectancy!: number;

  @Column()
    annualizedReturnPercent!: number;

  @CreateDateColumn()
    createdAt!: Date;

  @UpdateDateColumn()
    updatedAt!: Date;
}
