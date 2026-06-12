import { JsonController, Post, Body, Res, Req } from "routing-controllers";
import { StatusCodes } from "http-status-codes";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { getSecret } from "../utils/secretManager";
import { AppDataSource } from "../data-source";
import { User } from "../entity/User";
import { RefreshToken } from "../entity/RefreshToken";
import { TradingAudit } from "../entity/TradingAudit";
import { ObjectId } from "mongodb";

async function createRefreshToken(userId: string, role: string, ipAddress: string, userAgent?: string): Promise<string> {
  const token = crypto.randomBytes(40).toString("hex");
  const repo = AppDataSource.getRepository(RefreshToken);
  const refreshToken = new RefreshToken();
  refreshToken.token = token;
  refreshToken.userId = userId;
  refreshToken.role = role;
  refreshToken.ipAddress = ipAddress;
  refreshToken.userAgent = userAgent;
  refreshToken.isRevoked = false;
  // Expiry set to 7 days
  refreshToken.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await repo.save(refreshToken);
  return token;
}

@JsonController("/auth")
export class AuthController {

  @Post("/seed")
  async seedAdmin(@Body() body: any, @Res() res: any) {
    try {
      const repo = AppDataSource.getRepository(User);
      const count = await repo.count();
      if (count > 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Admin users are already seeded.",
        });
      }

      const { username, password } = body;
      if (!username || !password) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Username and password are required.",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = new User();
      newUser.username = username;
      newUser.password = hashedPassword;
      newUser.role = "admin";
      await repo.save(newUser);

      // Audit Log
      const audit = new TradingAudit();
      audit.username = "system";
      audit.action = "SEED_USER";
      audit.ipAddress = "127.0.0.1";
      audit.details = `Seeded initial admin user: ${username}`;
      await AppDataSource.getRepository(TradingAudit).save(audit);

      return res.status(StatusCodes.CREATED).json({
        success: true,
        message: `Admin user '${username}' seeded successfully!`,
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Failed to seed admin user.",
        error: error.message,
      });
    }
  }

  @Post("/login")
  async login(@Body() body: any, @Req() req: any, @Res() res: any) {
    try {
      const { username, password } = body;
      if (!username || !password) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Username and password are required.",
        });
      }

      const repo = AppDataSource.getRepository(User);
      const user = await repo.findOne({ where: { username } as any });
      if (!user) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          message: "Invalid username or password.",
        });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          message: "Invalid username or password.",
        });
      }

      const jwtSecret = await getSecret("JWT_SECRET");
      const token = jwt.sign(
        { id: user._id.toString(), username: user.username, role: user.role },
        jwtSecret,
        { expiresIn: "15m" }
      );

      const clientIp = req.ip || req.connection?.remoteAddress || "";
      const cleanIp = clientIp.includes("::ffff:") ? clientIp.replace("::ffff:", "") : clientIp;
      const userAgent = req.headers["user-agent"] || "";

      const refreshToken = await createRefreshToken(user._id.toString(), user.role, cleanIp, userAgent);

      return res.status(StatusCodes.OK).json({
        success: true,
        token: token,
        refreshToken: refreshToken,
        expiresIn: "15m",
        user: {
          username: user.username,
          role: user.role,
        },
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Authentication failed.",
        error: error.message,
      });
    }
  }

  @Post("/refresh")
  async refresh(@Body() body: any, @Req() req: any, @Res() res: any) {
    try {
      const { refreshToken } = body;
      if (!refreshToken) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Refresh token is required.",
        });
      }

      const repo = AppDataSource.getRepository(RefreshToken);
      const tokenRecord = await repo.findOne({ where: { token: refreshToken } as any });

      if (!tokenRecord) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          message: "Invalid refresh token.",
        });
      }

      // Replay Attack Protection: If token is already revoked, revoke all tokens for this user
      if (tokenRecord.isRevoked) {
        await repo.update({ userId: tokenRecord.userId } as any, { isRevoked: true } as any);
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          message: "Compromised session. All tokens revoked.",
        });
      }

      // Check Expiry
      if (new Date() > tokenRecord.expiresAt) {
        tokenRecord.isRevoked = true;
        await repo.save(tokenRecord);
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          message: "Refresh token expired.",
        });
      }

      const userRepo = AppDataSource.getRepository(User);
      const targetUser = await userRepo.findOne({ where: { _id: new ObjectId(tokenRecord.userId) } as any });
      if (!targetUser) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          message: "User not found.",
        });
      }

      // Revoke old token
      tokenRecord.isRevoked = true;
      await repo.save(tokenRecord);

      // Generate new pair
      const jwtSecret = await getSecret("JWT_SECRET");
      const newAccessToken = jwt.sign(
        { id: targetUser._id.toString(), username: targetUser.username, role: targetUser.role },
        jwtSecret,
        { expiresIn: "15m" }
      );

      const clientIp = req.ip || req.connection?.remoteAddress || "";
      const cleanIp = clientIp.includes("::ffff:") ? clientIp.replace("::ffff:", "") : clientIp;
      const userAgent = req.headers["user-agent"] || "";

      const newRefreshToken = await createRefreshToken(targetUser._id.toString(), targetUser.role, cleanIp, userAgent);

      return res.status(StatusCodes.OK).json({
        success: true,
        token: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: "15m",
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Token refresh failed.",
        error: error.message,
      });
    }
  }

  @Post("/logout")
  async logout(@Body() body: any, @Res() res: any) {
    try {
      const { refreshToken } = body;
      if (!refreshToken) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Refresh token is required.",
        });
      }

      const repo = AppDataSource.getRepository(RefreshToken);
      const tokenRecord = await repo.findOne({ where: { token: refreshToken } as any });
      if (tokenRecord) {
        tokenRecord.isRevoked = true;
        await repo.save(tokenRecord);
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Logged out successfully.",
      });
    } catch (error: any) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Logout failed.",
        error: error.message,
      });
    }
  }
}
