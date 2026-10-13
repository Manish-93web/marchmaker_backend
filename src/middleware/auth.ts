import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { User, IUser, UserRole } from "../models/User.js";
import { Session } from "../models/Session.js";

export interface AuthenticatedRequest extends Request {
  user?: IUser;
  userId?: string;
  userRole?: UserRole;
}

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        message: "Authentication token missing or invalid",
      });
      return;
    }

    const token = authHeader.split(" ")[1];
    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      res.status(401).json({
        success: false,
        message: "Token expired or signature invalid",
      });
      return;
    }

    // Check if user exists and is not suspended
    const user = await User.findById(decoded.userId);
    if (!user) {
      res.status(401).json({
        success: false,
        message: "User account no longer exists",
      });
      return;
    }

    if (user.isSuspended) {
      res.status(403).json({
        success: false,
        message: `Account is suspended: ${user.suspendedReason || "Violation of community standards"}`,
      });
      return;
    }

    // Attach user to request
    req.user = user;
    req.userId = user._id.toString();
    req.userRole = user.role;

    next();
  } catch (error) {
    next(error);
  }
};
