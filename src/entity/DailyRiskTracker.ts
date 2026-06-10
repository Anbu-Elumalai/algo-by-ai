import { Entity, ObjectIdColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("daily_risk_trackers")
export class DailyRiskTracker {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column({ unique: true })
    date!: string; // Format: "YYYY-MM-DD"

  @Column()
    startingEquity!: number; // Measured at first check of the day

  @Column()
    currentEquity!: number;

  @Column()
    tradeCount!: number; // Number of trades completed today

  @Column()
    isHalted!: boolean; // Set to true if daily thresholds breached

  @CreateDateColumn()
    createdAt!: Date;

  @UpdateDateColumn()
    updatedAt!: Date;
}
