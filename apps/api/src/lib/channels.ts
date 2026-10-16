import webpush from 'web-push';
import type { Logger } from 'pino';
import type { Env } from '../config/env';

// ------------------------------------------------------------------ WhatsApp

export interface WhatsAppSender {
  /** Sends an approved template message. Free-form text is not allowed outside the 24 hour window. */
  sendTemplate(toE164: string, template: string, vars: string[]): Promise<void>;
}

export class MemoryWhatsApp implements WhatsAppSender {
  readonly sent: { to: string; template: string; vars: string[] }[] = [];
  failNext = false;
  constructor(private readonly log?: Logger) {}
  async sendTemplate(to: string, template: string, vars: string[]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('whatsapp unavailable');
    }
    this.sent.push({ to, template, vars });
    this.log?.info({ template }, 'mock whatsapp captured');
  }
}

/** WhatsApp Business Cloud API. Templates must be pre-approved in the Meta dashboard. */
export class MetaWhatsApp implements WhatsAppSender {
  constructor(
    private readonly token: string,
    private readonly phoneId: string,
    private readonly language = 'en',
  ) {}
  async sendTemplate(to: string, template: string, vars: string[]) {
    const res = await fetch(`https://graph.facebook.com/v20.0/${this.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template,
          language: { code: this.language },
          components: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text })) }],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`whatsapp returned ${res.status}`);
  }
}

export function createWhatsApp(env: Env, log: Logger): WhatsAppSender | null {
  if (env.WHATSAPP_PROVIDER === 'mock') return new MemoryWhatsApp(log);
  if (env.WHATSAPP_PROVIDER === 'meta' && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
    return new MetaWhatsApp(env.WHATSAPP_TOKEN, env.WHATSAPP_PHONE_ID);
  }
  return null;
}

// ------------------------------------------------------------------ Web push

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}
export interface PushSender {
  readonly publicKey: string;
  /** `gone` means the browser has unsubscribed and the row should be removed. */
  send(target: PushTarget, payload: PushPayload): Promise<'ok' | 'gone'>;
}

export class MemoryPush implements PushSender {
  readonly publicKey = 'mock-vapid-public-key';
  readonly sent: { endpoint: string; payload: PushPayload }[] = [];
  goneEndpoints = new Set<string>();
  async send(target: PushTarget, payload: PushPayload) {
    if (this.goneEndpoints.has(target.endpoint)) return 'gone' as const;
    this.sent.push({ endpoint: target.endpoint, payload });
    return 'ok' as const;
  }
}

export class WebPushSender implements PushSender {
  constructor(
    readonly publicKey: string,
    privateKey: string,
    subject: string,
  ) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }
  async send(target: PushTarget, payload: PushPayload) {
    try {
      await webpush.sendNotification(target, JSON.stringify(payload), { TTL: 60 * 60 * 12, urgency: 'normal' });
      return 'ok' as const;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone' as const;
      throw err;
    }
  }
}

export function createPush(env: Env): PushSender | null {
  if (env.PUSH_PROVIDER === 'mock') return new MemoryPush();
  if (env.PUSH_PROVIDER === 'webpush' && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return new WebPushSender(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT);
  }
  return null;
}
