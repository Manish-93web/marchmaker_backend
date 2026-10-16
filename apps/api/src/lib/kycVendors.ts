import { createHmac, timingSafeEqual } from 'node:crypto';
import { ID_DOC_TYPES, type KycResult } from '@marchmaker/shared';
import type { Env } from '../config/env';
import type { KycProvider, KycSession, KycWebhookEvent } from './kyc';

/**
 * Declarative adapters for hosted KYC vendors.
 *
 * Each vendor is a VendorSpec: how to authenticate, how to open a hosted verification session, how to read
 * the outcome and how to verify its webhook. The mapping from the vendor's JSON to our KycResult is a table
 * of paths and value lists, not code, so a deployment can correct a mapping with KYC_MAPPING_JSON once it
 * has real credentials, without a release.
 *
 * IMPORTANT: the presets below were written from the vendors' public documentation and have NOT been run
 * against live accounts (none exist yet). Treat them as a starting point; docs/KYC.md lists what to verify.
 * Nothing in them can approve a member on its own: the platform still only auto-approves a high-confidence
 * result and sends everything else to a person (evaluateKycResult).
 */
export interface VendorSpec {
  name: string;
  /** Request headers, built from the API key (and secret where the vendor needs both). */
  headers(apiKey: string, secret: string): Record<string, string>;
  createSession: {
    method: 'POST' | 'GET';
    path: string;
    /** Template: strings may use {referenceId} {firstName} {callbackUrl}. */
    body: Record<string, unknown>;
    sessionIdPath: string;
    redirectUrlPath: string;
  };
  getResult: {
    method: 'GET' | 'POST';
    /** {sessionId} is substituted. */
    path: string;
    /** For POST, a body template with {sessionId}. */
    body?: Record<string, unknown>;
    statusPath: string;
    /** Vendor status values that mean finished / failed. Anything else is "pending". */
    completedValues: string[];
    failedValues: string[];
    confidencePath?: string;
    /** If the vendor reports confidence as 0..100, divide by this. */
    confidenceScale?: number;
    /** Paths whose value (boolean, or a string in trueValues) means the check passed. */
    nameMatch: BoolSource;
    dobMatch: BoolSource;
    faceMatch: BoolSource;
    liveness: BoolSource;
    docTypePath?: string;
    docNumberPath?: string;
  };
  webhook: {
    header: string;
    encoding: 'hex' | 'base64';
    eventIdPath: string;
    sessionIdPath: string;
  };
}

export interface BoolSource {
  path: string;
  /** String values that count as a pass (case-insensitive). If omitted, the value must be literally true. */
  trueValues?: string[];
  /** Or a numeric score at or above this counts as a pass. */
  minScore?: number;
}

