import { Entity, ObjectIdColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("refresh_tokens")
export class RefreshToken {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
    token!: string; // Secure random hash string

  @Column()
    userId!: string;

  @Column()
    role!: string; // "admin" etc.

  @Column()
    ipAddress!: string;

  @Column({ nullable: true })
    userAgent?: string;

  @Column({ default: false })
    isRevoked!: boolean;

  @Column()
    expiresAt!: Date;

  @CreateDateColumn()
    createdAt!: Date;

  @UpdateDateColumn()
    updatedAt!: Date;
}
