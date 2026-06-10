import { JsonController, Post, Body, Res } from "routing-controllers";
import { StatusCodes } from "http-status-codes";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_EXPIRES_IN } from "../config/jwt";
import { AppDataSource } from "../data-source";
import { User } from "../entity/User";
import { TradingAudit } from "../entity/TradingAudit";

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
  async login(@Body() body: any, @Res() res: any) {
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

      const token = jwt.sign(
        { id: user._id.toString(), username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN as any }
      );

      return res.status(StatusCodes.OK).json({
        success: true,
        token: token,
        expiresIn: JWT_EXPIRES_IN,
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
}
