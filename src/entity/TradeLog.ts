import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("trade_logs")
export class TradeLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index()
    symbol!: string;

  @Column()
    action!: "BUY" | "SELL";

  @Column()
    price!: number;

  @Column()
    qty!: number;

  @Column()
    totalAmount!: number;

  @Column()
    strategy!: string;

  @Column()
    signalReason!: string;

  @Column()
    brokerOrderId?: string; // Upstox Order ID

  @Column()
    transactionFees?: number; // Upstox & Govt charges paid

  @Column()
    portfolioValueAfterTrade?: number; // Snapshot of portfolio value

  @CreateDateColumn()
  @Index()
    createdAt!: Date;
}
