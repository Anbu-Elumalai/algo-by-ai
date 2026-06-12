import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("execution_logs")
export class ExecutionLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index()
    symbol!: string;

  @Column()
    action!: "BUY" | "SELL";

  @Column()
    signalTime!: Date;

  @Column()
    signalPrice!: number;

  @Column()
    executionTime!: Date;

  @Column()
    executionPrice!: number;

  @Column()
    slippagePercent!: number;

  @Column()
    slippageAmount!: number;

  @Column()
    signalDelayMs!: number;

  @Column()
    executionDelayMs!: number;

  @CreateDateColumn()
    createdAt!: Date;
}
