import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import type { Env } from '../config/env';

export interface CallEvent {
  providerCallId: string;
  status: 'ringing' | 'in_progress' | 'completed' | 'failed' | 'no_answer' | 'busy';
  durationSec?: number;
}

export interface CallProvider {
  readonly name: 'mock' | 'exotel';
  /**
   * Rings the first number, then bridges the second. Both people see only the platform's virtual
   * number; neither number is ever revealed to the other. Calls are not recorded.
   */
  connect(i: { fromE164: string; toE164: string; reference: string }): Promise<{ providerCallId: string }>;
  /** Status callback: a valid signature gives the parsed event, otherwise null. */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): CallEvent | null;
}

const sign = (secret: string, body: Buffer | string) => createHmac('sha256', secret).update(body).digest('hex');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function parseEvent(raw: Buffer, headers: Record<string, string | undefined>, secret: string): CallEvent | null {
  const sig = headers['x-call-signature'];
  if (!sig || !same(sign(secret, raw), sig.trim())) return null;
  try {
    const b = JSON.parse(raw.toString('utf8')) as Partial<CallEvent>;
    if (!b.providerCallId || !b.status) return null;
    return { providerCallId: b.providerCallId, status: b.status, durationSec: b.durationSec };
  } catch {
    return null;
  }
}

export class MockCallProvider implements CallProvider {
  readonly name = 'mock' as const;
  readonly calls: { providerCallId: string; fromE164: string; toE164: string; reference: string }[] = [];
  failNext = false;
  private n = 0;
  constructor(
    private readonly secret: string,
    private readonly log?: Logger,
  ) {}
  async connect(i: { fromE164: string; toE164: string; reference: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('telephony unavailable');
    }
    const providerCallId = `call_${++this.n}`;
    this.calls.push({ providerCallId, ...i });
    // Numbers are deliberately not logged.
    this.log?.info({ reference: i.reference }, 'mock call placed');
    return { providerCallId };
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>) {
    return parseEvent(raw, headers, this.secret);
  }
  /** A signed status callback as the provider would send it (tests and development). */
  event(e: CallEvent) {
    const body = JSON.stringify(e);
    return { body, headers: { 'x-call-signature': sign(this.secret, body), 'content-type': 'application/json' } };
  }
}

/** Exotel "connect two numbers" call. Credentials and the virtual number come from the environment. */
export class ExotelCalls implements CallProvider {
  readonly name = 'exotel' as const;
  constructor(
    private readonly sid: string,
    private readonly key: string,
    private readonly token: string,
    private readonly callerId: string,
    private readonly secret: string,
  ) {}
  async connect(i: { fromE164: string; toE164: string; reference: string }) {
    const body = new URLSearchParams({
      From: i.fromE164,
      To: i.toE164,
      CallerId: this.callerId,
      CallType: 'trans',
      Record: 'false',
      CustomField: i.reference,
    });
    const res = await fetch(`https://api.exotel.com/v1/Accounts/${this.sid}/Calls/connect.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.key}:${this.token}`).toString('base64')}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telephony returned ${res.status}`);
    const json = (await res.json()) as { Call?: { Sid?: string } };
    if (!json.Call?.Sid) throw new Error('telephony returned no call id');
    return { providerCallId: json.Call.Sid };
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>) {
    return parseEvent(raw, headers, this.secret);
  }
}

export function createCallProvider(env: Env, log: Logger): CallProvider | null {
  if (env.CALLS_PROVIDER === 'mock') return new MockCallProvider(env.CALLS_WEBHOOK_SECRET, log);
  if (env.CALLS_PROVIDER === 'exotel' && env.EXOTEL_SID && env.EXOTEL_KEY && env.EXOTEL_TOKEN && env.CALLS_CALLER_ID) {
    return new ExotelCalls(env.EXOTEL_SID, env.EXOTEL_KEY, env.EXOTEL_TOKEN, env.CALLS_CALLER_ID, env.CALLS_WEBHOOK_SECRET);
  }
  return null;
}
