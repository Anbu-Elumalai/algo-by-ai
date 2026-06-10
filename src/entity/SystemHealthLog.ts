import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("system_health_logs")
export class SystemHealthLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    wsStatus!: "CONNECTED" | "DISCONNECTED" | "PAPER_SIMULATOR";

  @Column()
    databaseStatus!: "CONNECTED" | "DISCONNECTED";

  @Column()
    activeTradingLoop!: boolean;

  @Column()
    cpuUsagePercent!: number;

  @Column()
    memoryUsagePercent!: number;

  @Column()
    freeMemoryBytes!: number;

  @Column()
    totalMemoryBytes!: number;

  @CreateDateColumn()
    createdAt!: Date;
}
