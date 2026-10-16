import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createLogger } from '../src/lib/logger';
import { User } from '../src/models/core';
import { Introduction, MatchSuggestion } from '../src/models/matching';
import { Photo, Profile } from '../src/models/profile';
import { Message } from '../src/models/social';
import { seedDemo } from '../src/scripts/seedDemo';

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('demo seed', () => {
  const log = createLogger('silent');

  it('creates 40 members with profiles, photos, suggestions and introductions in every state, and is repeatable', async () => {
    const env = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    await seedDemo(env, log);
    expect(await User.countDocuments({ email: /@demo\.marchmaker\.invalid$/ })).toBe(40);
    expect(await Profile.countDocuments({ status: 'approved' })).toBe(40);
    expect(await Photo.countDocuments({ status: 'approved' })).toBe(40);
    const states = new Set((await Introduction.find().lean()).map((i) => i.state));
    expect([...states].sort()).toEqual(['accepted_by_one', 'declined', 'expired', 'mutually_accepted', 'released', 'viewed']);
    const sugg = new Set((await MatchSuggestion.find().lean()).map((s) => s.status));
    expect(sugg).toEqual(new Set(['suggested', 'in_review', 'snoozed', 'escalated', 'rejected', 'approved']));
    expect(await Message.countDocuments()).toBeGreaterThan(0);

    await seedDemo(env, log); // running again changes nothing
    expect(await User.countDocuments({ email: /@demo\.marchmaker\.invalid$/ })).toBe(40);
    expect(await Introduction.countDocuments()).toBe(7);

    await seedDemo(env, log, { reset: true });
    expect(await User.countDocuments({ email: /@demo\.marchmaker\.invalid$/ })).toBe(40);
  });

  it('refuses to run in production', async () => {
    await expect(seedDemo({ NODE_ENV: 'production' } as never, log)).rejects.toThrow('production');
  });
});
