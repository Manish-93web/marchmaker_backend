import 'dotenv/config';
import sharp from 'sharp';
import type { Logger } from 'pino';
import { loadEnv, type Env } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/connection';
import { fieldCryptoFromEnv } from '../lib/keys';
import { createLogger } from '../lib/logger';
import { hashPassword } from '../lib/passwords';
import { createStorage } from '../lib/storage';
import { User } from '../models/core';
import { Introduction, MatchSuggestion } from '../models/matching';
import { Photo, Preference, Profile } from '../models/profile';
import { Message, MessageThread, Report } from '../models/social';
import { Ticket, TicketMessage } from '../models/safety';

/**
 * Demo data for local development and staging walkthroughs: 40 realistic members with approved profiles,
 * preferences and generated photos, plus match suggestions in every review state and introductions in every
 * state (with a conversation, a report and a support ticket). It refuses to run in production.
 *
 *   pnpm --filter @marchmaker/api seed:demo            add (or top up) the demo members
 *   pnpm --filter @marchmaker/api seed:demo -- --reset remove every demo member first
 *
 * Demo members use @demo.marchmaker.invalid addresses and the password below, so they are easy to find and
 * can never receive real mail.
 */
const DEMO_DOMAIN = 'demo.marchmaker.invalid';
const PASSWORD = 'DemoPass#2026';

const WOMEN = ['Aanya', 'Diya', 'Meera', 'Ishita', 'Kavya', 'Nisha', 'Priya', 'Riya', 'Sanya', 'Tara', 'Anjali', 'Bhavna', 'Charu', 'Deepa', 'Esha', 'Falguni', 'Gauri', 'Harini', 'Isha', 'Jaya'];
const MEN = ['Arjun', 'Rohan', 'Vikram', 'Karan', 'Aditya', 'Nikhil', 'Rahul', 'Siddharth', 'Varun', 'Yash', 'Amit', 'Bharat', 'Chirag', 'Dev', 'Ekansh', 'Farhan', 'Gaurav', 'Harsh', 'Imran', 'Jatin'];
const SURNAMES = ['Sharma', 'Iyer', 'Nair', 'Patel', 'Reddy', 'Mehta', 'Gupta', 'Singh', 'Khan', 'Das', 'Joshi', 'Menon', 'Kulkarni', 'Bose', 'Verma', 'Shah', 'Pillai', 'Chopra', 'Rao', 'Banerjee'];
const CITIES: [string, string, [number, number], string][] = [
  ['Bengaluru', 'Karnataka', [77.59, 12.97], 'Kannada'],
  ['Mumbai', 'Maharashtra', [72.88, 19.08], 'Marathi'],
  ['Delhi', 'Delhi', [77.21, 28.61], 'Hindi'],
  ['Pune', 'Maharashtra', [73.86, 18.52], 'Marathi'],
  ['Chennai', 'Tamil Nadu', [80.27, 13.08], 'Tamil'],
  ['Hyderabad', 'Telangana', [78.49, 17.38], 'Telugu'],
  ['Kolkata', 'West Bengal', [88.36, 22.57], 'Bengali'],
  ['Ahmedabad', 'Gujarat', [72.57, 23.02], 'Gujarati'],
];
const PROFESSIONS = ['Software engineer', 'Doctor', 'Chartered accountant', 'Architect', 'Teacher', 'Product manager', 'Lawyer', 'Data scientist', 'Civil engineer', 'Designer'];
const EDU = ['B.Tech', 'MBBS', 'MBA', 'B.Arch', 'M.Sc', 'B.Com', 'LLB', 'M.Tech'];
const RELIGIONS = ['Hindu', 'Hindu', 'Hindu', 'Muslim', 'Sikh', 'Christian', 'Jain'];
const BIOS = [
  'I like slow weekend mornings, filter coffee and long walks. Looking for someone kind who values family and honest conversation.',
  'Work keeps me busy but Sundays are for cooking with my parents and calling my grandmother. I would love a partner who enjoys simple joys.',
  'I read a lot, travel when I can and take my fitness seriously. I am hoping to find someone thoughtful who is ready for marriage.',
  'Family means everything to me. I am easy-going, a little shy at first and a great listener once I warm up.',
];