export const VENDOR_PRESETS: Record<'hyperverge' | 'idfy' | 'digio', VendorSpec> = {
  hyperverge: {
    name: 'hyperverge',
    headers: (key, secret) => ({ appId: key, appKey: secret, 'Content-Type': 'application/json' }),
    createSession: {
      method: 'POST',
      path: '/link-kyc/start',
      body: { transactionId: '{referenceId}', redirectUrl: '{callbackUrl}', userDetails: { name: '{firstName}' } },
      sessionIdPath: 'result.transactionId',
      redirectUrlPath: 'result.startKycUrl',
    },
    getResult: {
      method: 'POST',
      path: '/link-kyc/results',
      body: { transactionId: '{sessionId}' },
      statusPath: 'result.status',
      completedValues: ['auto_approved', 'approved', 'completed'],
      failedValues: ['error', 'failed', 'expired'],
      confidencePath: 'result.results.faceMatch.confidence',
      confidenceScale: 100,
      nameMatch: { path: 'result.results.nameMatch.match', trueValues: ['yes', 'true', 'matched'] },
      dobMatch: { path: 'result.results.dobMatch.match', trueValues: ['yes', 'true', 'matched'] },
      faceMatch: { path: 'result.results.faceMatch.match', trueValues: ['yes', 'true', 'matched'] },
      liveness: { path: 'result.results.liveness.liveFace', trueValues: ['yes', 'true'] },
      docTypePath: 'result.results.idCard.documentType',
      docNumberPath: 'result.results.idCard.idNumber',
    },
    webhook: { header: 'x-hyperverge-signature', encoding: 'hex', eventIdPath: 'eventId', sessionIdPath: 'transactionId' },
  },
  idfy: {
    name: 'idfy',
    headers: (key, secret) => ({ 'api-key': key, 'account-id': secret, 'Content-Type': 'application/json' }),
    createSession: {
      method: 'POST',
      path: '/v3/tasks/async/verify_with_source/ind_video_kyc',
      body: { task_id: '{referenceId}', group_id: '{referenceId}', data: { name: '{firstName}', callback_url: '{callbackUrl}' } },
      sessionIdPath: 'request_id',
      redirectUrlPath: 'result.redirect_url',
    },
    getResult: {
      method: 'GET',
      path: '/v3/tasks?request_id={sessionId}',
      statusPath: '0.status',
      completedValues: ['completed'],
      failedValues: ['failed'],
      confidencePath: '0.result.source_output.face_match_score',
      confidenceScale: 100,
      nameMatch: { path: '0.result.source_output.name_match', minScore: 80 },
      dobMatch: { path: '0.result.source_output.dob_match', trueValues: ['true', 'yes'] },
      faceMatch: { path: '0.result.source_output.face_match_score', minScore: 80 },
      liveness: { path: '0.result.source_output.liveness_check', trueValues: ['passed', 'true'] },
      docTypePath: '0.result.source_output.document_type',
      docNumberPath: '0.result.source_output.document_number',
    },
    webhook: { header: 'x-idfy-signature', encoding: 'hex', eventIdPath: 'request_id', sessionIdPath: 'request_id' },
  },
  digio: {
    name: 'digio',
    // Digio uses HTTP Basic: client id as the key, client secret as the secret.
    headers: (key, secret) => ({ Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' }),
    createSession: {
      method: 'POST',
      path: '/client/kyc/v2/request/with_template',
      body: { customer_identifier: '{referenceId}', customer_name: '{firstName}', template_name: 'MARCHMAKER_KYC', notify_customer: false, callback_url: '{callbackUrl}' },
      sessionIdPath: 'id',
      redirectUrlPath: 'access_token.entity_id',
    },
    getResult: {
      method: 'POST',
      path: '/client/kyc/v2/{sessionId}/response',
      statusPath: 'status',
      completedValues: ['approved', 'completed'],
      failedValues: ['rejected', 'failed', 'expired'],
      nameMatch: { path: 'actions.0.details.name_match', trueValues: ['true', 'yes', 'match'] },
      dobMatch: { path: 'actions.0.details.dob_match', trueValues: ['true', 'yes', 'match'] },
      faceMatch: { path: 'actions.0.face_match.verified', trueValues: ['true'] },
      liveness: { path: 'actions.0.liveness.status', trueValues: ['success', 'passed', 'true'] },
      docTypePath: 'actions.0.details.document_type',
      docNumberPath: 'actions.0.details.id_number',
    },
    webhook: { header: 'x-digio-signature', encoding: 'base64', eventIdPath: 'id', sessionIdPath: 'id' },
  },
};

// ------------------------------------------------------------------ helpers (exported for tests)

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function fill<T>(template: T, vars: Record<string, string>): T {
  if (typeof template === 'string') return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '') as T;
  if (Array.isArray(template)) return template.map((x) => fill(x, vars)) as T;
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, vars)])) as T;
  return template;
}

function passes(raw: unknown, src: BoolSource): boolean {
  const v = getPath(raw, src.path);
  if (src.minScore !== undefined) return typeof v === 'number' && v >= src.minScore;
  if (src.trueValues) return typeof v === 'string' ? src.trueValues.includes(v.toLowerCase()) : v === true;
  return v === true;
}

