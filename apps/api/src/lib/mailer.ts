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

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Keeps messages in memory: used in tests and when EMAIL_PROVIDER=mock. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  constructor(private readonly log?: Logger) {}
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    this.log?.info({ subject: msg.subject }, 'mock email captured');
  }
  last(to?: string): MailMessage | undefined {
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
  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.env.EMAIL_FROM, ...msg });
  }
}

export function createMailer(env: Env, log: Logger): Mailer {
  return env.EMAIL_PROVIDER === 'smtp' ? new SmtpMailer(env) : new MemoryMailer(log);
}
