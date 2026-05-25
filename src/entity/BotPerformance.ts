import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("bot_performances")
export class BotPerformance {
  @ObjectIdColumn()
  _id!: ObjectId;

  @Column()
  equity!: number;

  @Column()
  cash!: number;

  @Column()
  buyingPower!: number;

  @Column()
  unrealizedPl!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
