import "reflect-metadata";
import * as dotenv from "dotenv";

dotenv.config();

// Strict Environment & Secret Validation on boot-up
const REQUIRED_ENV = [
  "PORT",
  "MONGO_URI",
  "JWT_SECRET",
  "UPSTOX_API_KEY",
  "UPSTOX_API_SECRET",
  "UPSTOX_REDIRECT_URI"
];

for (const envVar of REQUIRED_ENV) {
  if (!process.env[envVar]) {
    console.error(`❌ CRITICAL BOOT CONFIG ERROR: Environment variable '${envVar}' is missing!`);
    process.exit(1);
  }
}

const jwtSecret = process.env.JWT_SECRET || "";
if (jwtSecret.length < 32) {
  console.error("❌ CRITICAL SECURITY BREACH: JWT_SECRET must be at least 32 characters (256-bit strength)!");
  process.exit(1);
}

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { useExpressServer } from "routing-controllers";
import { AppDataSource } from "./data-source";
import fileUpload from "express-fileupload";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger";
import { createServer } from "http";
import { TradingLoopService } from "./services/tradingLoop.service";

AppDataSource.initialize()
  .then(async () => {
    console.log("✅ Database connected successfully via TypeORM MongoDB Driver");

    const app = express();
    app.use(express.json());

    // Secure CORS Rules
    app.use(
      cors({
        origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : "*",
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Origin", "Content-Type", "Authorization"],
        credentials: true
      })
    );

    app.use(
      fileUpload({
        limits: { fileSize: 10 * 1024 * 1024 },
        abortOnLimit: true,
        useTempFiles: false
      })
    );

    app.use("/public", express.static("public"));
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

    const ext = __filename.endsWith(".ts") ? "ts" : "js";
    useExpressServer(app, {
      routePrefix: "/api",
      controllers: [__dirname + `/controllers/**/*.${ext}`],
      middlewares: [__dirname + `/middlewares/**/*.${ext}`],
      interceptors: [__dirname + `/middlewares/ResponseInterceptor.${ext}`],
      defaultErrorHandler: false,
      validation: true,
      classTransformer: true
    });

    app.get("/api/health", (req, res) => {
      res.status(200).send("Trading Bot Server is alive");
    });

    app.get("/", (_req, res) => {
      res.status(200).json({
        status: "ok",
        service: "Production Algorithmic Trading Bot Backend",
        timestamp: new Date().toISOString(),
        database: AppDataSource.isInitialized ? "connected" : "disconnected",
        nodeVersion: process.version,
        uptime: process.uptime()
      });
    });

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      console.error("Unhandled error:", err);
      const isProd = process.env.NODE_ENV === "production";
      res.status(err.httpCode || 500).json({
        message: isProd ? "An unexpected error occurred." : err.message,
        errors: isProd ? null : err.errors || null
      });
    });

    const PORT = process.env.PORT || 4000;
    const httpServer = createServer(app);

    httpServer.listen(PORT, async () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📄 Swagger documentation: http://localhost:${PORT}/api-docs`);

      // Start Daily Rollover Monitor
      try {
        const { DailyRolloverMonitor } = require("./services/risk.service");
        DailyRolloverMonitor.start();
      } catch (err: any) {
        console.error("⚠️ Failed to initialize Daily Rollover Monitor:", err.message);
      }

      // Start Runtime Status Report Scheduler
      try {
        const { RuntimeStatusReportScheduler } = require("./services/RuntimeStatusReportScheduler");
        RuntimeStatusReportScheduler.start();
      } catch (err: any) {
        console.error("⚠️ Failed to initialize Runtime Status Report Scheduler:", err.message);
      }

      // Start Weekly Strategy Trend Report Scheduler
      try {
        const { WeeklyReportScheduler } = require("./services/WeeklyReportScheduler");
        WeeklyReportScheduler.start();
      } catch (err: any) {
        console.error("⚠️ Failed to initialize Weekly Report Scheduler:", err.message);
      }

      // Boot trading bot
      try {
        try {
          const { OrderExecutionManager } = require("./services/OrderExecutionManager");
          await OrderExecutionManager.recoverPendingTransactions();
        } catch (err: any) {
          console.error("⚠️ Failed to recover pending transactions:", err.message);
        }

        await TradingLoopService.start();
        console.log("🤖 Auto-start complete: Live trading loop is active!");
      } catch (err: any) {
        console.error("❌ CRITICAL: Failed to initialize trading loop on boot:", err.message);
        process.exit(1);
      }
    });

    // Graceful Shutdown Implementation
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal} signal. Initiating graceful shutdown...`);

      // Stop Rollover Monitor
      try {
        const { DailyRolloverMonitor } = require("./services/risk.service");
        DailyRolloverMonitor.stop();
      } catch (err: any) {
        console.error("❌ Error stopping Daily Rollover Monitor:", err.message);
      }

      // Stop Runtime Status Report Scheduler
      try {
        const { RuntimeStatusReportScheduler } = require("./services/RuntimeStatusReportScheduler");
        RuntimeStatusReportScheduler.stop();
      } catch (err: any) {
        console.error("❌ Error stopping Runtime Status Report Scheduler:", err.message);
      }

      // Stop Weekly Strategy Trend Report Scheduler
      try {
        const { WeeklyReportScheduler } = require("./services/WeeklyReportScheduler");
        WeeklyReportScheduler.stop();
      } catch (err: any) {
        console.error("❌ Error stopping Weekly Report Scheduler:", err.message);
      }

      // Stop Trading Loop
      try {
        TradingLoopService.stop();
        console.log("🤖 Live trading loop stopped.");
      } catch (err: any) {
        console.error("❌ Error stopping trading loop:", err.message);
      }

      // Close HTTP Server
      httpServer.close(() => {
        console.log("🌐 HTTP server closed.");
      });

      // Close DB connection
      if (AppDataSource.isInitialized) {
        try {
          await AppDataSource.destroy();
          console.log("💾 Database connection closed.");
        } catch (err: any) {
          console.error("❌ Error closing database connection:", err.message);
        }
      }

      console.log("👋 Graceful shutdown complete. Exiting process.");
      process.exit(0);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  })
  .catch((error) => {
    console.error("❌ Database Connection Error on startup:", error);
    process.exit(1);
  });
