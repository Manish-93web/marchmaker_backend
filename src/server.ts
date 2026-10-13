import app from "./app.js";
import { config } from "./config/index.js";
import { connectDatabase } from "./config/database.js";

const startServer = async () => {
  try {
    await connectDatabase();
    
    // Initialize background cron workers (7-day intro expiration, DPDP purges, daily reconciliation)
    const { CronService } = await import("./services/cronService.js");
    CronService.init();

    app.listen(config.port, () => {
      console.log(`[Server] Marchmaker API running on http://localhost:${config.port}`);
      console.log(`[Server] Health check available at http://localhost:${config.port}/health`);
    });
  } catch (error) {
    console.error("[Server] Fatal error starting server:", error);
    process.exit(1);
  }
};

startServer();
