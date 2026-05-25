import {
  JsonController,
  Get,
  Post,
  Body,
  Res,
  QueryParams
} from "routing-controllers";
import { StatusCodes } from "http-status-codes";
import axios from "axios";
import { TradingLoopService } from "../services/tradingLoop.service";
import { BacktestingService } from "../services/backtesting.service";
import { UpstoxService } from "../services/upstox.service";
import { upstoxConfig } from "../config/upstox";
import { TradeLog } from "../entity/TradeLog";
import { AppDataSource } from "../data-source";
import handleErrorResponse from "../utils/commonFunction";

@JsonController("/trading")
export class TradingController {
  
  /**
   * Starts the live paper trading loop
   */
  @Post("/start")
  async startTrading(@Res() res: any) {
    try {
      await TradingLoopService.start();
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Upstox Algorithmic Trading bot started successfully! Live 60-second LTP poll active.",
        data: TradingLoopService.getStatus(),
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Stops the live paper trading loop
   */
  @Post("/stop")
  async stopTrading(@Res() res: any) {
    try {
      TradingLoopService.stop();
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Upstox Algorithmic Trading bot stopped. Polling deactivated.",
        data: TradingLoopService.getStatus(),
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Retrieves account equity, open positions, and current bot active state
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
        console.warn("⚠️ Could not fetch active Upstox account:", err.message);
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
      
      // Default Indian backtest stocks if none provided
      const targetSymbol = symbol || "RELIANCE";

      const report = await BacktestingService.runBacktest(targetSymbol, days || 60);
      return res.status(StatusCodes.OK).json({
        success: true,
        message: `Backtest completed for ${targetSymbol.toUpperCase()} over ${days || 60} days.`,
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
        order: { createdAt: "DESC" },
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
   * Upstox OAuth Authorization callback endpoint
   * Ex-changes redirect authorization code for access token
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

      console.log(`📡 Exchanging Upstox authorization code for permanent access token...`);

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
      
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Successfully exchanged authorization code for Upstox access token! Copy the token and save it to your .env file as UPSTOX_ACCESS_TOKEN.",
        data: {
          accessToken: tokenData.access_token,
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
