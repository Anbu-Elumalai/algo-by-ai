import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("error_logs")
export class ErrorLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    context!: string; // Where the error happened (e.g., "UpstoxService", "TradingLoop")

  @Column()
    message!: string;

  @Column()
    stack?: string;

  @Column()
    severity!: "INFO" | "WARNING" | "ERROR" | "CRITICAL";

  @CreateDateColumn()
    createdAt!: Date;
}
