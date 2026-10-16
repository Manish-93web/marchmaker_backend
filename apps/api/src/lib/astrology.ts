import { z } from 'zod';
import type { BirthDetails } from '@marchmaker/shared';
import type { Env } from '../config/env';

export const chartSchema = z.object({
  sunSign: z.string().max(40),
  moonSign: z.string().max(40),
  ascendant: z.string().max(40),
  nakshatra: z.string().max(40),
  highlights: z.array(z.string().max(300)).max(8),
});
export type Chart = z.infer<typeof chartSchema>;

export const matchSchema = z.object({
  points: z.number().min(0).max(36),
  maxPoints: z.literal(36),
  summary: z.string().max(600),
  kootas: z.array(z.object({ name: z.string().max(30), points: z.number(), max: z.number() })).max(8),
});
export type MatchResult = z.infer<typeof matchSchema>;

export interface AstrologyProvider {
  readonly name: 'mock' | 'rest';
  /** True when results are placeholders, so the app can say so. */
  readonly sample: boolean;
  chart(i: { dob: string; birth: BirthDetails }): Promise<Chart>;
  match(a: { dob: string; birth: BirthDetails }, b: { dob: string; birth: BirthDetails }): Promise<MatchResult>;
}

const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const NAKSHATRAS = [
  'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha',
  'Magha', 'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha',
  'Mula', 'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta', 'Shatabhisha', 'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati',
];
const h = (s: string) => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);

/**
 * Development placeholder. It is deterministic but NOT astronomy, and every response is marked
 * `sample` so nobody mistakes it for a real chart. Production uses a licensed provider.
 */
export class MockAstrology implements AstrologyProvider {
  readonly name = 'mock' as const;
  readonly sample = true;
  async chart(i: { dob: string; birth: BirthDetails }): Promise<Chart> {
    const seed = h(`${i.dob}|${i.birth.time}|${i.birth.place}`);
    return {
      sunSign: SIGNS[seed % 12]!,
      moonSign: SIGNS[(seed >>> 4) % 12]!,
      ascendant: SIGNS[(seed >>> 8) % 12]!,
      nakshatra: NAKSHATRAS[(seed >>> 3) % 27]!,
      highlights: ['Sample report for development only.'],
    };
  }
  async match(a: { dob: string; birth: BirthDetails }, b: { dob: string; birth: BirthDetails }): Promise<MatchResult> {
    const seed = h([`${a.dob}${a.birth.time}`, `${b.dob}${b.birth.time}`].sort().join('|'));
    const names: [string, number][] = [['Varna', 1], ['Vashya', 2], ['Tara', 3], ['Yoni', 4], ['Graha Maitri', 5], ['Gana', 6], ['Bhakoot', 7], ['Nadi', 8]];
    const kootas = names.map(([name, max], k) => ({ name, max, points: (seed >>> k) % (max + 1) }));
    const points = kootas.reduce((s, x) => s + x.points, 0);
    return { points, maxPoints: 36, summary: 'Sample compatibility for development only.', kootas };
  }
}

/** A licensed astrology API behind a small JSON contract: POST /chart and POST /match. */
export class RestAstrology implements AstrologyProvider {
  readonly name = 'rest' as const;
  readonly sample = false;
  constructor(
    private readonly base: string,
    private readonly key: string,
  ) {}
  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`astrology provider returned ${res.status}`);
    // Never trust the shape of a third party's response.
    return schema.parse(await res.json());
  }
  chart(i: { dob: string; birth: BirthDetails }) {
    return this.post('/chart', { dob: i.dob, ...i.birth }, chartSchema);
  }
  match(a: { dob: string; birth: BirthDetails }, b: { dob: string; birth: BirthDetails }) {
    return this.post('/match', { a: { dob: a.dob, ...a.birth }, b: { dob: b.dob, ...b.birth } }, matchSchema);
  }
}

export function createAstrology(env: Env): AstrologyProvider | null {
  if (env.ASTROLOGY_PROVIDER === 'mock') return new MockAstrology();
  if (env.ASTROLOGY_PROVIDER === 'rest' && env.ASTROLOGY_BASE_URL && env.ASTROLOGY_API_KEY) {
    return new RestAstrology(env.ASTROLOGY_BASE_URL.replace(/\/$/, ''), env.ASTROLOGY_API_KEY);
  }
  return null;
}
