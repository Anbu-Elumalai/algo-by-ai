import { Entity, ObjectIdColumn, Column, CreateDateColumn, Index } from "typeorm";
import { ObjectId } from "mongodb";

@Entity("monthly_certification_reports")
export class MonthlyCertificationReport {
  @ObjectIdColumn()
    _id!: ObjectId;

  @Column()
  @Index({ unique: true })
    monthIdentifier!: string; // e.g. YYYY-MM

  @Column("simple-json")
    complianceVerification!: {
      lookAheadBiasFree: boolean;
      parityConfirmed: boolean;
      consecutivePaperTrades: number;
    };

  @Column("simple-json")
    statistics!: {
      totalEvaluations: number;
      buySignals: number;
      sellSignals: number;
      holdSignals: number;
      totalTrades: number;
      netProfit: number;
    };

  @Column("simple-json")
    scores!: {
      engineeringScore: number;
      infrastructureScore: number;
      strategyScore: number;
      riskScore: number;
      performanceScore: number;
      overallScore: number;
    };

  @Column()
    finalVerdict!: string; // Ready for deployment, More paper trading required, etc.

  @CreateDateColumn()
    createdAt!: Date;
}
