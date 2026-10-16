import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@marchmaker/shared';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import type { MockPaymentProvider } from '../src/lib/payments';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { Invoice, Order, Payment } from '../src/models/billing';
import { AuditLog, Outbox, Setting, User } from '../src/models/core';
import { Referral, WalletLedger } from '../src/models/referrals';
import { reconcile } from '../src/services/billing';
import { attribute, onPayment, releaseDue } from '../src/services/referrals';

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
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
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-ref-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, mock: ctx.payments as MockPaymentProvider };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function member(t: T, over: Record<string, unknown> = {}, roles: Role[] = ['member']) {
  n++;
  const email = `ref${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: `Person${n}`,
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles,
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
    referralCode: `CODE${n}XYZ`,
    verification: { idVerifiedAt: new Date() },
    ...over,
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  let csrf = csrfOf(login);
  if (roles.some((r) => r !== 'member')) {
    const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
    const c = await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrf).send({ code: generateSync({ secret: String(s.body.secret) }) }).expect(200);
    csrf = csrfOf(c);
  }
  return {
    id: String(u._id),
    email,
    code: `CODE${n}XYZ`,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}
type M = Awaited<ReturnType<typeof member>>;

const balance = async (id: string) => (await User.findById(id).lean())!.walletBalancePaise;
const credits = async (id: string) => (await User.findById(id).lean())!.creditBalance;

function sendWebhook(t: T, event: string, payload: Record<string, unknown>, eventId?: string) {
  const w = t.mock.webhook(event, payload, eventId);
  return request(t.app).post('/api/v1/webhooks/razorpay').set(w.headers).send(w.body);
}

/** The invited member buys a pack with cash; returns once the (mock) payment has been captured. */
async function buyPack(t: T, m: M, packCode = 'pack_1', paymentId = `pay_${Math.random().toString(36).slice(2, 8)}`, extra: Record<string, unknown> = {}) {
  const o = (await m.post('/billing/packs/order').send({ packCode, ...extra }).expect(201)).body;
  if (!o.paid) {
    await sendWebhook(t, 'payment.captured', { payment: t.mock.paymentEntity({ id: paymentId, orderId: o.orderId, amount: o.amountPaise }) }).expect(200);
  }
  return { ...o, paymentId };
}

const DAY = 86_400_000;

describe('attribution', () => {
  it('records a referral at sign-up from a code, and ignores unknown codes', async () => {
    const t = setup();
    const referrer = await member(t);
    const reg = (code: string, email: string) =>
      request(t.app)
        .post('/api/v1/auth/register')
        .send({ email, password: 'Str0ngPassw0rd!x', firstName: 'Nina', gender: 'woman', dob: '1996-02-02', acceptTerms: true, referralCode: code });
    await reg(referrer.code, 'nina@example.com').expect(202);
    const nina = await User.findOne({ email: 'nina@example.com' }).lean();
    expect(String(nina!.referredBy)).toBe(referrer.id);
    const r = await Referral.findOne({ refereeId: nina!._id }).lean();
    expect(r).toMatchObject({ status: 'attributed' });

    await reg('NOSUCHCODE', 'omar@example.com').expect(202);
    expect(await Referral.countDocuments({})).toBe(1);
  });

  it('flags sign-ups from the same network for review', async () => {
    const t = setup();
    // The referrer signs up through the API too, so both carry the same (test) network hash.
    const body = (email: string, extra = {}) => ({ email, password: 'Str0ngPassw0rd!x', firstName: 'Sam', gender: 'man', dob: '1995-01-01', acceptTerms: true, ...extra });
    await request(t.app).post('/api/v1/auth/register').send(body('first@example.com')).expect(202);
    const first = (await User.findOne({ email: 'first@example.com' }).lean())!;
    await request(t.app).post('/api/v1/auth/register').send(body('second@example.com', { referralCode: first.referralCode })).expect(202);
    const second = (await User.findOne({ email: 'second@example.com' }).lean())!;
    const r = (await Referral.findOne({ refereeId: second._id }).lean())!;
    expect(r.flags).toContain('same_network');
  });
});

describe('abuse checks', () => {
  it('flags the same device, and sign-ups beyond the daily limit', async () => {
    const t = setup();
    const referrer = await member(t, { signupDeviceHash: 'dev-1' });
    const a = await member(t, { referredBy: undefined });
    await attribute(t.ctx, { id: a.id, deviceHash: 'dev-1' }, referrer.id, referrer.code);
    expect((await Referral.findOne({ refereeId: a.id }).lean())!.flags).toContain('same_device');
    for (let k = 0; k < 5; k++) {
      const x = await member(t, { referredBy: undefined });
      await attribute(t.ctx, { id: x.id }, referrer.id, referrer.code);
    }
    const last = await member(t, { referredBy: undefined });
    await attribute(t.ctx, { id: last.id }, referrer.id, referrer.code);
    expect((await Referral.findOne({ refereeId: last.id }).lean())!.flags).toContain('velocity');
  });

  it('flags a referee who pays with the same card or UPI id as the inviter', async () => {
    const t = setup();
    const referrer = await member(t);
    const referee = await member(t, { referredBy: undefined });
    await Referral.create({ referrerId: referrer.id, refereeId: referee.id, code: referrer.code });
    await Payment.create({ userId: referrer.id, razorpayPaymentId: 'pay_ref', kind: 'pack', amountPaise: 49_900, status: 'captured', instrumentHash: 'same' });
    await Payment.create({ userId: referee.id, razorpayPaymentId: 'pay_new', kind: 'pack', amountPaise: 49_900, status: 'captured', instrumentHash: 'same' });
    expect(await onPayment(referee.id, 'pay_new', 49_900)).toBe(true);
    expect((await Referral.findOne({ refereeId: referee.id }).lean())!.flags).toContain('same_instrument');
  });
});

describe('qualification and release', () => {
  async function invited(t: T) {
    const referrer = await member(t);
    const referee = await member(t, { referredBy: undefined });
    await Referral.create({ referrerId: referrer.id, refereeId: referee.id, code: referrer.code });
    return { referrer, referee };
  }

  it('starts the hold on the first qualifying cash payment and pays both after it, once', async () => {
    const t = setup();
    const { referrer, referee } = await invited(t);
    await buyPack(t, referee, 'pack_1');
    const q = (await Referral.findOne({ refereeId: referee.id }).lean())!;
    expect(q.status).toBe('qualified');
    expect(q.releaseAt!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);

    // Before the hold ends nothing moves.
    expect(await releaseDue(new Date())).toMatchObject({ rewarded: 0 });
    expect(await balance(referrer.id)).toBe(0);

    const later = new Date(Date.now() + 8 * DAY);
    expect(await releaseDue(later)).toMatchObject({ rewarded: 1 });
    expect(await balance(referrer.id)).toBe(20_000);
    expect(await balance(referee.id)).toBe(10_000);
    // Running the sweep again never pays twice.
    await releaseDue(later);
    expect(await balance(referrer.id)).toBe(20_000);
    expect(await WalletLedger.countDocuments({ type: 'reward' })).toBe(2);
    expect(await Outbox.countDocuments({ eventType: 'referral.rewarded' })).toBe(2);

    // A later purchase does not start another reward.
    await buyPack(t, referee, 'pack_1');
    expect((await Referral.findOne({ refereeId: referee.id }).lean())!.status).toBe('rewarded');
  });

  it('ignores purchases below the minimum and wallet-only purchases', async () => {
    const t = setup();
    const { referee } = await invited(t);
    await Setting.create({ key: 'referral', value: { minPurchasePaise: 100_000 } });
    await buyPack(t, referee, 'pack_1');
    expect((await Referral.findOne({ refereeId: referee.id }).lean())!.status).toBe('attributed');

    await Setting.deleteMany({});
    await User.updateOne({ _id: referee.id }, { $set: { walletBalancePaise: 100_000 } });
    const o = await buyPack(t, referee, 'pack_1', undefined, { useWallet: true });
    expect(o.paid).toBe(true);
    expect((await Referral.findOne({ refereeId: referee.id }).lean())!.status).toBe('attributed');
  });

  it('cancels the reward if the first purchase is refunded during the hold', async () => {
    const t = setup();
    const { referrer, referee } = await invited(t);
    await buyPack(t, referee, 'pack_1', 'pay_to_refund');
    const pay = (await Payment.findOne({ razorpayPaymentId: 'pay_to_refund' }).lean())!;
    const { refundPayment } = await import('../src/services/billing');
    await refundPayment(t.ctx, { userId: referrer.id, roles: ['finance'] }, String(pay._id), { reason: 'Customer changed their mind' });
    await releaseDue(new Date(Date.now() + 8 * DAY));
    const r = (await Referral.findOne({ refereeId: referee.id }).lean())!;
    expect(r).toMatchObject({ status: 'rejected', rejectedReason: 'purchase_refunded' });
    expect(await balance(referrer.id)).toBe(0);
  });

  it('waits for ID verification of the invited member', async () => {
    const t = setup();
    const referrer = await member(t);
    const referee = await member(t, { verification: {} });
    await Referral.create({ referrerId: referrer.id, refereeId: referee.id, code: referrer.code });
    await buyPack(t, referee, 'pack_1');
    expect(await releaseDue(new Date(Date.now() + 8 * DAY))).toMatchObject({ rewarded: 0, waiting: 1 });
    await User.updateOne({ _id: referee.id }, { $set: { 'verification.idVerifiedAt': new Date() } });
    expect(await releaseDue(new Date(Date.now() + 9 * DAY))).toMatchObject({ rewarded: 1 });
  });

  it('stops paying a referrer at the cap', async () => {
    const t = setup();
    const { referrer, referee } = await invited(t);
    await Setting.create({ key: 'referral', value: { maxRewardsPerReferrer: 1 } });
    const other = await member(t);
    await Referral.create({ referrerId: referrer.id, refereeId: other.id, code: referrer.code, status: 'rewarded', referrerRewardPaise: 1 });
    await buyPack(t, referee, 'pack_1');
    await releaseDue(new Date(Date.now() + 8 * DAY));
    expect((await Referral.findOne({ refereeId: referee.id }).lean())).toMatchObject({ status: 'rejected', rejectedReason: 'cap_reached' });
  });

  it('sends flagged referrals to a person, who can approve or reject but not their own', async () => {
    const t = setup();
    const referrer = await member(t);
    const referee = await member(t);
    const other = await member(t);
    await Referral.create({ referrerId: referrer.id, refereeId: referee.id, code: referrer.code, flags: ['same_network'] });
    await buyPack(t, referee, 'pack_1');
    await releaseDue(new Date(Date.now() + 8 * DAY));
    const r = (await Referral.findOne({ refereeId: referee.id }).lean())!;
    expect(r.status).toBe('review');
    expect(await balance(referrer.id)).toBe(0);

    const admin = await member(t, {}, ['admin']);
    const list = (await admin.get('/admin/referrals').expect(200)).body.items;
    expect(list[0]).toMatchObject({ status: 'review', flags: ['same_network'] });

    await admin.post(`/admin/referrals/${r._id}/decision`).send({ decision: 'approve', note: 'x' }).expect(422);
    await admin.post(`/admin/referrals/${r._id}/decision`).send({ decision: 'approve', note: 'Checked: different households' }).expect(200);
    expect(await balance(referrer.id)).toBe(20_000);
    await admin.post(`/admin/referrals/${r._id}/decision`).send({ decision: 'reject', note: 'Changed my mind' }).expect(409);

    // A second flagged case, rejected: no money.
    const r2 = await Referral.create({ referrerId: referrer.id, refereeId: other.id, code: referrer.code, flags: ['same_phone'], status: 'review', referrerRewardPaise: 20_000, refereeRewardPaise: 10_000 });
    await admin.post(`/admin/referrals/${r2._id}/decision`).send({ decision: 'reject', note: 'Same phone number' }).expect(200);
    expect(await balance(other.id)).toBe(0);

    // The reviewer cannot decide a referral they are part of.
    const own = await Referral.create({ referrerId: admin.id, refereeId: new mongoose.Types.ObjectId(), code: 'X', status: 'review' });
    await admin.post(`/admin/referrals/${own._id}/decision`).send({ decision: 'approve', note: 'Trying my own' }).expect(403);
  });

  it('shows the member their code, link and progress, without saying why a referral was not paid', async () => {
    const t = setup();
    const { referrer, referee } = await invited(t);
    await Referral.updateOne({ refereeId: referee.id }, { $set: { status: 'rejected', rejectedReason: 'same_network' } });
    const v = (await referrer.get('/referrals').expect(200)).body;
    expect(v.code).toBe(referrer.code);
    expect(v.link).toContain(`/register?ref=${referrer.code}`);
    expect(v.stats).toMatchObject({ joined: 1, inProgress: 0, rewarded: 0, earnedPaise: 0 });
    expect(v.invited[0]).toMatchObject({ name: referee.email ? expect.any(String) : '', state: 'joined' });
    expect(JSON.stringify(v)).not.toMatch(/same_network|reject/);
  });
});

describe('wallet', () => {
  it('pays part of a pack from the wallet and the rest in cash', async () => {
    const t = setup();
    const m = await member(t, { walletBalancePaise: 30_000 });
    const o = await buyPack(t, m, 'pack_1', 'pay_part', { useWallet: true });
    expect(o).toMatchObject({ paid: false, walletPaise: 30_000, amountPaise: 19_900 });
    expect(await balance(m.id)).toBe(0);
    expect(await credits(m.id)).toBe(1);
    // The invoice is for the cash that was paid.
    expect((await Invoice.findOne({}).lean())!.tax!.totalPaise).toBe(19_900);
    const ledger = await WalletLedger.find({ userId: m.id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'spend', deltaPaise: -30_000, balanceAfterPaise: 0 });
  });

  it('never lets the wallet pay more than the configured share of an order', async () => {
    const t = setup();
    await Setting.updateOne({ key: 'referral' }, { $set: { value: { walletMaxPercent: 50 } } }, { upsert: true });
    const m = await member(t, { walletBalancePaise: 100_000 });
    const o = await buyPack(t, m, 'pack_1', 'pay_cap', { useWallet: true });
    expect(o.walletPaise).toBe(Math.floor(49_900 / 2));
    expect(o.paid).toBe(false);
  });

  it('pays in full from the wallet with no gateway order and no invoice', async () => {
    const t = setup();
    const m = await member(t, { walletBalancePaise: 60_000 });
    const o = await buyPack(t, m, 'pack_1', undefined, { useWallet: true });
    expect(o).toMatchObject({ paid: true, amountPaise: 0, walletPaise: 49_900 });
    expect(await balance(m.id)).toBe(10_100);
    expect(await credits(m.id)).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(0);
    expect(await Order.countDocuments({ status: 'paid' })).toBe(1);
  });

  it('never lets simultaneous purchases spend the same money twice', async () => {
    const t = setup();
    const m = await member(t, { walletBalancePaise: 49_900 });
    const results = await Promise.all([
      m.post('/billing/packs/order').send({ packCode: 'pack_1', useWallet: true }),
      m.post('/billing/packs/order').send({ packCode: 'pack_1', useWallet: true }),
    ]);
    // One wins outright; the other either fails or has to pay the whole amount in cash.
    expect(await balance(m.id)).toBe(0);
    const spent = await WalletLedger.countDocuments({ type: 'spend' });
    expect(spent).toBe(1);
    expect(results.map((r) => r.status).sort()[0]).toBeLessThan(500);
    expect(await credits(m.id)).toBeLessThanOrEqual(1);
  });

  it('returns wallet money when an unpaid order expires', async () => {
    const t = setup();
    const m = await member(t, { walletBalancePaise: 20_000 });
    const o = (await m.post('/billing/packs/order').send({ packCode: 'pack_1', useWallet: true }).expect(201)).body;
    expect(await balance(m.id)).toBe(0);
    await Order.collection.updateOne({ razorpayOrderId: o.orderId }, { $set: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await reconcile(t.ctx);
    expect(await balance(m.id)).toBe(20_000);
    expect((await Order.findOne({ razorpayOrderId: o.orderId }).lean())!.status).toBe('expired');
    await reconcile(t.ctx);
    expect(await balance(m.id)).toBe(20_000);
  });

  it('adjusts a wallet only with permission, never below zero, and logs it', async () => {
    const t = setup();
    const m = await member(t, { walletBalancePaise: 5_000 });
    const admin = await member(t, {}, ['admin']);
    await m.post(`/admin/members/${m.id}/wallet`).send({ amountPaise: 100, reason: 'Sneaky top up' }).expect(403);
    await admin.post(`/admin/members/${m.id}/wallet`).send({ amountPaise: 2_500, reason: 'Goodwill after an outage' }).expect(201);
    expect(await balance(m.id)).toBe(7_500);
    await admin.post(`/admin/members/${m.id}/wallet`).send({ amountPaise: -99_000, reason: 'Remove too much money' }).expect(402);
    expect(await balance(m.id)).toBe(7_500);
    expect(await AuditLog.countDocuments({ action: 'wallet.adjusted', subjectId: m.id })).toBe(1);
    await expect(WalletLedger.deleteMany({})).rejects.toThrow(/immutable/);
    const wl = (await m.get('/wallet').expect(200)).body;
    expect(wl.balancePaise).toBe(7_500);
    expect(wl.entries[0]).toMatchObject({ type: 'adjust', deltaPaise: 2_500 });
  });
});
