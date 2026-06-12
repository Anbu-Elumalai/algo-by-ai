import { Entity, ObjectIdColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("order_journals")
export class OrderJournal {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index({ unique: true })
    idempotencyKey!: string;

  @Column()
    correlationId!: string;

  @Column()
  @Index()
    symbol!: string;

  @Column()
    qty!: number;

  @Column()
    side!: "BUY" | "SELL";

  @Column()
    orderType!: "MARKET" | "LIMIT";

  @Column({ nullable: true })
    price?: number;

  @Column()
  @Index()
    status!: "INITIATED" | "SUBMITTED" | "SUCCESS" | "FAILED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";

  @Column({ nullable: true })
    brokerOrderId?: string;

  @Column({ nullable: true })
    errorMessage?: string;

  @CreateDateColumn()
    createdAt!: Date;

  @UpdateDateColumn()
    updatedAt!: Date;
}
