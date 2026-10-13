import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./auth.js";
import { UserRole } from "../models/User.js";

export const requireRole = (allowedRoles: UserRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !req.userRole) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!allowedRoles.includes(req.userRole)) {
      res.status(403).json({
        success: false,
        message: `Forbidden: requires one of roles [${allowedRoles.join(", ")}]`,
      });
      return;
    }

    next();
  };
};
