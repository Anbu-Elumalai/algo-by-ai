import { Entity, ObjectIdColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("active_positions")
export class ActivePosition {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    symbol!: string;

  @Column()
    qty!: number;

  @Column()
    avgEntryPrice!: number;

  @Column()
    peakPrice!: number; // Highest price since opening the position

  @Column()
    trailingStopPrice!: number; // Computed threshold for selling

  @Column()
    stopLossPercent!: number; // Stop loss percentage (e.g., 0.02)

  @CreateDateColumn()
    createdAt!: Date;

  @UpdateDateColumn()
    updatedAt!: Date;
}
