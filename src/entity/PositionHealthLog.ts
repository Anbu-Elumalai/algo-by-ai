import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("position_health_logs")
export class PositionHealthLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    activePositionsCount!: number;

  @Column()
    reconciledPositionsCount!: number;

  @Column()
    orphanPositionsCount!: number;

  @Column()
    mismatchesCount!: number;

  @Column()
    details!: string; // Stored JSON string containing mismatch descriptions

  @CreateDateColumn()
    createdAt!: Date;
}
