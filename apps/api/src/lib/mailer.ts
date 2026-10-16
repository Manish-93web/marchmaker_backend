import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  /** The provider's message id, used to match delivery events back to the notification. */
  id?: string;
  /** True when the address is on the suppression list and nothing was sent. */
  suppressed?: boolean;
}

export interface Mailer {
  send(msg: MailMessage): Promise<SendResult | void>;
}

/** Keeps messages in memory: used in tests and when EMAIL_PROVIDER=mock. */
export class MemoryMailer implements Mailer {
  readonly sent: (MailMessage & { id: string })[] = [];
  constructor(private readonly log?: Logger) {}
  async send(msg: MailMessage): Promise<SendResult> {
    const id = `mem_${this.sent.length + 1}`;
    this.sent.push({ ...msg, id });
    this.log?.info({ subject: msg.subject }, 'mock email captured');
    return { id };
  }
  last(to?: string) {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(private readonly env: Env) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: false,
      connectionTimeout: 8_000,
      socketTimeout: 10_000,
    });
  }
  async send(msg: MailMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({ from: this.env.EMAIL_FROM, ...msg });
    return { id: info.messageId };
  }
}

/** Resend's HTTP API. Delivery, bounce and complaint events come back through /webhooks/resend. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(msg: MailMessage): Promise<SendResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`email provider returned ${res.status}`);
    const json = (await res.json()) as { id?: string };
    return { id: json.id };
  }
}

/**
 * Refuses to mail addresses that have hard-bounced (nothing can reach them and sending hurts our
 * reputation) or complained (they asked us to stop, so only security and payment messages go).
 * Security and payment messages carry no List-Unsubscribe header, which is how they are told apart.
 * If the lookup itself fails, the message is sent: a database hiccup must not stop a password reset.
 */
export class SuppressingMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly lookup: (email: string) => Promise<'hard_bounce' | 'complaint' | 'unsubscribed' | null>,
    private readonly log?: Logger,
  ) {}
  async send(msg: MailMessage): Promise<SendResult | void> {
    let reason: Awaited<ReturnType<typeof this.lookup>> = null;
    try {
      reason = await this.lookup(msg.to);
    } catch {
      reason = null;
    }
    const optional = Boolean(msg.headers?.['List-Unsubscribe']);
    if (reason === 'hard_bounce' || (reason && optional)) {
      this.log?.info({ reason }, 'email suppressed');
      return { suppressed: true };
    }
    return this.inner.send(msg);
  }
}

export function createMailer(env: Env, log: Logger): Mailer {
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY) return new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);
  return env.EMAIL_PROVIDER === 'smtp' ? new SmtpMailer(env) : new MemoryMailer(log);
}
