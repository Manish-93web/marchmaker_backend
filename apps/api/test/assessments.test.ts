import { mkdtempSync } from 'node:fs';
import { readExport } from './helpers/exportFile';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSESSMENT_BANKS, type Answers, type QuestionDef } from '@marchmaker/shared';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { buildExport } from '../src/jobs/accountJobs';
import { registerMemberDataHooks } from '../src/jobs/registerPurge';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { MemorySms } from '../src/lib/sms';
import { AssessmentDefinition, AssessmentResponse } from '../src/models/assessment';
import { FeatureFlag, Outbox, User } from '../src/models/core';
import { dimensionVectors } from '../src/services/assessments';

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

function setup(overrides: Parameters<typeof buildContext>[1] = {}) {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-ex-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() }, overrides);
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, mailer, env };
}
type T = ReturnType<typeof setup>;

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
  const raw = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('mm_csrf='))!;
  const csrf = raw.split(';')[0]!.slice('mm_csrf='.length);
  const userId = String((await User.findOne({ email }))!._id);
  return {
    userId,
    get: (url: string) => agent.get(`/api/v1${url}`),
    send: (method: 'post' | 'put', url: string) => agent[method](`/api/v1${url}`).set('x-csrf-token', csrf),
    csrf,
  };
}
type M = Awaited<ReturnType<typeof member>>;

/** A full, valid set of answers for a question list. `pick` chooses the likert value. */
function fullAnswers(questions: QuestionDef[], likert = 4): Answers {
  const a: Answers = {};
  for (const q of questions) {
    if (q.type === 'likert') a[q.id] = likert;
    else if (q.type === 'single_choice') a[q.id] = q.options![q.options!.length - 1]!.id;
    else a[q.id] = q.items!.map((i) => i.id);
  }
  return a;
}

/** Answers that consistently lean to one end of every dimension (reverse items are flipped). */
function lean(questions: QuestionDef[], end: 'low' | 'high'): Answers {
  const a: Answers = {};
  for (const q of questions) {
    if (q.type === 'likert') a[q.id] = (end === 'high') !== !!q.reverse ? 5 : 1;
    else if (q.type === 'single_choice') a[q.id] = (end === 'high' ? q.options![q.options!.length - 1] : q.options![0])!.id;
    else a[q.id] = q.items!.map((i) => i.id);
  }
  return a;
}

const bank = (key: string) => ASSESSMENT_BANKS.find((b) => b.key === key)!;

async function finish(m: M, key: string, likert = 4) {
  await m.send('put', `/assessments/${key}/responses`).send({ answers: fullAnswers(bank(key).questions, likert) }).expect(200);
  return m.send('post', `/assessments/${key}/complete`);
}

describe('assessments: listing and questions', () => {
  it('lists all six assessments and hides every scoring field from the questions', async () => {
    const t = setup();
    const m = await member(t);
    const list = (await m.get('/assessments').expect(200)).body.items;
    expect(list).toHaveLength(6);
    expect(list.every((a: { status: string }) => a.status === 'not_started')).toBe(true);

    const def = (await m.get('/assessments/values').expect(200)).body;
    expect(def.questions.length).toBe(bank('values').questions.length);
    const json = JSON.stringify(def);
    expect(json).not.toMatch(/"value"|"dimension"|"reverse"/);
    expect(def.resumeIndex).toBe(0);
    await m.get('/assessments/nonsense').expect(404);
  });

  it('requires a signed-in member', async () => {
    const t = setup();
    await request(t.app).get('/api/v1/assessments').expect(401);
  });
});

describe('assessments: answering', () => {
  it('autosaves valid answers, rejects invalid ones, and resumes at the first unanswered question', async () => {
    const t = setup();
    const m = await member(t);
    const qs = bank('values').questions;

    await m.send('put', '/assessments/values/responses').send({ answers: { [qs[0]!.id]: 9 } }).expect(422);
    await m.send('put', '/assessments/values/responses').send({ answers: { nope: 3 } }).expect(422);

    const saved = await m
      .send('put', '/assessments/values/responses')
      .send({ answers: { [qs[0]!.id]: 5, [qs[1]!.id]: 2 } })
      .expect(200);
    expect(saved.body).toMatchObject({ answered: 2, total: qs.length, resumeIndex: 2 });

    const again = (await m.get('/assessments/values')).body;
    expect(again.status).toBe('in_progress');
    expect(again.answers[qs[0]!.id]).toBe(5);
    expect(again.resumeIndex).toBe(2);

    const list = (await m.get('/assessments')).body.items.find((a: { key: string }) => a.key === 'values');
    expect(list).toMatchObject({ status: 'in_progress', answered: 2 });
  });

  it('refuses to finish while questions are unanswered', async () => {
    const t = setup();
    const m = await member(t);
    const qs = bank('faith').questions;
    await m.send('put', '/assessments/faith/responses').send({ answers: { [qs[0]!.id]: 3 } }).expect(200);
    const res = await m.send('post', '/assessments/faith/complete');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ASSESSMENT_INCOMPLETE');
    expect(res.body.error.details.remaining).toBe(qs.length - 1);
  });
});

