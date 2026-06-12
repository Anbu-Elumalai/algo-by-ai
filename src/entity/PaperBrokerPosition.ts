import { Entity, ObjectIdColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("paper_broker_positions")
export class PaperBrokerPosition {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    symbol!: string;

  @Column()
    qty!: number;

  @Column()
    avgEntryPrice!: number;

  @Column()
    currentPrice!: number;

  @Column()
    unrealizedPl!: number;

  @Column({ nullable: true })
    brokerOrderId?: string;

  @CreateDateColumn()
    createdAt!: Date;

  @UpdateDateColumn()
    updatedAt!: Date;
}
