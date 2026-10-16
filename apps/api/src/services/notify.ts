import { renderNotice, type NoticeProps } from '@marchmaker/email';
import type { AppContext } from '../context';

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
    try {
      await ctx.sms.send(target, `${code} is your Marchmaker code. It expires in 5 minutes. Do not share it.`, { otp: code });
    } catch (err) {
      ctx.log.error({ err }, 'sms delivery failed');
    }
  }
}
