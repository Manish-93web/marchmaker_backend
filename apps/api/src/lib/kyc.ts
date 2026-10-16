import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KycResult } from '@marchmaker/shared';
import type { Env } from '../config/env';

export interface KycSession {
  sessionId: string;
  redirectUrl: string;
}

export interface KycWebhookEvent {
  eventId: string;
  sessionId: string;
}

/**
 * Automated ID + liveness verification sits behind this interface so the vendor can be
 * swapped by env. Webhooks are advisory: results are always re-fetched with `getResult`.
 */
export interface KycProvider {
  readonly name: string;
  createSession(input: { referenceId: string; firstName: string; callbackUrl: string }): Promise<KycSession>;
  getResult(sessionId: string): Promise<KycResult>;
  /** Returns the event if the signature is valid, otherwise null. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): KycWebhookEvent | null;
}

export function signWebhook(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function checkSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signWebhook(secret, body));
  const got = Buffer.from(header.trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

function parseEvent(body: Buffer): KycWebhookEvent | null {
  try {
    const j = JSON.parse(body.toString('utf8')) as { eventId?: unknown; sessionId?: unknown };
    if (typeof j.eventId === 'string' && typeof j.sessionId === 'string') {
      return { eventId: j.eventId.slice(0, 120), sessionId: j.sessionId.slice(0, 120) };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Deterministic in-memory provider for development and tests. */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';
  readonly sessions = new Map<string, KycResult>();
  failNext = false;
  private n = 0;

  constructor(private readonly secret: string) {}

  async createSession(input: { referenceId: string }): Promise<KycSession> {
    const sessionId = `mock_${++this.n}_${input.referenceId}`;
    this.sessions.set(sessionId, {
      status: 'pending',
      confidence: 0,
      nameMatch: false,
      dobMatch: false,
      faceMatch: false,
      livenessPassed: false,
    });
    return { sessionId, redirectUrl: `https://kyc.mock.invalid/session/${sessionId}` };
  }

  async getResult(sessionId: string): Promise<KycResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider unavailable');
    }
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('unknown session');
    return r;
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): KycWebhookEvent | null {
    return checkSignature(this.secret, rawBody, headers['x-kyc-signature']) ? parseEvent(rawBody) : null;
  }

  /** Test/dev helper: records what the "vendor" decided. */
  complete(sessionId: string, result: Partial<KycResult> & { status?: KycResult['status'] }): void {
    const cur = this.sessions.get(sessionId);
    if (!cur) throw new Error('unknown session');
    this.sessions.set(sessionId, { ...cur, status: 'completed', ...result });
  }
}

/**
 * Generic HTTPS adapter for a vendor (or an in-house gateway) that exposes:
 *   POST {base}/sessions         { referenceId, firstName, callbackUrl } -> { sessionId, redirectUrl }
 *   GET  {base}/sessions/{id}    -> KycResult JSON (see docs/KYC.md)
 * Webhook bodies are `{ eventId, sessionId }` signed with HMAC-SHA256 in `X-KYC-Signature`.
 * Vendor-specific field mapping belongs in the gateway or a dedicated subclass.
 */
export class RestKycProvider implements KycProvider {
  readonly name = 'rest';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly secret: string,
  ) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`kyc provider returned ${res.status}`);
    return (await res.json()) as T;
  }

  createSession(input: { referenceId: string; firstName: string; callbackUrl: string }) {
    return this.call<KycSession>('/sessions', { method: 'POST', body: JSON.stringify(input) });
  }

  getResult(sessionId: string) {
    return this.call<KycResult>(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): KycWebhookEvent | null {
    return checkSignature(this.secret, rawBody, headers['x-kyc-signature']) ? parseEvent(rawBody) : null;
  }
}

export function createKycProvider(env: Env): KycProvider | null {
  if (env.KYC_PROVIDER === 'mock') return new MockKycProvider(env.KYC_WEBHOOK_SECRET);
  if (env.KYC_PROVIDER === 'rest' && env.KYC_BASE_URL && env.KYC_API_KEY) {
    return new RestKycProvider(env.KYC_BASE_URL.replace(/\/$/, ''), env.KYC_API_KEY, env.KYC_WEBHOOK_SECRET);
  }
  return null;
}

export { CircuitOpenError } from './breaker';
