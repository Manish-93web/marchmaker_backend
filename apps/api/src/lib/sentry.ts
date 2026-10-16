import * as Sentry from '@sentry/node';
import type { Env } from '../config/env';

let enabled = false;

const SENSITIVE_KEYS = /pass|token|secret|authorization|cookie|otp|code|email|phone|dob|body|signature/i;

/** Removes anything that could be personal data before an event leaves the process. */
export function scrub<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out as T;
}

/** Starts error tracking when a DSN is configured; otherwise everything here is a no-op. */
export function initSentry(env: Env, service: 'api' | 'worker'): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    serverName: service,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.05 : 0,
    initialScope: { tags: { service } },
    beforeSend(event) {
      // Members are identified by an opaque id only; request bodies, cookies and headers never leave.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
        delete event.request.query_string;
      }
      delete event.user;
      if (event.extra) event.extra = scrub(event.extra);
      if (event.contexts) event.contexts = scrub(event.contexts);
      return event;
    },
    beforeBreadcrumb: (b) => (b.data ? { ...b, data: scrub(b.data) } : b),
  });
  enabled = true;
  return true;
}

export function captureError(err: unknown, context: { requestId?: string; path?: string; job?: string } = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context.requestId) scope.setTag('requestId', String(context.requestId));
    if (context.path) scope.setTag('path', context.path);
    if (context.job) scope.setTag('job', context.job);
    Sentry.captureException(err);
  });
}

export const flushSentry = (ms = 2000) => (enabled ? Sentry.flush(ms) : Promise.resolve(true));
