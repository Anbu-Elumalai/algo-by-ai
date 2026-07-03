import { ExpressMiddlewareInterface } from "routing-controllers";
import { Response, NextFunction } from "express";

// Hardened memory-bounded rate limiter cache with active TTL pruning
export class BoundedTTLCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();

  constructor(private maxKeys: number = 1000, private ttlMs: number = 60000) {
    // Periodically prune expired keys every 60 seconds
    const interval = setInterval(() => this.prune(), 60000);
    if (interval.unref) {
      interval.unref();
    }
  }

  get(key: string): T | undefined {
    const record = this.cache.get(key);
    if (!record) return undefined;
    if (Date.now() > record.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return record.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxKeys) {
      // Evict the oldest key in insertion order
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  prune(): void {
    const now = Date.now();
    for (const [key, record] of this.cache.entries()) {
      if (now > record.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

const ipRequests = new BoundedTTLCache<{ count: number; lastReset: number }>(1000, 60000);

export class RateLimitMiddleware implements ExpressMiddlewareInterface {
  private LIMIT = 30; // Max 30 requests per minute

  use(req: any, res: Response, next: NextFunction) {
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown-ip";
    const now = Date.now();

    const record = ipRequests.get(clientIp);
    if (!record) {
      ipRequests.set(clientIp, { count: 1, lastReset: now });
      return next();
    }

    if (now - record.lastReset > 60000) {
      record.count = 1;
      record.lastReset = now;
      ipRequests.set(clientIp, record);
      return next();
    }

    record.count++;
    ipRequests.set(clientIp, record);
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
