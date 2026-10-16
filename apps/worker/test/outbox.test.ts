import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Outbox } from '@marchmaker/api/models';
import { backoffMs, relayOutboxOnce } from '../src/outbox';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Outbox.deleteMany({});
});

describe('outbox relay', () => {
  it('dispatches pending events exactly once', async () => {
    await Outbox.create({ eventType: 'intro.released', payload: { id: 1 } });
    const seen: string[] = [];
    const publish = async (e: { eventType: string }) => void seen.push(e.eventType);

    expect(await relayOutboxOnce({ publish })).toBe(1);
    expect(await relayOutboxOnce({ publish })).toBe(0);
    expect(seen).toEqual(['intro.released']);
    expect((await Outbox.findOne())?.status).toBe('dispatched');
  });

  it('retries with backoff and eventually marks failed', async () => {
    await Outbox.create({ eventType: 'email.send', payload: {} });
    const publish = async () => {
      throw new Error('queue down');
    };
    let t = Date.now();
    const now = () => new Date(t);

    for (let i = 0; i < 3; i++) {
      await relayOutboxOnce({ publish, maxAttempts: 3, now });
      t += 20 * 60_000;
    }
    const doc = await Outbox.findOne();
    expect(doc?.status).toBe('failed');
    expect(doc?.attempts).toBe(3);
    expect(doc?.lastError).toBe('queue down');
  });

  it('computes capped exponential backoff', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(30)).toBe(15 * 60_000);
  });
});
