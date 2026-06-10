import { Entity, ObjectIdColumn, Column, CreateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("users")
export class User {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    username!: string;

  @Column()
    password!: string; // Hashed password

  @Column()
    role!: "admin" | "viewer";

  @CreateDateColumn()
    createdAt!: Date;
}
