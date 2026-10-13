import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { config } from "./config/index.js";
import routes from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app: Express = express();

// Security Headers
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: [config.frontendUrl, "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

// Logging
if (config.nodeEnv !== "test") {
  app.use(morgan("dev"));
}

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// General Rate Limiter: 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, // Generous limit for normal app use and tests
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "marchmaker_backend",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Mount API v1
app.use("/api/v1", routes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// Centralized error handling
app.use(errorHandler);

export default app;
