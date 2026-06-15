import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("feed_health_logs")
export class FeedHealthLog {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    symbol!: string;

  @Column()
    wsPrice!: number;

  @Column()
    restPrice!: number;

  @Column()
    divergence!: number;

  @CreateDateColumn()
    createdAt!: Date;
}
