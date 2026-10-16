import dns from 'node:dns';
import mongoose from 'mongoose';
import type { Logger } from 'pino';

export async function connectMongo(uri: string, log: Logger): Promise<typeof mongoose> {
  // Some networks refuse the SRV lookup that mongodb+srv:// URLs need. DNS_SERVERS (comma separated) overrides the resolver for that case.
  const servers = process.env.DNS_SERVERS?.split(',').map((x) => x.trim()).filter(Boolean);
  if (servers?.length) dns.setServers(servers);
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => log.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => log.info('mongo reconnected'));
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    maxPoolSize: 20,
    autoIndex: process.env.NODE_ENV !== 'production',
  });
  log.info('mongo connected');
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

/** Runs fn inside a multi-document transaction (requires a replica set). */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export const isMongoReady = () => mongoose.connection.readyState === 1;
