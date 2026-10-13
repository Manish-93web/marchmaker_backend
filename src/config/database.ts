import mongoose from "mongoose";
import { config } from "./index.js";

export const connectDatabase = async (uriOverride?: string): Promise<typeof mongoose> => {
  const uri = uriOverride || config.mongoUri;
  try {
    const conn = await mongoose.connect(uri, {
      autoIndex: true,
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[Database] MongoDB connected successfully to ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error("[Database] Error connecting to MongoDB:", error);
    throw error;
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    console.log("[Database] MongoDB disconnected cleanly.");
  } catch (error) {
    console.error("[Database] Error disconnecting from MongoDB:", error);
  }
};
