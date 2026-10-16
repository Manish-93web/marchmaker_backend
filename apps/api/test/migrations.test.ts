import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAllIndexes } from '../src/scripts/syncIndexes';

const require = createRequire(import.meta.url);
type Migration = { up(db: mongoose.mongo.Db): Promise<void>; down(db: mongoose.mongo.Db): Promise<void> };
const load = (name: string) => require(`../migrations/${name}.cjs`) as Migration;

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('migrations', () => {
  it('renames ticket statuses and back', async () => {
    const db = mongoose.connection.db!;
    await db.collection('tickets').insertMany([{ status: 'waiting_on_member' }, { status: 'open' }]);
    const m = load('20261016000100-ticket-status-names');
    await m.up(db);
    expect(await db.collection('tickets').countDocuments({ status: 'awaiting_member' })).toBe(1);
    expect(await db.collection('tickets').countDocuments({ status: 'waiting_on_member' })).toBe(0);
    await m.down(db);
    expect(await db.collection('tickets').countDocuments({ status: 'waiting_on_member' })).toBe(1);
  });

  it('replaces the check-in marker index so a second stage can be recorded, keeping old rows', async () => {
    const db = mongoose.connection.db!;
    const markers = db.collection('checkinmarkers');
    await markers.createIndex({ introductionId: 1, userId: 1 }, { unique: true });
    const intro = new mongoose.Types.ObjectId();
    const user = new mongoose.Types.ObjectId();
    await markers.insertOne({ introductionId: intro, userId: user });
    await expect(markers.insertOne({ introductionId: intro, userId: user, stage: 'meeting' })).rejects.toThrow(/duplicate key/);

    const m = load('20261016000200-feedback-stages');
    await m.up(db);
    expect((await markers.findOne({ introductionId: intro }))?.stage).toBe('checkin');
    await markers.insertOne({ introductionId: intro, userId: user, stage: 'meeting' });
    await expect(markers.insertOne({ introductionId: intro, userId: user, stage: 'meeting' })).rejects.toThrow(/duplicate key/);
    await m.up(db); // safe to run twice
  });

  it('backfills call mode', async () => {
    const db = mongoose.connection.db!;
    await db.collection('calllogs').insertOne({ status: 'completed' });
    await load('20261016000300-call-mode-and-sources').up(db);
    expect((await db.collection('calllogs').findOne({}))?.mode).toBe('phone');
  });

  it('creates every model index without conflicts', async () => {
    // The earlier tests wrote bare rows that would never exist in real data.
    for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
    const n = await createAllIndexes({ info: () => undefined });
    expect(n).toBeGreaterThan(40);
  });
});
