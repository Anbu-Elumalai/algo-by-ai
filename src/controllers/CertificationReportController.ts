import { JsonController, Get, Param, Res } from "routing-controllers";
import { Response } from "express";
import { StatusCodes } from "http-status-codes";
import * as fs from "fs";
import { AppDataSource } from "../data-source";
import { WeeklyCertificationReport } from "../entity/WeeklyCertificationReport";

@JsonController("/reports/certification")
export class CertificationReportController {

  /**
   * GET /api/reports/certification/latest
   * Returns the latest generated Weekly Strategy Certification Report.
   */
  @Get("/latest")
  async getLatest(@Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyCertificationReport);
      const latest = await repo.findOne({
        order: { generatedAt: "DESC" }
      } as any);
      
      if (!latest) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: "No weekly strategy certification reports have been generated yet."
        });
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: latest
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to retrieve the latest certification report.",
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/certification/history
   * Returns all stored certification reports sorted chronologically descending.
   */
  @Get("/history")
  async getHistory(@Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyCertificationReport);
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
        message: "Failed to retrieve certification report history.",
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/certification/:week
   * Query details of a specific week e.g. "2026-W28"
   */
  @Get("/:week")
  async getByWeek(@Param("week") week: string, @Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyCertificationReport);
      const report = await repo.findOne({ where: { weekIdentifier: week } as any });

      if (!report) {
        return res.status(StatusCodes.NOT_FOUND).json({
          success: false,
          message: `Certification report for week '${week}' not found.`
        });
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: report
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: `Failed to retrieve certification report for week ${week}.`,
        error: error.message
      });
    }
  }

  /**
   * GET /api/reports/certification/download/pdf/:week
   * Downloads the compiled PDF certification report.
   */
  @Get("/download/pdf/:week")
  async downloadPdf(@Param("week") week: string, @Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyCertificationReport);
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
      res.setHeader("Content-Disposition", `attachment; filename=Certification_Report_Week_${week}.pdf`);
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
   * GET /api/reports/certification/download/html/:week
   * Downloads the HTML version of the certification report.
   */
  @Get("/download/html/:week")
  async downloadHtml(@Param("week") week: string, @Res() res: Response) {
    try {
      const repo = AppDataSource.getMongoRepository(WeeklyCertificationReport);
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
      res.setHeader("Content-Disposition", `attachment; filename=Certification_Report_Week_${week}.html`);
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
