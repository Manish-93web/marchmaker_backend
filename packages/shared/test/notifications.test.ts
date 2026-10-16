import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_SPECS,
  decideChannels,
  inQuietHours,
  quietEnd,
  resolvePrefs,
  type DecisionInput,
} from '../src/notifications';

// 23:00 IST = 17:30 UTC; 10:00 IST = 04:30 UTC
const NIGHT = new Date('2026-03-10T17:30:00Z');
const DAY = new Date('2026-03-10T04:30:00Z');

const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  spec: NOTIFICATION_SPECS['introduction.released']!,
  prefs: resolvePrefs({}),
  consents: {},
  planCode: 'free',
  hasEmail: true,
  hasVerifiedPhone: true,
  hasPush: false,
  now: DAY,
  ...over,
});

describe('quiet hours', () => {
  const q = { enabled: true, start: '22:00', end: '08:00' };
  it('wraps midnight in India time', () => {
    expect(inQuietHours(NIGHT, q)).toBe(true);
    expect(inQuietHours(DAY, q)).toBe(false);
    expect(inQuietHours(NIGHT, { ...q, enabled: false })).toBe(false);
  });
  it('finds the end of the window', () => {
    // 23:00 IST -> 08:00 IST next day = 02:30 UTC
    expect(quietEnd(NIGHT, q).toISOString()).toBe('2026-03-11T02:30:00.000Z');
  });
  it('handles a same-day window', () => {
    const s = { enabled: true, start: '13:00', end: '15:00' };
    expect(inQuietHours(new Date('2026-03-10T08:00:00Z'), s)).toBe(true); // 13:30 IST
    expect(inQuietHours(new Date('2026-03-10T10:00:00Z'), s)).toBe(false); // 15:30 IST
  });
});

describe('channel decisions', () => {
  it('uses in-app and email by default and skips WhatsApp without consent', () => {
    const d = decideChannels(base());
    expect(d.send).toEqual(['in_app', 'email']);
    expect(d.skipped.whatsapp).toBe('turned_off');
  });
  it('requires consent, a verified phone and a premium plan for WhatsApp', () => {
    const prefs = resolvePrefs({ channels: { introductions: { whatsapp: true } } });
    expect(decideChannels(base({ prefs })).skipped.whatsapp).toBe('no_consent');
    expect(decideChannels(base({ prefs, consents: { whatsapp: true } })).skipped.whatsapp).toBe('plan');
    expect(decideChannels(base({ prefs, consents: { whatsapp: true }, hasVerifiedPhone: false, planCode: 'premium' })).skipped.whatsapp).toBe('no_verified_phone');
    expect(decideChannels(base({ prefs, consents: { whatsapp: true }, planCode: 'premium' })).send).toContain('whatsapp');
  });
  it('defers non-critical external channels during quiet hours but not in-app', () => {
    const d = decideChannels(base({ now: NIGHT }));
    expect(d.send).toContain('in_app');
    expect(d.deferUntil?.toISOString()).toBe('2026-03-11T02:30:00.000Z');
  });
  it('sends critical messages through quiet hours and switched-off channels', () => {
    const prefs = resolvePrefs({ channels: { billing: { in_app: false, email: false } } });
    const d = decideChannels(base({ spec: NOTIFICATION_SPECS['billing.payment_failed']!, prefs, now: NIGHT }));
    expect(d.send).toEqual(['in_app', 'email']);
    expect(d.deferUntil).toBeUndefined();
  });
  it('never emails product updates without marketing consent', () => {
    const prefs = resolvePrefs({ channels: { product_updates: { email: true } } });
    const spec = { category: 'product_updates' as const };
    expect(decideChannels(base({ spec, prefs })).skipped.email).toBe('no_consent');
    expect(decideChannels(base({ spec, prefs, consents: { marketing_email: true } })).send).toContain('email');
  });
  it('respects channel restrictions on a message', () => {
    const d = decideChannels(base({ spec: NOTIFICATION_SPECS['invoice.created']! }));
    expect(d.send).toEqual(['in_app']);
  });
});

describe('notification copy', () => {
  it('never mentions scores, names or the other person answer', () => {
    for (const [type, spec] of Object.entries(NOTIFICATION_SPECS)) {
      const c = spec.copy({ introductionId: 'i1', hoursLeft: 12, threadId: 't1', credits: 2 });
      expect(`${c.title} ${c.body}`, type).not.toMatch(/\d+%|score|accepted|said yes to you/i);
      expect(c.url.startsWith('/')).toBe(true);
    }
  });
});
