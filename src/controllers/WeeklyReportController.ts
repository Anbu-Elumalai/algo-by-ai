import { JsonController, Get, Param, Res } from "routing-controllers";
import { Response } from "express";
import { StatusCodes } from "http-status-codes";
import * as fs from "fs";
import { AppDataSource } from "../data-source";
import { WeeklyStrategyReport } from "../entity/WeeklyStrategyReport";

@JsonController("/reports/weekly")
export class WeeklyReportController {

  /**
   * GET /api/reports/weekly/latest
   * Returns the latest Weekly Strategy Report metadata and metrics.
   */
  @Get("/latest")
  async getLatest(@Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
      const latest = await repo.findOne({
        order: { generatedAt: "DESC" }
      } as any);
      
      if (!latest) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "No weekly strategy reports have been generated yet."
        });
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: latest
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to retrieve the latest report.",
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/weekly/history
   * Returns all stored reports sorted chronologically descending.
   */
  @Get("/history")
  async getHistory(@Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
      const reports = await repo.find({
        order: { generatedAt: "DESC" }
      });

      return res.status(StatusCodes.OK).json({
        success: true,
        count: reports.length,
        data: reports
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to retrieve report history.",
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/weekly/email/status
   * Returns a breakdown of report delivery states.
   */
  @Get("/email/status")
  async getEmailStatus(@Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
      const reports = await repo.find({
        order: { generatedAt: "DESC" }
      });

      const stats = reports.map(r => ({
        weekIdentifier: r.weekIdentifier,
        generatedAt: r.generatedAt,
        emailStatus: r.emailStatus
      }));

      return res.status(StatusCodes.OK).json({
        success: true,
        data: stats
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to retrieve email statuses.",
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/weekly/:week
   * Query details of a specific week e.g. "2026-W28"
   */
  @Get("/:week")
  async getByWeek(@Param("week") week: string, @Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
      const report = await repo.findOne({ where: { weekIdentifier: week } as any });

      if (!report) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: `Report for week identifier '${week}' not found.`
        });
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: report
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: `Failed to retrieve report for week ${week}.`,
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/weekly/download/pdf/:week
   * File download endpoint returning the compiled PDF binary.
   */
  @Get("/download/pdf/:week")
  async downloadPdf(@Param("week") week: string, @Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
      const report = await repo.findOne({ where: { weekIdentifier: week } as any });

      if (!report || !report.pdfPath) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: `PDF record for week '${week}' not found.`
        });
      }

      if (!fs.existsSync(report.pdfPath)) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "PDF source file missing on disk."
        });
      }

      const fileBuffer = fs.readFileSync(report.pdfPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=Weekly_Report_Week_${week}.pdf`);
      return res.status(StatusCodes.OK).send(fileBuffer);
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to download PDF.",
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/weekly/download/html/:week
   * File download endpoint returning the HTML report.
   */
  @Get("/download/html/:week")
  async downloadHtml(@Param("week") week: string, @Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyStrategyReport);
      const report = await repo.findOne({ where: { weekIdentifier: week } as any });

      if (!report || !report.htmlPath) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: `HTML record for week '${week}' not found.`
        });
      }

      if (!fs.existsSync(report.htmlPath)) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "HTML source file missing on disk."
        });
      }

      const htmlBuffer = fs.readFileSync(report.htmlPath);
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Disposition", `attachment; filename=Weekly_Report_Week_${week}.html`);
      return res.status(StatusCodes.OK).send(htmlBuffer);
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to download HTML.",
        error: error.message
      });
    }
  }
}