/** Turns a vendor's JSON into our KycResult using the spec's tables. Unknown shapes become "pending" or "failed", never "completed". */
export function mapResult(spec: VendorSpec, raw: unknown): KycResult {
  const g = spec.getResult;
  const status = String(getPath(raw, g.statusPath) ?? '').toLowerCase();
  const state: KycResult['status'] = g.completedValues.includes(status) ? 'completed' : g.failedValues.includes(status) ? 'failed' : 'pending';
  const rawConf = g.confidencePath ? Number(getPath(raw, g.confidencePath)) : NaN;
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf / (g.confidenceScale ?? 1))) : 0;
  const doc = String(getPath(raw, g.docTypePath ?? '') ?? '').toLowerCase();
  const num = String(getPath(raw, g.docNumberPath ?? '') ?? '');
  const docType = doc.includes('aadhaar') ? 'aadhaar_masked' : doc.includes('passport') ? 'passport' : doc.includes('driv') ? 'driving_licence' : doc.includes('voter') ? 'voter_id' : /pan/.test(doc) ? 'pan' : undefined;
  return {
    status: state,
    confidence,
    nameMatch: passes(raw, g.nameMatch),
    dobMatch: passes(raw, g.dobMatch),
    faceMatch: passes(raw, g.faceMatch),
    livenessPassed: passes(raw, g.liveness),
    ...(docType ? { docType: docType satisfies (typeof ID_DOC_TYPES)[number] } : {}),
    ...(num.length >= 4 ? { docLast4: num.slice(-4) } : {}),
  };
}

function signatureOk(secret: string, body: Buffer, header: string | undefined, enc: 'hex' | 'base64'): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest(enc));
  const got = Buffer.from(header.trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export class VendorKycProvider implements KycProvider {
  readonly name: string;
  constructor(
    private readonly spec: VendorSpec,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly webhookSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = spec.name;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.spec.headers(this.apiKey, this.apiSecret),
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw Object.assign(new Error(`kyc vendor returned ${res.status}`), { status: res.status });
    return res.json();
  }

  async createSession(input: { referenceId: string; firstName: string; callbackUrl: string }): Promise<KycSession> {
    const c = this.spec.createSession;
    const raw = await this.call(c.method, c.path, fill(c.body, input));
    const sessionId = getPath(raw, c.sessionIdPath);
    const redirectUrl = getPath(raw, c.redirectUrlPath);
    if (typeof sessionId !== 'string' || typeof redirectUrl !== 'string') throw new Error('kyc vendor response did not include a session');
    return { sessionId, redirectUrl };
  }

  async getResult(sessionId: string): Promise<KycResult> {
    const g = this.spec.getResult;
    const raw = await this.call(g.method, fill(g.path, { sessionId: encodeURIComponent(sessionId) }), g.body ? fill(g.body, { sessionId }) : undefined);
    return mapResult(this.spec, raw);
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): KycWebhookEvent | null {
    const w = this.spec.webhook;
    if (!signatureOk(this.webhookSecret, rawBody, headers[w.header], w.encoding)) return null;
    try {
      const j = JSON.parse(rawBody.toString('utf8'));
      const eventId = getPath(j, w.eventIdPath);
      const sessionId = getPath(j, w.sessionIdPath);
      if (typeof eventId === 'string' && typeof sessionId === 'string') return { eventId: eventId.slice(0, 120), sessionId: sessionId.slice(0, 120) };
    } catch {
      /* not JSON */
    }
    return null;
  }
}

/** Presets can be corrected per deployment: KYC_MAPPING_JSON is merged over the preset (shallow per section). */
export function createVendorKyc(env: Pick<Env, 'KYC_PROVIDER' | 'KYC_BASE_URL' | 'KYC_API_KEY' | 'KYC_API_SECRET' | 'KYC_WEBHOOK_SECRET' | 'KYC_MAPPING_JSON'>): KycProvider | null {
  if (env.KYC_PROVIDER !== 'hyperverge' && env.KYC_PROVIDER !== 'idfy' && env.KYC_PROVIDER !== 'digio') return null;
  if (!env.KYC_BASE_URL || !env.KYC_API_KEY) return null;
  const preset = VENDOR_PRESETS[env.KYC_PROVIDER];
  const patch = env.KYC_MAPPING_JSON ? (JSON.parse(env.KYC_MAPPING_JSON) as Partial<Pick<VendorSpec, 'createSession' | 'getResult' | 'webhook'>>) : {};
  const spec: VendorSpec = {
    ...preset,
    createSession: { ...preset.createSession, ...patch.createSession },
    getResult: { ...preset.getResult, ...patch.getResult },
    webhook: { ...preset.webhook, ...patch.webhook },
  };
  return new VendorKycProvider(spec, env.KYC_BASE_URL.replace(/\/$/, ''), env.KYC_API_KEY, env.KYC_API_SECRET ?? '', env.KYC_WEBHOOK_SECRET);
}
