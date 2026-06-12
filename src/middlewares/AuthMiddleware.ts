import { ExpressMiddlewareInterface } from "routing-controllers";
import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getSecret } from "../utils/secretManager";

export class AuthMiddleware implements ExpressMiddlewareInterface {
  async use(req: any, res: Response, next: NextFunction) {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Access denied. Bearer token missing." });
    }

    const token = authHeader.split(" ")[1];
    try {
      const jwtSecret = await getSecret("JWT_SECRET");
      const decoded = jwt.verify(token, jwtSecret) as any;

      if (decoded.role !== "admin") {
        return res.status(403).json({ success: false, message: "Access forbidden. Admin role required." });
      }

      // IP Allowlist Check
      const allowedIpsStr = process.env.ALLOWED_ADMIN_IPS;
      if (allowedIpsStr && allowedIpsStr !== "*") {
        const allowedIps = allowedIpsStr.split(",").map(ip => ip.trim());
        const clientIp = req.ip || req.connection?.remoteAddress || "";
        const cleanIp = clientIp.includes("::ffff:") ? clientIp.replace("::ffff:", "") : clientIp;

        if (!allowedIps.includes(cleanIp)) {
          console.warn(`🛑 Unauthorized bot-control attempt from non-whitelisted IP: ${cleanIp}`);
          return res.status(403).json({ success: false, message: "Access forbidden. Non-whitelisted IP address." });
        }
      }

      req.user = decoded;
      next();
    } catch (err: any) {
      return res.status(401).json({ success: false, message: "Access denied. Invalid or expired token.", error: err.message });
    }
  }
}
