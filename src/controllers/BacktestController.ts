import {
  JsonController,
  Get,
  Post,
  Body,
  Param,
  QueryParam,
  Res,
  UseBefore
} from "routing-controllers";
import { StatusCodes } from "http-status-codes";
import { BacktestingService } from "../services/backtesting.service";
import { AppDataSource } from "../data-source";
import { BacktestRun } from "../entity/BacktestRun";
import handleErrorResponse from "../utils/commonFunction";
import { RateLimitMiddleware } from "../middlewares/RateLimitMiddleware";
import { ObjectId } from "mongodb";

@JsonController("/backtest")
@UseBefore(RateLimitMiddleware)
export class BacktestController {

  /**
   * Run historical backtest of the strategy
   */
  @Post("/run")
  async runBacktest(
    @Body() body: {
      symbol: string;
      fromDate: string;
      toDate: string;
      capital?: number;
      slippage?: number;
      riskPercent?: number;
    },
    @Res() res: any
  ) {
    try {
      const { symbol, fromDate, toDate, capital, slippage, riskPercent } = body;
      if (!symbol || !fromDate || !toDate) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Required fields: symbol, fromDate (YYYY-MM-DD), toDate (YYYY-MM-DD)"
        });
      }

      const result = await BacktestingService.runBacktest(
        symbol,
        fromDate,
        toDate,
        capital || 100000,
        slippage !== undefined ? slippage : 0.0005,
        riskPercent !== undefined ? riskPercent : 0.01
      );

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Backtest completed successfully.",
        data: result
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Get Backtest Run by ID
   */
  @Get("/:id")
  async getBacktest(@Param("id") id: string, @Res() res: any) {
    try {
      const backtestRepo = AppDataSource.getRepository(BacktestRun);
      const run = await backtestRepo.findOne({ where: { _id: new ObjectId(id) } as any });
      if (!run) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "Backtest run not found."
        });
      }
      return res.status(StatusCodes.OK).json({
        success: true,
        data: run
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Get Backtest compiled report by ID
   */
  @Get("/:id/report")
  async getBacktestReport(@Param("id") id: string, @Res() res: any) {
    try {
      const backtestRepo = AppDataSource.getRepository(BacktestRun);
      const run = await backtestRepo.findOne({ where: { _id: new ObjectId(id) } as any });
      if (!run) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "Backtest run not found."
        });
      }
      return res.status(StatusCodes.OK).json({
        success: true,
        data: run.report
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }

  /**
   * Get Backtest trades by ID (supports CSV export)
   */
  @Get("/:id/trades")
  async getBacktestTrades(
    @Param("id") id: string,
    @QueryParam("format") format: string,
    @Res() res: any
  ) {
    try {
      const backtestRepo = AppDataSource.getRepository(BacktestRun);
      const run = await backtestRepo.findOne({ where: { _id: new ObjectId(id) } as any });
      if (!run) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "Backtest run not found."
        });
      }

      if (format === "csv") {
        const csvContent = BacktestingService.generateCSV(run.trades);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=backtest_trades_${run.symbol}_${id}.csv`);
        return res.status(StatusCodes.OK).send(csvContent);
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: run.trades
      });
    } catch (error: any) {
      return handleErrorResponse(error, res);
    }
  }
}