const seeded = (n: number) => () => {
  n = (n * 1664525 + 1013904223) >>> 0;
  return n / 2 ** 32;
};

async function photoBuffers(initials: string, hue: number) {
  const svg = (size: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 1.25)}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},55%,38%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="55%" font-size="${size / 3}" font-family="Helvetica" fill="white" text-anchor="middle">${initials}</text></svg>`,
    );
  const out: Record<string, Buffer> = {};
  for (const [name, size] of [['sm', 320], ['md', 640], ['lg', 1080], ['blur', 24]] as const) out[name] = await sharp(svg(size)).webp({ quality: 80 }).toBuffer();
  return out;
}

export async function seedDemo(env: Env, log: Logger, opts: { reset?: boolean } = {}) {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  const crypto = fieldCryptoFromEnv(env);
  const storage = createStorage(env);

  const re = new RegExp(`@${DEMO_DOMAIN.replace(/\./g, '\\.')}$`);
  if (opts.reset) {
    const ids = (await User.find({ email: re }).select('_id').lean()).map((u) => u._id);
    await Promise.all([
      Photo.deleteMany({ userId: { $in: ids } }),
      Profile.deleteMany({ userId: { $in: ids } }),
      Preference.deleteMany({ userId: { $in: ids } }),
      MatchSuggestion.deleteMany({ $or: [{ memberA: { $in: ids } }, { memberB: { $in: ids } }] }),
      Introduction.deleteMany({ 'members.userId': { $in: ids } }),
      MessageThread.deleteMany({ members: { $in: ids } }),
      Message.deleteMany({ senderId: { $in: ids } }),
      Report.deleteMany({ reporterId: { $in: ids } }),
      Ticket.deleteMany({ userId: { $in: ids } }),
      User.deleteMany({ _id: { $in: ids } }),
    ]);
    log.info({ removed: ids.length }, 'demo members removed');
  }

  const passwordHash = await hashPassword(PASSWORD);
  const people: { id: string; first: string; gender: 'woman' | 'man'; email: string }[] = [];
  for (let i = 0; i < 40; i++) {
    const woman = i < 20;
    const first = (woman ? WOMEN : MEN)[i % 20]!;
    const last = SURNAMES[(i * 7) % SURNAMES.length]!;
    const rnd = seeded(i + 11);
    const email = `${first}.${last}${i}@${DEMO_DOMAIN}`.toLowerCase();
    const year = 1992 + Math.floor(rnd() * 8);
    const [city, state, coordinates, tongue] = CITIES[Math.floor(rnd() * CITIES.length)]!;
    const profession = PROFESSIONS[Math.floor(rnd() * PROFESSIONS.length)]!;
    const religion = RELIGIONS[Math.floor(rnd() * RELIGIONS.length)]!;
    const gender = woman ? ('woman' as const) : ('man' as const);

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        passwordHash,
        firstName: first,
        gender,
        dobEnc: crypto.encrypt(`${year}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`),
        dobYear: year,
        roles: ['member'],
        emailVerifiedAt: new Date(),
        journeyState: 'matching_active',
        creditBalance: 2,
        verification: { idVerifiedAt: new Date() },
        plan: i % 5 === 0 ? { planCode: 'premium', status: 'active', currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) } : { planCode: i % 3 === 0 ? 'essential' : 'free', status: 'active' },
      });
      const data = {
        basics: { firstName: first, lastName: last, heightCm: woman ? 155 + Math.floor(rnd() * 20) : 165 + Math.floor(rnd() * 25), maritalStatus: 'never_married', hasChildren: false },
        background: { religion, motherTongue: tongue, city, state, country: 'India', coordinates },
        education_career: { highestEducation: EDU[Math.floor(rnd() * EDU.length)], profession },
        family: { familyType: rnd() > 0.5 ? 'nuclear' : 'joint', siblings: Math.floor(rnd() * 3), familyValues: 'moderate' },
        lifestyle: { diet: rnd() > 0.6 ? 'non_vegetarian' : 'vegetarian', smoking: 'never', drinking: rnd() > 0.8 ? 'occasionally' : 'never', fitness: 'sometimes' },
        values: { marriageTimeline: rnd() > 0.5 ? 'within_1_year' : '1_2_years', wantsKids: rnd() > 0.2 ? 'yes' : 'open', livingWithFamily: rnd() > 0.5 ? 'open' : 'no', settleCity: city },
        about: { bio: BIOS[i % BIOS.length], prompts: [] },
        photos: {},
      };
      await Profile.create({
        userId: user._id,
        data,
        completedSteps: ['basics', 'background', 'education_career', 'family', 'lifestyle', 'values', 'about', 'photos'],
        currentStep: 'photos',
        status: 'approved',
        birthYear: year,
        gender,
        geo: { type: 'Point', coordinates },
        submittedAt: new Date(),
        approvedAt: new Date(),
      });
      await Preference.create({
        userId: user._id,
        dimensions: [
          { key: 'age', range: { min: 24, max: 42 }, values: [], type: 'must', importance: 3 },
          { key: 'religion', values: [religion], type: rnd() > 0.5 ? 'must' : 'flexible', importance: 2 },
          { key: 'diet', values: [data.lifestyle.diet as string], type: 'flexible', importance: 1 },
          { key: 'marriage_timeline', values: [data.values.marriageTimeline as string], type: 'flexible', importance: 2 },
        ],
      });
      const bufs = await photoBuffers(`${first[0]}${last[0]}`, Math.floor(rnd() * 360));
      const variants: Record<string, string> = {};
      for (const [name, buf] of Object.entries(bufs)) {
        variants[name] = `demo/${String(user._id)}/${name}.webp`;
        await storage.put('photos', variants[name]!, buf, 'image/webp');
      }
      await Photo.create({ userId: user._id, key: `demo/${String(user._id)}/raw`, variants, contentType: 'image/webp', width: 1080, height: 1350, isPrimary: true, order: 0, status: 'approved', hash: `demo-${String(user._id)}` });
    }
    people.push({ id: String(user._id), first, gender, email });
  }
  log.info({ members: people.length }, 'demo members ensured');

  // ---- suggestions in every review state, and introductions in every introduction state
  const pair = (i: number) => [people[i]!, people[20 + ((i + 3) % 20)]!] as const;
  const key = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const day = 86_400_000;
  const suggestionStates = ['suggested', 'suggested', 'in_review', 'snoozed', 'escalated', 'rejected'] as const;
  for (const [n, status] of suggestionStates.entries()) {
    const [a, b] = pair(30 - 20 + n);
    await MatchSuggestion.updateOne(
      { pairKey: key(a.id, b.id) },
      { $setOnInsert: { pairKey: key(a.id, b.id), memberA: a.id, memberB: b.id, score: 0.6 + n * 0.05, signals: { preferences: 0.7, assessments: 0.6, plans: 0.65 }, reasons: [{ code: 'shared_timeline' }], status, whyText: status === 'rejected' ? undefined : 'You both want to marry within a couple of years and enjoy a simple, family-centred life.', generatedAt: new Date(), rejectionCode: status === 'rejected' ? 'not_a_fit' : undefined } },
      { upsert: true },
    );
  }

  const states = [
    { state: 'released', members: ['pending', 'pending'] },
    { state: 'viewed', members: ['pending', 'pending'], viewed: true },
    { state: 'accepted_by_one', members: ['accepted', 'pending'] },
    { state: 'mutually_accepted', members: ['accepted', 'accepted'], unlocked: true },
    { state: 'mutually_accepted', members: ['accepted', 'accepted'], unlocked: true },
    { state: 'declined', members: ['declined', 'pending'], closedReason: 'declined' },
    { state: 'expired', members: ['pending', 'pending'], closedReason: 'expired' },
  ] as const;
  let threadFor: string | undefined;
  for (const [n, s] of states.entries()) {
    const [a, b] = pair(n);
    const pk = key(a.id, b.id);
    if (await Introduction.exists({ pairKey: pk })) continue;
    const sug = await MatchSuggestion.create({ pairKey: pk, memberA: a.id, memberB: b.id, score: 0.82, signals: { preferences: 0.8, assessments: 0.75, plans: 0.85 }, status: 'approved', whyText: 'A reviewer picked this pair for shared values and timing.', generatedAt: new Date() });
    const intro = await Introduction.create({
      pairKey: pk,
      suggestionId: sug._id,
      members: [a, b].map((m, k) => ({ userId: m.id, status: s.members[k], viewedAt: 'viewed' in s ? new Date() : undefined, declineReason: s.members[k] === 'declined' ? 'timing_not_right' : undefined })),
      whyText: `${a.first} and ${b.first} both want to marry within a couple of years and care about family. They enjoy similar weekends and a calm pace of life.`,
      highlights: ['Both open to marrying within two years', 'Similar family values'],
      state: s.state,
      closedReason: 'closedReason' in s ? s.closedReason : undefined,
      releasedAt: new Date(Date.now() - (n + 1) * day),
      expiresAt: new Date(Date.now() + (s.state === 'expired' ? -day : 3 * day)),
      unlockedAt: 'unlocked' in s ? new Date(Date.now() - 9 * day) : undefined,
    });
    await MatchSuggestion.updateOne({ _id: sug._id }, { $set: { introductionId: intro._id, releasedAt: new Date() } });
    if ('unlocked' in s) {
      const thread = await MessageThread.create({ introductionId: intro._id, members: [a.id, b.id], lastMessageAt: new Date(), lastMessagePreview: 'That sounds lovely!' });
      threadFor ??= String(thread._id);
      const lines = ['Hello! It is nice to meet you.', 'Hi, likewise. What do you do on weekends?', 'Mostly cooking and long walks. You?', 'Same! That sounds lovely!'];
      for (const [k, body] of lines.entries()) await Message.create({ threadId: thread._id, senderId: k % 2 ? b.id : a.id, body, clientId: `demo-${String(thread._id)}-${k}`, createdAt: new Date(Date.now() - (lines.length - k) * 3_600_000) });
    }
  }

  // ---- something in the moderation and support queues
  const [rep, tgt] = [people[3]!, people[24]!];
  if (!(await Report.exists({ reporterId: rep.id, reportedId: tgt.id }))) {
    await Report.create({ reporterId: rep.id, reportedId: tgt.id, category: 'inappropriate_content', severity: 'medium', details: 'Demo report for the moderation queue.', slaDueAt: new Date(Date.now() + 20 * 3_600_000) });
  }
  if (!(await Ticket.exists({ userId: rep.id }))) {
    const t = await Ticket.create({ number: 'T-DEMO01', userId: rep.id, email: rep.email, name: rep.first, category: 'account', subject: 'How do I change my email address?', firstResponseDueAt: new Date(Date.now() + 20 * 3_600_000) });
    await TicketMessage.create({ ticketId: t._id, author: 'member', authorId: rep.id, body: 'I would like to use a new email address. How do I do that?' });
  }

  log.info({ password: PASSWORD, example: people[0]!.email, openThread: threadFor }, 'demo data ready');
  return { members: people.length, password: PASSWORD };
}

// Run directly (pnpm seed:demo), not when imported by a test.
if (process.argv[1]?.includes('seedDemo')) {
  const env = loadEnv();
  const log = createLogger('info', true);
  connectMongo(env.MONGODB_URI, log)
    .then(() => seedDemo(env, log, { reset: process.argv.includes('--reset') }))
    .then(() => disconnectMongo())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
