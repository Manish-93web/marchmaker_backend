import type { Logger } from 'pino';
import type { Env } from '../config/env';

export interface SmsMeta {
  /** For DLT-registered OTP templates the variable is sent separately from the rendered text. */
  otp?: string;
}

export interface SmsSender {
  send(toE164: string, body: string, meta?: SmsMeta): Promise<void>;
}

export class MemorySms implements SmsSender {
  readonly sent: { to: string; body: string }[] = [];
  constructor(private readonly log?: Logger) {}
  async send(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
    this.log?.info('mock sms captured');
  }
  last(to?: string) {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

/**
 * MSG91 "flow" API. Indian carriers only deliver pre-registered (DLT) templates, so the OTP is sent
 * as a template variable rather than as free text. Verify the payload against your account's template.
 */
export class Msg91Sms implements SmsSender {
  constructor(
    private readonly authKey: string,
    private readonly templateId: string,
  ) {}
  async send(toE164: string, _body: string, meta?: SmsMeta): Promise<void> {
    if (!meta?.otp) throw new Error('msg91 adapter only sends OTP messages');
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: this.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        template_id: this.templateId,
        short_url: '0',
        recipients: [{ mobiles: toE164.replace(/^\+/, ''), otp: meta.otp }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`sms provider returned ${res.status}`);
  }
}

export function createSms(env: Env, log: Logger): SmsSender {
  if (env.SMS_PROVIDER === 'msg91' && env.MSG91_AUTH_KEY && env.MSG91_OTP_TEMPLATE_ID) {
    return new Msg91Sms(env.MSG91_AUTH_KEY, env.MSG91_OTP_TEMPLATE_ID);
  }
  return new MemorySms(log);
}
