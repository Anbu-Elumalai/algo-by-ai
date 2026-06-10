import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("trading_audits")
export class TradingAudit {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    username!: string; // Username of the admin performing the action

  @Column()
    action!: "START_BOT" | "STOP_BOT" | "FORCE_EXIT" | "RESTART_BOT" | "SEED_USER";

  @Column()
    ipAddress!: string; // IP of request origin

  @Column()
    details?: string; // Additional details of execution or results

  @CreateDateColumn()
    createdAt!: Date;
}
