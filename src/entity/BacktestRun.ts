import { Entity, ObjectIdColumn, ObjectId, Column, CreateDateColumn } from "typeorm";

@Entity("backtest_runs")
export class BacktestRun {
  @ObjectIdColumn()
  _id!: ObjectId;

  @Column()
  symbol!: string;

  @Column()
  fromDate!: string;

  @Column()
  toDate!: string;

  @Column()
  capital!: number;

  @Column()
  brokerage!: number;

  @Column()
  slippage!: number;

  @Column()
  totalTrades!: number;

  @Column()
  winRatePercent!: number;

  @Column()
  profitFactor!: number;

  @Column()
  expectancy!: number;

  @Column()
  maxDrawdownPercent!: number;

  @Column()
  sharpeRatio!: number;

  @Column()
  sortinoRatio!: number;

  @Column()
  calmarRatio!: number;

  @Column()
  finalBalance!: number;

  @Column()
  totalReturnPercent!: number;

  @Column("json")
  report!: any;

  @Column("json")
  trades!: any[];

  @Column("json")
  chartsData!: {
    equityCurve: number[];
    drawdownCurve: number[];
    monthlyReturns: Record<string, number>;
  };

  @CreateDateColumn()
  createdAt!: Date;
}
