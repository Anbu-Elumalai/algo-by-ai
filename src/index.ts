import "reflect-metadata";
import * as dotenv from "dotenv";

dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { useExpressServer } from "routing-controllers";
import { AppDataSource } from "./data-source";
import fileUpload from "express-fileupload";

// ✅ Swagger
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger";
import { createServer } from "http";
import { TradingLoopService } from "./services/tradingLoop.service";

AppDataSource.initialize()
  .then(async () => {
    console.log("✅ Database connected successfully via TypeORM");

    const app = express();
    app.use(express.json());

    app.use(
      cors({
        origin: "*",  // ✅ Allow all domains
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Origin", "Content-Type", "Authorization"],
        credentials: false
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

    // ✅ Swagger route
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
        service: "Algorithmic Trading Bot Backend",
        timestamp: new Date().toISOString(),
        database: AppDataSource.isInitialized ? "connected" : "disconnected",
        nodeVersion: process.version,
        uptime: process.uptime()
      });
    });

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      console.error(err);
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
      console.log(`📡 Trading Bot REST Endpoints prefix: http://localhost:${PORT}/api/trading`);

      // 🤖 AUTOMATIC BOT STARTUP: Auto-start the live trading loop on server boot-up!
      try {
        await TradingLoopService.start();
        console.log("🤖 Auto-start complete: Live trading loop is active!");
      } catch (err: any) {
        console.warn("⚠️ Auto-start warning: Failed to initialize trading loop on boot (likely due to missing credentials inside .env):", err.message);
      }
    });

  })
  .catch((error) => {
    console.error("❌ Database Error on startup:", error);
  });
