import {
  JsonController,
  Get,
  Post,
  Body,
  Res,
  Req,
  QueryParams,
  UseBefore
} from "routing-controllers";
import { StatusCodes } from "http-status-codes";
import axios from "axios";
import fs from "fs";
import path from "path";
import { TradingLoopService } from "../services/tradingLoop.service";
import { BacktestingService } from "../services/backtesting.service";
import { UpstoxService } from "../services/upstox.service";
import { StrategyAnalyticsService } from "../services/strategyAnalytics.service";
import { upstoxConfig } from "../config/upstox";
import { TradeLog } from "../entity/TradeLog";
import { TradingAudit } from "../entity/TradingAudit";
import { ActivePosition } from "../entity/ActivePosition";
import { ExecutionLog } from "../entity/ExecutionLog";
import { AppDataSource } from "../data-source";
import handleErrorResponse from "../utils/commonFunction";
import { AuthMiddleware } from "../middlewares/AuthMiddleware";
import { RateLimitMiddleware } from "../middlewares/RateLimitMiddleware";

@JsonController("/trading")
@UseBefore(RateLimitMiddleware)
export class TradingController {

  /**
   * Secured: Send test notification
   */
  @Post("/sendTestNotification")
  @UseBefore(AuthMiddleware)
  async sendTestNotification(@Res() res: any) {
    try {
      const { NotificationService } = require("../services/notification.service");
      await NotificationService.sendNotification("TEST ALERTS", "This is a test notification verifying Telegram and Email connectivity.");
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Test notification sent successfully."
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Starts the live bot
   */
  @Post("/start-bot")
  @UseBefore(AuthMiddleware)
  async startBot(@Req() req: any, @Res() res: any) {
    try {
      await TradingLoopService.start();

      const audit = new TradingAudit();
      audit.username = req.user?.username || "unknown_admin";
      audit.action = "START_BOT";
      audit.ipAddress = req.ip || req.connection?.remoteAddress || "127.0.0.1";
      audit.details = "Trading bot manually started.";
      await AppDataSource.getRepository(TradingAudit).save(audit);

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Upstox Algorithmic Trading bot started successfully!",
        data: TradingLoopService.getStatus(),
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Stops the live bot
   */
  @Post("/stop-bot")
  @UseBefore(AuthMiddleware)
  async stopBot(@Req() req: any, @Res() res: any) {
    try {
      TradingLoopService.stop();

      const audit = new TradingAudit();
      audit.username = req.user?.username || "unknown_admin";
      audit.action = "STOP_BOT";
      audit.ipAddress = req.ip || req.connection?.remoteAddress || "127.0.0.1";
      audit.details = "Trading bot manually stopped.";
      await AppDataSource.getRepository(TradingAudit).save(audit);

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Upstox Algorithmic Trading bot stopped.",
        data: TradingLoopService.getStatus(),
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Restarts the live trading bot
   */
  @Post("/restart-bot")
  @UseBefore(AuthMiddleware)
  async restartBot(@Req() req: any, @Res() res: any) {
    try {
      TradingLoopService.stop();
      await TradingLoopService.start();

      const audit = new TradingAudit();
      audit.username = req.user?.username || "unknown_admin";
      audit.action = "RESTART_BOT";
      audit.ipAddress = req.ip || req.connection?.remoteAddress || "127.0.0.1";
      audit.details = "Trading bot manually restarted.";
      await AppDataSource.getRepository(TradingAudit).save(audit);

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Trading bot restarted successfully.",
        data: TradingLoopService.getStatus(),
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Emergency exit / Liquidate all positions and stop bot
   */
  @Post("/force-exit")
  @UseBefore(AuthMiddleware)
  async forceExit(@Req() req: any, @Res() res: any) {
    try {
      const result = await TradingLoopService.forceExit();

      const audit = new TradingAudit();
      audit.username = req.user?.username || "unknown_admin";
      audit.action = "FORCE_EXIT";
      audit.ipAddress = req.ip || req.connection?.remoteAddress || "127.0.0.1";
      audit.details = `Emergency liquidation completed. Result: ${JSON.stringify(result)}`;
      await AppDataSource.getRepository(TradingAudit).save(audit);

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "EMERGENCY FORCE EXIT COMPLETED. All open positions liquidated.",
        data: result,
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Returns real-time system health and socket status
   */
  @Get("/health")
  @UseBefore(AuthMiddleware)
  async getHealth(@Res() res: any) {
    try {
      const os = require("os");
      const botStatus = TradingLoopService.getStatus();
      const dbStatus = AppDataSource.isInitialized ? "connected" : "disconnected";

      const telemetry = {
        cpuLoadAvg: os.loadavg(),
        freeMemoryBytes: os.freemem(),
        totalMemoryBytes: os.totalmem(),
        memoryUsagePercent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
        uptimeSeconds: os.uptime(),
      };

      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          bot: botStatus,
          database: dbStatus,
          system: telemetry,
        }
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Returns portfolio dashboard aggregations, realized P&L, open and closed history
   */
  @Get("/dashboard")
  @UseBefore(AuthMiddleware)
  async getDashboard(@Res() res: any) {
    try {
      const botStatus = TradingLoopService.getStatus();
      const activePositions = await AppDataSource.getRepository(ActivePosition).find();
      const closedTrades = await AppDataSource.getRepository(TradeLog).find({
        order: { createdAt: "DESC" } as any,
        take: 30
      });

      const account = await UpstoxService.getAccount();

      // Aggregate realized profits vs losses from logs
      let totalRealizedProfit = 0;
      closedTrades.forEach(log => {
        if (log.action === "SELL") {
          // Approximate closed trade profit (Sell total vs average buy total)
          // For simplicity, sum total SELL amounts to net against buying costs
          totalRealizedProfit += log.totalAmount;
        } else {
          totalRealizedProfit -= log.totalAmount;
        }
      });

      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          botStatus,
          accountInfo: account,
          openPositions: activePositions,
          recentTrades: closedTrades,
          netRealizedPnL: totalRealizedProfit,
        }
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Secured: Returns analytics reports, win rates, Sharpe/Sortino ratios, and slippage summaries
   */
  @Get("/analytics")
  @UseBefore(AuthMiddleware)
  async getAnalytics(@Res() res: any) {
    try {
      // Recalculate metrics for target symbols
      const symbols = ["RELIANCE", "TCS", "INFY"];
      const reports = [];

      for (const symbol of symbols) {
        try {
          const report = await StrategyAnalyticsService.calculateMetrics(symbol);
          reports.push(report);
        } catch (e: any) {
          console.warn(`⚠️ Analytics recalculation failed for ${symbol}:`, e.message);
        }
      }

      // Fetch slippage stats
      const slippageRepo = AppDataSource.getRepository(ExecutionLog);
      const slippages = await slippageRepo.find({ take: 20 });
      let totalSlippage = 0;
      slippages.forEach(log => totalSlippage += log.slippageAmount);
      const avgSlippage = slippages.length > 0 ? totalSlippage / slippages.length : 0;

      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          strategyReports: reports,
          averageSlippageAmount: avgSlippage,
          recentSlippageLogs: slippages,
        }
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Retrieves bot active state
   */
  @Get("/status")
  async getStatus(@Res() res: any) {
    try {
      const botStatus = TradingLoopService.getStatus();
      let accountInfo = null;
      let openPositions: any[] = [];

      try {
        accountInfo = await UpstoxService.getAccount();
        openPositions = await UpstoxService.getPositions();
      } catch (err: any) {
        console.warn("⚠️ Could not fetch live Upstox status:", err.message);
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          bot: botStatus,
          upstoxAccount: accountInfo,
          positions: openPositions,
        },
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Triggers a historical backtest of the crossover strategy
   */
  @Post("/backtest")
  async runBacktest(@Body() body: { symbol: string; days?: number }, @Res() res: any) {
    try {
      const { symbol, days } = body;
      const targetSymbol = symbol || "RELIANCE";

      const report = await BacktestingService.runBacktest(targetSymbol, days || 10);
      return res.status(StatusCodes.OK).json({
        success: true,
        message: `Backtest completed for ${targetSymbol.toUpperCase()} over ${days || 10} days.`,
        data: report,
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Queries historical trade execution logs stored in MongoDB
   */
  @Get("/history")
  async getHistory(@QueryParams() query: { limit?: number; symbol?: string }, @Res() res: any) {
    try {
      if (!AppDataSource.isInitialized) {
        return res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
          success: false,
          message: "Database is offline. Trade logs are unavailable.",
        });
      }

      const limit = query.limit || 50;
      const filter: any = {};
      if (query.symbol) {
        filter.symbol = query.symbol.toUpperCase();
      }

      const repo = AppDataSource.getRepository(TradeLog);
      const logs = await repo.find({
        where: filter,
        order: { createdAt: "DESC" } as any,
        take: limit,
      });

      return res.status(StatusCodes.OK).json({
        success: true,
        data: logs,
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Generates the Upstox OAuth Login URL and redirects the user
   */
  @Get("/upstox/login")
  async redirectToUpstoxLogin(@Res() res: any) {
    try {
      const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${upstoxConfig.apiKey}&redirect_uri=${encodeURIComponent(upstoxConfig.redirectUri)}`;
      console.log(`🔗 Redirecting user to Upstox OAuth login: ${authUrl}`);
      res.redirect(authUrl);
      return res;
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Upstox OAuth Authorization callback endpoint
   */
  @Get("/upstox/callback")
  async handleUpstoxCallback(@QueryParams() query: { code?: string }, @Res() res: any) {
    try {
      const { code } = query;
      if (!code) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Parameter 'code' is missing. Please initiate OAuth from Upstox Portal.",
        });
      }

      console.log("📡 Exchanging Upstox authorization code for permanent access token...");

      const response = await axios.post(
        "https://api.upstox.com/v2/login/authorization/token",
        new URLSearchParams({
          code: code,
          client_id: upstoxConfig.apiKey,
          client_secret: upstoxConfig.apiSecret,
          redirect_uri: upstoxConfig.redirectUri,
          grant_type: "authorization_code"
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json"
          }
        }
      );

      const tokenData = response.data;
      const newAccessToken = tokenData.access_token;

      upstoxConfig.accessToken = newAccessToken;
      console.log("🔄 Upstox access token successfully updated in-memory!");

      let envUpdated = false;
      try {
        const envPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, "utf-8");
          if (envContent.includes("UPSTOX_ACCESS_TOKEN=")) {
            envContent = envContent.replace(
              /UPSTOX_ACCESS_TOKEN\s*=\s*["']?[^\n\r"']+["']?/,
              `UPSTOX_ACCESS_TOKEN="${newAccessToken}"`
            );
          } else {
            envContent += `\nUPSTOX_ACCESS_TOKEN="${newAccessToken}"\n`;
          }
          fs.writeFileSync(envPath, envContent, "utf-8");
          console.log("💾 Automatically updated UPSTOX_ACCESS_TOKEN inside .env file!");
          envUpdated = true;
        }
      } catch (err: any) {
        console.error("❌ Failed to update .env file with token:", err.message);
      }

      let botRestartMsg = "";
      try {
        console.log("🔄 Dynamically restarting Upstox Live Trading bot...");
        if (TradingLoopService.getStatus().isActive) {
          TradingLoopService.stop();
        }

        TradingLoopService.start().then(() => {
          console.log("🤖 Live trading bot successfully restarted and active with new credentials!");
        }).catch((err) => {
          console.error("❌ Failed to asynchronously restart live trading bot:", err.message);
        });
        botRestartMsg = " The live trading bot has been dynamically restarted and is now active.";
      } catch (err: any) {
        console.error("❌ Error initiating bot restart:", err.message);
        botRestartMsg = ` However, the bot failed to restart automatically: ${err.message}`;
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        message: `Successfully exchanged authorization code for Upstox access token!${envUpdated ? " Your .env file was automatically updated." : ""}${botRestartMsg}`,
        data: {
          accessToken: newAccessToken,
          userName: tokenData.user_name,
          email: tokenData.email
        }
      });
    } catch (error: any) {
      console.error("❌ Upstox Token Exchange Error:", error.response?.data || error.message);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to exchange authorization code for access token.",
        error: error.response?.data || error.message
      });
    }
  }
}