describe('assessments: results in words', () => {
  it('writes a narrative with no numbers, bands or scores, and keeps internal vectors separate', async () => {
    const t = setup();
    const m = await member(t);
    const res = await finish(m, 'communication', 5).then((r) => {
      expect(r.status).toBe(200);
      return r.body;
    });

    expect(res.title).toBe('How you communicate');
    expect(res.sections.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify({ ...res, completedAt: undefined, retakeAvailableAt: undefined });
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/score|band|dimension|percent|%/i);

    const fetched = (await m.get('/assessments/communication/result').expect(200)).body;
    expect(Object.keys(fetched).sort()).toEqual(
      ['closing', 'completedAt', 'key', 'retakeAvailableAt', 'sections', 'summary', 'title'].sort(),
    );

    // Internal vectors exist for matching and staff, and are in 0..1.
    const vectors = await dimensionVectors(m.userId);
    expect(vectors.communication).toBeDefined();
    for (const v of Object.values(vectors.communication!)) expect(v).toBeGreaterThanOrEqual(0);
    expect(await Outbox.countDocuments({ eventType: 'assessment.completed' })).toBe(1);
  });

  it('gives different wording for different answers', async () => {
    const t = setup();
    const a = await member(t, 'a@example.com');
    const b = await member(t, 'b@example.com');
    const run = async (m: M, end: 'low' | 'high') => {
      await m.send('put', '/assessments/lifestyle/responses').send({ answers: lean(bank('lifestyle').questions, end) }).expect(200);
      return (await m.send('post', '/assessments/lifestyle/complete').expect(200)).body;
    };
    const low = await run(a, 'low');
    const high = await run(b, 'high');
    expect(JSON.stringify(low.sections)).not.toBe(JSON.stringify(high.sections));
  });

  it('returns 404 for a result that does not exist yet', async () => {
    const t = setup();
    const m = await member(t);
    await m.get('/assessments/values/result').expect(404);
  });

  it('is safe to complete twice at once: one completed result', async () => {
    const t = setup();
    const m = await member(t);
    await m.send('put', '/assessments/finances/responses').send({ answers: fullAnswers(bank('finances').questions) }).expect(200);
    const [r1, r2] = await Promise.all([m.send('post', '/assessments/finances/complete'), m.send('post', '/assessments/finances/complete')]);
    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(await AssessmentResponse.countDocuments({ userId: m.userId, key: 'finances', status: 'completed' })).toBe(1);
  });
});

describe('assessments: retake and versioning', () => {
  it('blocks a retake for 90 days, then allows it and replaces the current result', async () => {
    const t = setup();
    const m = await member(t);
    const first = await finish(m, 'values', 5);
    const days = (new Date(first.body.retakeAvailableAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);

    const blocked = await m.send('put', '/assessments/values/responses').send({ answers: { v1: 3 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RETAKE_NOT_AVAILABLE');

    await AssessmentResponse.updateOne({ userId: m.userId, key: 'values' }, { $set: { retakeAvailableAt: new Date(Date.now() - 1000) } });
    const second = await finish(m, 'values', 1);
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.body.sections)).not.toBe(JSON.stringify(first.body.sections));
    expect(await AssessmentResponse.countDocuments({ userId: m.userId, key: 'values' })).toBe(2);
  });

  it('keeps a member on the question version they started while a new version goes live', async () => {
    const t = setup();
    const m = await member(t);
    const v1 = bank('faith');
    await AssessmentDefinition.create({ ...v1, version: 1, active: true });
    await m.send('put', '/assessments/faith/responses').send({ answers: { r1: 4 } }).expect(200);

    const v2Questions = [...v1.questions, { id: 'r9', type: 'likert', prompt: 'A new question', dimension: 'religiosity' }];
    await AssessmentDefinition.create({ ...v1, version: 2, questions: v2Questions, active: true });

    const inProgress = (await m.get('/assessments/faith')).body;
    expect(inProgress.version).toBe(1);
    expect(inProgress.questions).toHaveLength(v1.questions.length);

    await m.send('put', '/assessments/faith/responses').send({ answers: fullAnswers(v1.questions) }).expect(200);
    await m.send('post', '/assessments/faith/complete').expect(200);
    const row = await AssessmentResponse.findOne({ userId: m.userId, key: 'faith' });
    expect(row?.version).toBe(1);
  });
});

describe('assessments: optional narrative rewriting', () => {
  it('uses the rewriter only when the flag is on, and falls back per section if the output is unsafe', async () => {
    const rewriter = {
      rewrite: async (_body: string, c: { heading: string }) =>
        c.heading === 'Directness' ? 'You like to keep things open and say what you mean, kindly but clearly.' : 'You scored 90 percent here.',
    };
    const t = setup({ narrativeRewriter: rewriter });
    const off = await member(t, 'off@example.com');
    const plain = (await finish(off, 'communication', 5)).body;
    expect(JSON.stringify(plain)).not.toMatch(/kindly but clearly/);

    await FeatureFlag.create({ key: 'llm_narratives', enabled: true });
    const on = await member(t, 'on@example.com');
    const rewritten = (await finish(on, 'communication', 5)).body;
    expect(rewritten.sections.find((s: { heading: string }) => s.heading === 'Directness').body).toMatch(/kindly but clearly/);
    expect(JSON.stringify(rewritten)).not.toMatch(/percent/);
    const stored = await AssessmentResponse.findOne({ userId: on.userId });
    expect((stored?.narrative as { source: string }).source).toBe('rewritten');
  });
});

describe('assessments: data rights', () => {
  it('exports answers and the written result, but not internal scores', async () => {
    const t = setup();
    registerMemberDataHooks(t.ctx);
    const m = await member(t);
    await finish(m, 'family', 4);
    const exp = await m.send('post', '/account/export').expect(202);
    await buildExport(t.ctx, exp.body.id);
    const json = await readExport(t.ctx.storage, exp.body.id);
    expect(json.assessments).toHaveLength(1);
    expect(json.assessments[0].answers.f1).toBe(4);
    expect(json.assessments[0].result.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toMatch(/dimensionScores|bands/);
  });
});
