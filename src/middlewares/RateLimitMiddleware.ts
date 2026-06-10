import { ExpressMiddlewareInterface } from "routing-controllers";
import { Response, NextFunction } from "express";

const ipRequests = new Map<string, { count: number; lastReset: number }>();

export class RateLimitMiddleware implements ExpressMiddlewareInterface {
  private LIMIT = 30; // Max 30 requests per minute
  private WINDOW_MS = 60000;

  use(req: any, res: Response, next: NextFunction) {
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown-ip";
    const now = Date.now();

    const record = ipRequests.get(clientIp);
    if (!record) {
      ipRequests.set(clientIp, { count: 1, lastReset: now });
      return next();
    }

    if (now - record.lastReset > this.WINDOW_MS) {
      record.count = 1;
      record.lastReset = now;
      return next();
    }

    record.count++;
    if (record.count > this.LIMIT) {
      console.warn(`⚠️ Rate limit reached for IP: ${clientIp} (${record.count} requests)`);
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again after a minute."
      });
    }

    next();
  }
}
