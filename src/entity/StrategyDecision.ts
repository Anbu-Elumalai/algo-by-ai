import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("strategy_decisions")
export class StrategyDecision {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index()
    symbol!: string;

  @Column()
    fastSma!: number;

  @Column()
    slowSma!: number;

  @Column()
    rsi!: number;

  @Column()
    signal!: "BUY" | "SELL" | "HOLD";

  @Column()
    reason!: string;

  @CreateDateColumn()
    createdAt!: Date;
}
