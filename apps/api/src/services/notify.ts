import { renderNotice, type NoticeProps } from '@marchmaker/email';
import type { AppContext } from '../context';
import { templateReady } from './whatsapp';

/**
 * Sends a transactional email. Delivery problems are logged and never thrown, so a
 * mail outage cannot break sign-up or recovery flows (Phase 11 moves this behind the outbox).
 */
export async function sendNotice(
  ctx: AppContext,
  to: string,
  notice: NoticeProps & { subject: string },
): Promise<void> {
  try {
    const rendered = await renderNotice(notice);
    await ctx.mailer.send({ to, ...rendered });
  } catch (err) {
    ctx.log.error({ err }, 'email delivery failed');
  }
}

export async function sendOtp(ctx: AppContext, target: string, code: string): Promise<void> {
  if (target.includes('@')) {
    await sendNotice(ctx, target, {
      subject: 'Your Marchmaker verification code',
      preview: `Your code is ${code}`,
      heading: 'Your verification code',
      paragraphs: [`Use this code to continue: ${code}`, 'It expires in 5 minutes. Never share it with anyone.'],
    });
  } else {
    const channel = ctx.env.OTP_CHANNEL;
    const viaSms = async () => ctx.sms.send(target, `${code} is your Marchmaker code. It expires in 5 minutes. Do not share it.`, { otp: code });
    const viaWhatsApp = async () => {
      if (!ctx.whatsapp || !(await templateReady(ctx, 'mm_otp'))) throw new Error('whatsapp otp not available');
      await ctx.whatsapp.sendTemplate(target, 'mm_otp', [code]);
    };
    try {
      if (channel === 'whatsapp') await viaWhatsApp();
      else await viaSms();
    } catch (err) {
      ctx.log.error({ err }, `${channel === 'whatsapp' ? 'whatsapp' : 'sms'} otp delivery failed`);
      // The code is the member's way in, so when allowed a second channel is tried before giving up.
      if (channel === 'sms_then_whatsapp') {
        try {
          await viaWhatsApp();
        } catch (err2) {
          ctx.log.error({ err: err2 }, 'whatsapp otp fallback failed');
        }
      }
    }
  }
}
