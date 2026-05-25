import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("trade_logs")
export class TradeLog {
  @ObjectIdColumn()
  _id!: ObjectId;

  @Column()
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

  @CreateDateColumn()
  createdAt!: Date;
}
