import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { processPhoto } from '../src/jobs/photoJobs';
import { buildExport, purgeDueAccounts } from '../src/jobs/accountJobs';
import { registerMemberDataHooks } from '../src/jobs/registerPurge';
import { MemoryMailer } from '../src/lib/mailer';
import { createLogger } from '../src/lib/logger';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { Outbox, User } from '../src/models/core';
import { DataRequest } from '../src/models/auth';
import { Photo, Profile } from '../src/models/profile';

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
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const PASSWORD = 'Sup3rSecretPass';

function setup() {
  const env = loadEnv({
    NODE_ENV: 'test',
    EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-export-')),
  } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() }, { storage });
  const app = createApp({ env, log, isReady: () => true, ctx });
  return { app, ctx, mailer, storage, env };
}
type T = ReturnType<typeof setup>;

const cookie = (res: request.Response, name: string) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

async function member(t: T, email = 'asha@example.com') {
  const dob = `${new Date().getUTCFullYear() - 28}-03-04`;
  await request(t.app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, firstName: 'Asha', gender: 'woman', dob, acceptTerms: true })
    .expect(202);
  const token = t.mailer.last(email)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  await request(t.app).post('/api/v1/auth/verify-email').send({ token }).expect(200);
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = cookie(login, 'mm_csrf')!;
  const userId = (await User.findOne({ email }))!._id;
  return {
    agent,
    csrf,
    userId: String(userId),
    get: (url: string) => agent.get(`/api/v1${url}`),
    send: (method: 'post' | 'put' | 'patch' | 'delete', url: string) =>
      agent[method](`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}
type M = Awaited<ReturnType<typeof member>>;

const FULL: Record<string, Record<string, unknown>> = {
  basics: { firstName: 'Asha', heightCm: 165, maritalStatus: 'never_married' },
  background: { religion: 'Hindu', motherTongue: 'Hindi', city: 'Pune', state: 'Maharashtra' },
  education_career: { highestEducation: 'Masters', profession: 'Engineer', incomeBand: '15-25 lakh' },
  family: { familyType: 'nuclear' },
  lifestyle: { diet: 'vegetarian', smoking: 'never', drinking: 'never' },
  values: { marriageTimeline: '1_2_years', wantsKids: 'yes', livingWithFamily: 'open' },
  about: { bio: 'I enjoy slow weekends, long walks and cooking for people I love. Looking for kindness.' },
};

async function fillAllSteps(m: M) {
  let version = 0;
  for (const [step, body] of Object.entries(FULL)) {
    const res = await m.send('patch', `/profile/steps/${step}`).set('If-Match', String(version)).send(body).expect(200);
    version = res.body.version;
  }
  return version;
}

async function jpeg(opts: { exif?: boolean; seed?: number; size?: number } = {}) {
  const size = opts.size ?? 600;
  // Noise keeps even tiny images above the 1 KB minimum upload size.
  const base = sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: (opts.seed ?? 40) % 255, g: 90, b: 140 },
      ...(size < 200 && { noise: { type: 'gaussian' as const, mean: 128, sigma: 40 } }),
    },
  });
  return (opts.exif ? base.withExif({ IFD0: { ImageDescription: 'GPS-and-secrets', Copyright: 'someone' } }) : base)
    .jpeg()
    .toBuffer();
}

async function uploadPhoto(t: T, m: M, img: Buffer) {
  const up = await m
    .send('post', '/photos/upload-url')
    .send({ contentType: 'image/jpeg', sizeBytes: img.length })
    .expect(201);
  // The browser would PUT here; with MemoryStorage we place the bytes directly.
  const key = (await Photo.findById(up.body.id))!.key;
  await t.storage.put('photos', key, img, 'image/jpeg');
  await m.send('post', `/photos/${up.body.id}/confirm`).expect(200);
  return up.body.id as string;
}

describe('profile autosave', () => {
  it('requires a version, validates fields, and increments the version on each save', async () => {
    const t = setup();
    const m = await member(t);

    await m.send('patch', '/profile/steps/basics').send({ heightCm: 170 }).expect(428);
    await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send({ heightCm: 10 }).expect(422);
    await m.send('patch', '/profile/steps/nonsense').set('If-Match', '0').send({}).expect(422);

    const a = await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send({ firstName: 'Asha' }).expect(200);
    expect(a.body.version).toBe(1);
    const b = await m.send('patch', '/profile/steps/basics').set('If-Match', '1').send({ heightCm: 165 }).expect(200);
    expect(b.body.version).toBe(2);
    expect(b.body.data.basics).toMatchObject({ firstName: 'Asha', heightCm: 165 }); // partial saves merge
  });

  it('clears a field when the client sends null', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send({ firstName: 'Asha', heightCm: 160 }).expect(200);
    const r = await m.send('patch', '/profile/steps/basics').set('If-Match', '1').send({ heightCm: null }).expect(200);
    expect(r.body.data.basics).toEqual({ firstName: 'Asha' });
  });

  it('moves the journey to in-progress and tells the member where to resume', async () => {
    const t = setup();
    const m = await member(t);
    expect((await m.get('/auth/me')).body.journeyState).toBe('email_verified');
    await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send(FULL.basics).expect(200);
    expect((await m.get('/auth/me')).body.journeyState).toBe('profile_in_progress');

    const j = (await m.get('/profile/journey').expect(200)).body;
    expect(j.resumeAt).toBe('background');
    expect(j.steps.find((s: { key: string }) => s.key === 'basics').complete).toBe(true);
  });

  it('returns the server copy when another tab saved first, and lets only one concurrent writer win', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send({ firstName: 'Asha' }).expect(200);

    const stale = await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send({ firstName: 'Ash' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details).toMatchObject({ serverVersion: 1, serverData: { firstName: 'Asha' } });

    const race = await Promise.all(
      [170, 171].map((h) => m.send('patch', '/profile/steps/basics').set('If-Match', '1').send({ heightCm: h })),
    );
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('encrypts income and health notes at rest but returns them to the owner', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('patch', '/profile/steps/education_career').set('If-Match', '0').send({ profession: 'Doctor', incomeBand: '25-50 lakh' }).expect(200);
    await m.send('patch', '/profile/steps/basics').set('If-Match', '1').send({ healthNotes: 'Mild asthma' }).expect(200);

    const raw = await Profile.collection.findOne({ userId: new mongoose.Types.ObjectId(m.userId) });
    expect(JSON.stringify(raw)).not.toContain('25-50 lakh');
    expect(JSON.stringify(raw)).not.toContain('Mild asthma');
    expect(raw?.sensitive?.incomeBandEnc).toMatch(/^v1\./);

    const mine = (await m.get('/profile')).body;
    expect(mine.data.education_career.incomeBand).toBe('25-50 lakh');
    expect(mine.data.basics.healthNotes).toBe('Mild asthma');
  });
});

describe('profile submission', () => {
  it('lists what is missing, then submits once everything including a photo is done', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('patch', '/profile/steps/basics').set('If-Match', '0').send(FULL.basics).expect(200);

    const early = await m.send('post', '/profile/submit');
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PROFILE_INCOMPLETE');
    expect(early.body.error.details.missing.map((x: { step: string }) => x.step)).toContain('photos');

    let version = 1;
    for (const [step, body] of Object.entries(FULL).filter(([s]) => s !== 'basics')) {
      const r = await m.send('patch', `/profile/steps/${step}`).set('If-Match', String(version)).send(body).expect(200);
      version = r.body.version;
    }
    await uploadPhoto(t, m, await jpeg());
    await processPhotoFor(t, m);

    const done = await m.send('post', '/profile/submit').expect(200);
    expect(done.body.status).toBe('submitted');
    expect((await m.get('/auth/me')).body.journeyState).toBe('profile_submitted');
    expect(await Outbox.countDocuments({ eventType: 'profile.submitted' })).toBe(1);

    // Locked while it is being reviewed.
    const locked = await m.send('patch', '/profile/steps/about').set('If-Match', String(done.body.version)).send({ bio: 'x'.repeat(60) });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('PROFILE_LOCKED');
    await m.send('post', '/profile/submit').expect(409);
  });
});

async function processPhotoFor(t: T, m: M) {
  const pending = await Photo.find({ userId: m.userId, status: 'processing' });
  for (const p of pending) await processPhoto(t.ctx, String(p._id));
}

describe('photos', () => {
  it('issues a signed upload only for allowed types and sizes, and enforces the limit of six', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('post', '/photos/upload-url').send({ contentType: 'image/gif', sizeBytes: 5000 }).expect(422);
    await m.send('post', '/photos/upload-url').send({ contentType: 'image/jpeg', sizeBytes: 50 * 1024 * 1024 }).expect(422);

    const ok = await m.send('post', '/photos/upload-url').send({ contentType: 'image/jpeg', sizeBytes: 5000 }).expect(201);
    expect(ok.body.upload.method).toBe('PUT');
    expect(ok.body.upload.headers['Content-Type']).toBe('image/jpeg');
    for (let i = 0; i < 5; i++) {
      await m.send('post', '/photos/upload-url').send({ contentType: 'image/png', sizeBytes: 5000 }).expect(201);
    }
    await m.send('post', '/photos/upload-url').send({ contentType: 'image/png', sizeBytes: 5000 }).expect(409);
  });

  it('refuses to confirm a photo that was never uploaded, or whose size changed', async () => {
    const t = setup();
    const m = await member(t);
    const up = await m.send('post', '/photos/upload-url').send({ contentType: 'image/jpeg', sizeBytes: 4000 }).expect(201);
    await m.send('post', `/photos/${up.body.id}/confirm`).expect(400);

    const key = (await Photo.findById(up.body.id))!.key;
    await t.storage.put('photos', key, Buffer.alloc(9000, 1), 'image/jpeg');
    await m.send('post', `/photos/${up.body.id}/confirm`).expect(400);
    expect((await Photo.findById(up.body.id))?.status).toBe('failed');
    expect(t.storage.has('photos', key)).toBe(false);
  });

  it('strips EXIF, creates sized and blurred variants, removes the raw upload, and queues for review', async () => {
    const t = setup();
    const m = await member(t);
    const id = await uploadPhoto(t, m, await jpeg({ exif: true }));
    expect(await Outbox.countDocuments({ eventType: 'photo.uploaded' })).toBe(1);

    await processPhoto(t.ctx, id);
    const photo = (await Photo.findById(id))!;
    expect(photo.status).toBe('pending'); // waits for the admin photo queue
    expect(t.storage.has('photos', photo.key)).toBe(false);

    for (const name of ['sm', 'md', 'lg', 'blur'] as const) {
      const key = photo.variants![name]!;
      const buf = await t.storage.get('photos', key);
      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
    }
    const sm = await sharp(await t.storage.get('photos', photo.variants!.sm!)).metadata();
    const blur = await sharp(await t.storage.get('photos', photo.variants!.blur!)).metadata();
    expect(sm.width).toBe(320);
    expect(blur.width).toBe(24);

    // Processing the same job twice is harmless.
    await processPhoto(t.ctx, id);
    expect((await Photo.findById(id))?.status).toBe('pending');
  });

  it('records the automated face and content check, rejects explicit images, and leaves the rest to a human', async () => {
    const t = setup();
    const m = await member(t);
    t.ctx.moderation = { check: async () => ({ faceDetected: false, nsfw: false, provider: 'stub' }) };
    const noFace = await uploadPhoto(t, m, await jpeg({ seed: 31 }));
    await processPhoto(t.ctx, noFace);
    const p = (await Photo.findById(noFace))!;
    expect(p.status).toBe('pending'); // a missing face only flags it; a person decides
    expect(p.moderation).toMatchObject({ faceDetected: false, provider: 'stub' });

    t.ctx.moderation = { check: async () => ({ faceDetected: true, nsfw: true, provider: 'stub' }) };
    const explicit = await uploadPhoto(t, m, await jpeg({ seed: 32 }));
    await processPhoto(t.ctx, explicit);
    expect((await Photo.findById(explicit))?.rejectionReason).toBe('nsfw');
  });

  it('rejects exact duplicates and tiny images', async () => {
    const t = setup();
    const m = await member(t);
    const img = await jpeg({ seed: 77 });
    const first = await uploadPhoto(t, m, img);
    await processPhoto(t.ctx, first);
    const dup = await uploadPhoto(t, m, img);
    await processPhoto(t.ctx, dup);
    expect((await Photo.findById(dup))?.rejectionReason).toBe('duplicate');

    const tiny = await uploadPhoto(t, m, await jpeg({ size: 100, seed: 5 }));
    await processPhoto(t.ctx, tiny);
    expect((await Photo.findById(tiny))?.rejectionReason).toBe('too_small');
  });

  it('manages primary, order and deletion, and never touches another member\'s photos', async () => {
    const t = setup();
    const m = await member(t);
    const other = await member(t, 'ravi@example.com');
    const a = await uploadPhoto(t, m, await jpeg({ seed: 10 }));
    const b = await uploadPhoto(t, m, await jpeg({ seed: 20 }));
    await processPhotoFor(t, m);

    await m.send('patch', `/photos/${b}/primary`).expect(200);
    const list = (await m.get('/photos')).body.items;
    expect(list.find((p: { id: string }) => p.id === b).isPrimary).toBe(true);
    expect(list.find((p: { id: string }) => p.id === a).isPrimary).toBe(false);
    expect(list[0].sm).toContain('ttl=300'); // short-lived signed link

    await m.send('put', '/photos/order').send({ order: [b, a] }).expect(200);
    expect((await m.get('/photos')).body.items.map((p: { id: string }) => p.id)).toEqual([b, a]);
    await m.send('put', '/photos/order').send({ order: [b] }).expect(422);

    await other.send('patch', `/photos/${a}/primary`).expect(404);
    await other.send('delete', `/photos/${a}`).expect(404);

    await m.send('delete', `/photos/${b}`).expect(204);
    const left = (await m.get('/photos')).body.items;
    expect(left).toHaveLength(1);
    expect(left[0].isPrimary).toBe(true); // primary falls back to the remaining photo
  });
});

describe('preferences', () => {
  const dims = {
    dimensions: [
      { key: 'age', type: 'must', range: { min: 26, max: 32 }, values: [], importance: 2 },
      { key: 'diet', type: 'must', values: ['vegetarian'], importance: 3 },
      { key: 'location', type: 'flexible', values: ['Pune'], importance: 1 },
    ],
  };

  it('saves must-have and flexible preferences with versioning', async () => {
    const t = setup();
    const m = await member(t);
    const put = await m.send('put', '/preferences').send(dims).expect(200);
    expect(put.body.version).toBe(1);
    expect((await m.get('/preferences')).body.dimensions).toHaveLength(3);

    await m.send('put', '/preferences').set('If-Match', '0').send(dims).expect(409);
    await m.send('put', '/preferences').set('If-Match', '1').send(dims).expect(200);

    await m.send('put', '/preferences').send({ dimensions: [dims.dimensions[1], dims.dimensions[1]] }).expect(422);
    await m
      .send('put', '/preferences')
      .send({ dimensions: [{ key: 'age', type: 'must', range: { min: 40, max: 30 }, values: [], importance: 1 }] })
      .expect(422);
  });

  it('gives a coarse pool bucket and a hint, never a count', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('put', '/preferences').send(dims).expect(200);
    const est = (await m.get('/preferences/pool-estimate').expect(200)).body;
    expect(est.bucket).toBe('very_few');
    expect(est.hint).toMatch(/very few members/);
    expect(JSON.stringify(est)).not.toMatch(/"count"/);
  });
});

describe('data lifecycle', () => {
  it('includes profile, preferences and photos in the export and erases them on purge', async () => {
    const t = setup();
    registerMemberDataHooks(t.ctx);
    const m = await member(t);
    await fillAllSteps(m);
    await m.send('put', '/preferences').send({ dimensions: [{ key: 'diet', type: 'must', values: ['vegetarian'], importance: 2 }] }).expect(200);
    const id = await uploadPhoto(t, m, await jpeg({ seed: 99 }));
    await processPhoto(t.ctx, id);
    const keys = Object.values((await Photo.findById(id))!.variants!) as string[];
    expect(keys.every((k) => t.storage.has('photos', k))).toBe(true);

    const exp = await m.send('post', '/account/export').expect(202);
    await buildExport(t.ctx, exp.body.id);
    expect((await DataRequest.findById(exp.body.id))?.status).toBe('ready');
    const file = await (await import('node:fs/promises')).readFile(path.join(t.env.EXPORT_DIR, `${exp.body.id}.json`), 'utf8');
    const json = JSON.parse(file);
    expect(json.profile.data.basics.firstName).toBe('Asha');
    expect(json.profile.data.education_career.incomeBand).toBe('15-25 lakh');
    expect(json.preferences).toHaveLength(1);
    expect(json.photos).toHaveLength(1);

    await m.send('post', '/account/delete').send({ confirm: 'DELETE', password: PASSWORD }).expect(200);
    await User.updateOne({ _id: m.userId }, { $set: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    expect(await purgeDueAccounts(t.ctx)).toBe(1);

    expect(await Profile.countDocuments({ userId: m.userId })).toBe(0);
    expect(await Photo.countDocuments({ userId: m.userId })).toBe(0);
    expect(keys.some((k) => t.storage.has('photos', k))).toBe(false);
  });
});
