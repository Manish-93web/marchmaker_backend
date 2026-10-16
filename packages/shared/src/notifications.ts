import type { NotificationChannel } from './enums';
import { notificationCategories } from './schemas/auth';

export type NotificationCategory = (typeof notificationCategories)[number];

export interface NotificationCopy {
  title: string;
  body: string;
  /** In-app path (also the email call to action). */
  url: string;
}

export interface NotificationSpec {
  category: NotificationCategory;
  /** Payment, safety and account-access messages ignore quiet hours and cannot be fully switched off. */
  critical?: boolean;
  /** Restrict to these channels (e.g. an invoice already has its own email). */
  only?: NotificationChannel[];
  /** Messages in the same group collapse into one unread notification with a count. */
  groupBy?: (p: Record<string, unknown>) => string | undefined;
  /** Stable id for de-duplicating at-least-once delivery; the outbox event id is used when undefined. */
  sourceId: (p: Record<string, unknown>) => string | undefined;
  copy: (p: Record<string, unknown>) => NotificationCopy;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/**
 * What each domain event tells a member. Copy is deliberately neutral: it never contains a
 * name, a message, a score, or whether the other person said yes (D-039).
 */
export const NOTIFICATION_SPECS: Record<string, NotificationSpec> = {
  'introduction.released': {
    category: 'introductions',
    sourceId: (p) => s(p.introductionId),
    copy: (p) => ({
      title: 'A new introduction is waiting for you',
      body: 'Our team thinks you two may click. Read why, and take your time.',
      url: `/introductions/${s(p.introductionId)}`,
    }),
  },
  'introduction.reminder': {
    category: 'introductions',
    sourceId: (p) => `${s(p.introductionId)}:${s(p.hoursLeft)}`,
    copy: (p) => ({
      title: 'An introduction is waiting for your answer',
      body: `It closes in about ${s(p.hoursLeft)} hours. A kind no is always fine.`,
      url: `/introductions/${s(p.introductionId)}`,
    }),
  },
  'introduction.unlocked': {
    category: 'introductions',
    sourceId: (p) => `${s(p.introductionId)}:${s(p.userId)}`,
    copy: (p) => ({
      title: 'You both said yes',
      body: 'You can now message each other, and their first note is waiting for you. Start with something kind.',
      url: `/introductions/${s(p.introductionId)}`,
    }),
  },
  'introduction.declined': {
    category: 'introductions',
    sourceId: (p) => `${s(p.introductionId)}:${s(p.userId)}`,
    copy: (p) => ({
      title: 'An introduction has ended',
      body: "This one didn't move forward. We will keep looking for you.",
      url: `/introductions/${s(p.introductionId)}`,
    }),
  },
  'introduction.expired': {
    category: 'introductions',
    sourceId: (p) => `${s(p.introductionId)}:${s(p.userId)}`,
    copy: (p) => ({
      title: 'An introduction has closed',
      body: 'It reached its time limit. Credits you held have been returned.',
      url: `/introductions/${s(p.introductionId)}`,
    }),
  },
  'introduction.contact_shared': {
    category: 'introductions',
    sourceId: (p) => `${s(p.introductionId)}:${s(p.userId)}`,
    copy: (p) => ({
      title: 'Contact details have been shared',
      body: 'You both chose to share them. You can see them in the introduction.',
      url: `/introductions/${s(p.introductionId)}`,
    }),
  },
  'message.created': {
    category: 'messages',
    groupBy: (p) => `thread:${s(p.threadId)}`,
    sourceId: (p) => s(p.messageId),
    copy: (p) => ({
      title: 'You have a new message',
      body: 'Open Marchmaker to read it.',
      url: `/messages/${s(p.threadId)}`,
    }),
  },
  'message.digest': {
    category: 'messages',
    only: ['email'],
    sourceId: (p) => `digest:${s(p.userId)}:${s(p.day)}`,
    copy: (p) => ({
      title: 'You have messages waiting',
      body: `${s(p.count)} unread message${Number(p.count) === 1 ? '' : 's'} are waiting for you. Replying only takes a moment.`,
      url: '/messages',
    }),
  },
  'verification.approved': {
    category: 'verification',
    sourceId: (p) => s(p.verificationId),
    copy: () => ({ title: 'You are verified', body: 'Thank you. Your verified badge is now on your profile.', url: '/verification' }),
  },
  'verification.rejected': {
    category: 'verification',
    critical: true,
    sourceId: (p) => s(p.verificationId),
    copy: () => ({
      title: 'An update on your verification',
      body: 'We could not complete it this time. Open the app to see what to do next.',
      url: '/verification',
    }),
  },
  'verification.reupload_requested': {
    category: 'verification',
    sourceId: (p) => s(p.verificationId),
    copy: () => ({
      title: 'We need a clearer upload',
      body: 'One of your documents or photos needs to be sent again. It only takes a minute.',
      url: '/verification',
    }),
  },
  'profile.approved': {
    category: 'verification',
    sourceId: () => undefined,
    copy: () => ({ title: 'Your profile is approved', body: 'You are ready for the next step of your journey.', url: '/dashboard' }),
  },
  'profile.changes_requested': {
    category: 'verification',
    sourceId: () => undefined,
    copy: () => ({
      title: 'A few changes are needed on your profile',
      body: 'Our team left a note on what to update. Once done, send it back for review.',
      url: '/onboarding',
    }),
  },
  'billing.payment_failed': {
    category: 'billing',
    critical: true,
    sourceId: (p) => `${s(p.userId)}:${s(p.planCode)}:${new Date().toISOString().slice(0, 10)}`,
    copy: (p) => ({
      title: 'We could not take your payment',
      body: `Your plan stays active for ${s(p.graceDays) || '3'} more days. Please update your payment method.`,
      url: '/billing',
    }),
  },
  'subscription.lapsed': {
    category: 'billing',
    critical: true,
    sourceId: (p) => `${s(p.userId)}:${s(p.planCode)}:lapsed`,
    copy: () => ({
      title: 'Your plan has ended',
      body: 'You are back on the free plan. Your profile and introductions are safe.',
      url: '/billing',
    }),
  },
  'order.paid': {
    category: 'billing',
    only: ['in_app'],
    sourceId: (p) => s(p.orderId),
    copy: (p) => ({
      title: 'Credits added',
      body: `${s(p.credits)} introduction credit${Number(p.credits) === 1 ? '' : 's'} added to your account.`,
      url: '/billing',
    }),
  },
  'payment.refunded': {
    category: 'billing',
    sourceId: (p) => `${s(p.userId)}:${s(p.refundId)}`,
    copy: () => ({
      title: 'Your refund is on its way',
      body: 'It usually reaches your account in 5 to 7 working days.',
      url: '/billing',
    }),
  },
  'moderation.warning': {
    category: 'safety',
    critical: true,
    sourceId: (p) => s(p.actionId),
    copy: () => ({
      title: 'A message from our safety team',
      body: 'We have sent you a note about how you are using Marchmaker. Please read it.',
      url: '/support',
    }),
  },
  'report.resolved': {
    category: 'safety',
    sourceId: (p) => s(p.reportId),
    copy: () => ({
      title: 'Thank you for your report',
      body: 'We have reviewed it and taken the steps we think are right. For privacy we cannot share details.',
      url: '/support',
    }),
  },
  'support.replied': {
    category: 'messages',
    groupBy: (p) => `ticket:${s(p.ticketId)}`,
    sourceId: (p) => s(p.messageId),
    copy: (p) => ({
      title: 'Our team has replied to you',
      body: `Ticket ${s(p.number)} has a new reply.`,
      url: `/support/${s(p.ticketId)}`,
    }),
  },
  'referral.rewarded': {
    category: 'billing',
    only: ['in_app', 'email'],
    sourceId: (p) => `${s(p.referralId)}:${s(p.userId)}`,
    copy: (p) => ({
      title: 'A reward is in your wallet',
      body: `${s(p.amountLabel)} has been added. You can use it on your next introduction pack.`,
      url: '/referrals',
    }),
  },
  'feedback.checkin': {
    category: 'introductions',
    only: ['in_app', 'email'],
    sourceId: (p) => `${s(p.introductionId)}:${s(p.userId)}`,
    copy: (p) => ({
      title: 'How is it going?',
      body: 'It has been a week since you both said yes. A quick note helps us find better introductions for you.',
      url: `/introductions/${s(p.introductionId)}?feedback=1`,
    }),
  },
  'feedback.meeting': {
    category: 'introductions',
    only: ['in_app', 'email'],
    sourceId: (p) => `${s(p.introductionId)}:${s(p.userId)}:meeting`,
    copy: (p) => ({
      title: 'Did you get to meet?',
      body: 'Three weeks on, we would love to know whether the two of you met. It takes ten seconds and stays private.',
      url: `/introductions/${s(p.introductionId)}?feedback=meeting`,
    }),
  },
  'user.email_verified': {
    category: 'verification',
    only: ['in_app', 'email'],
    sourceId: (p) => s(p.userId),
    copy: () => ({
      title: 'Welcome to Marchmaker',
      body: 'Your email is confirmed. Build your profile at your own pace: everything saves automatically.',
      url: '/onboarding',
    }),
  },
  'subscription.renewed': {
    category: 'billing',
    sourceId: (p) => s(p.paymentId),
    copy: (p) => ({
      title: 'Your subscription renewed',
      body: `Your ${s(p.planCode)} plan has renewed and this cycle's credits are in your account. Your invoice is on its way.`,
      url: '/billing',
    }),
  },
  'subscription.cancel_scheduled': {
    category: 'billing',
    sourceId: (p) => `${s(p.userId)}:${s(p.endsAt)}`,
    copy: (p) => ({
      title: 'Your subscription will end',
      body: `You cancelled, so your plan ends on ${s(p.endsLabel)}. You keep everything until then, and you can change your mind from Billing.`,
      url: '/billing',
    }),
  },
  'subscription.expiring': {
    category: 'billing',
    sourceId: (p) => `${s(p.userId)}:${s(p.endsAt)}`,
    copy: (p) => ({
      title: 'Your plan ends soon',
      body: `Your plan ends on ${s(p.endsLabel)}. Credits you have not used stay until they expire.`,
      url: '/billing',
    }),
  },
  'legal.updated': {
    category: 'safety',
    critical: true,
    sourceId: (p) => `${s(p.docType)}:${s(p.version)}`,
    copy: (p) => ({
      title: 'We updated our terms',
      body: `We updated our ${s(p.docLabel)}. Please read and accept the new version to keep using Marchmaker.`,
      url: '/dashboard',
    }),
  },
  'report.received': {
    category: 'safety',
    critical: true,
    sourceId: (p) => s(p.reportId),
    copy: () => ({
      title: 'We received your report',
      body: 'Thank you. Our safety team will look into it, and serious concerns are read first. The other person is never told who reported.',
      url: '/support',
    }),
  },
  'account.deletion_scheduled': {
    category: 'safety',
    critical: true,
    sourceId: (p) => `${s(p.userId)}:${s(p.purgeAt)}`,
    copy: (p) => ({
      title: 'Your account is scheduled for deletion',
      body: `Your account and data will be permanently erased on ${s(p.purgeLabel)}. You can restore it any time before then from Settings.`,
      url: '/settings',
    }),
  },
  'story.decided': {
    category: 'product_updates',
    only: ['in_app'],
    sourceId: (p) => s(p.storyId),
    copy: () => ({
      title: 'About your story',
      body: 'Our team has reviewed the story you shared. Open it to see what happens next.',
      url: '/stories',
    }),
  },
  'invoice.created': {
    category: 'billing',
    only: ['in_app'],
    sourceId: (p) => s(p.invoiceId),
    copy: () => ({ title: 'Your invoice is ready', body: 'You can download it from Billing.', url: '/billing' }),
  },
};

// ------------------------------------------------------------------ preferences

export type ChannelPrefs = Record<NotificationChannel, boolean>;
export interface ResolvedPrefs {
  channels: Record<NotificationCategory, ChannelPrefs>;
  quietHours: { enabled: boolean; start: string; end: string };
}

/** Out-of-the-box choices. WhatsApp and marketing stay off until the member opts in. */
export const DEFAULT_CHANNELS: Record<NotificationCategory, ChannelPrefs> = {
  introductions: { in_app: true, email: true, whatsapp: false, push: true },
  messages: { in_app: true, email: false, whatsapp: false, push: true },
  billing: { in_app: true, email: true, whatsapp: false, push: false },
  verification: { in_app: true, email: true, whatsapp: false, push: false },
  safety: { in_app: true, email: true, whatsapp: false, push: true },
  product_updates: { in_app: true, email: false, whatsapp: false, push: false },
};

export const DEFAULT_QUIET_HOURS = { enabled: true, start: '22:00', end: '08:00' };

export function resolvePrefs(raw: unknown): ResolvedPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as {
    channels?: Record<string, Partial<ChannelPrefs>>;
    quietHours?: Partial<ResolvedPrefs['quietHours']>;
  };
  const channels = {} as ResolvedPrefs['channels'];
  for (const c of notificationCategories) channels[c] = { ...DEFAULT_CHANNELS[c], ...(r.channels?.[c] ?? {}) };
  return { channels, quietHours: { ...DEFAULT_QUIET_HOURS, ...(r.quietHours ?? {}) } };
}

// ------------------------------------------------------------------ quiet hours (India Standard Time)

const IST_OFFSET_MIN = 330;
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const istMinutes = (d: Date) => (((d.getUTCHours() * 60 + d.getUTCMinutes() + IST_OFFSET_MIN) % 1440) + 1440) % 1440;

export function inQuietHours(now: Date, q: ResolvedPrefs['quietHours']): boolean {
  if (!q.enabled) return false;
  const start = toMin(q.start);
  const end = toMin(q.end);
  if (start === end) return false;
  const t = istMinutes(now);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** The first moment after `now` when quiet hours are over. */
export function quietEnd(now: Date, q: ResolvedPrefs['quietHours']): Date {
  const end = toMin(q.end);
  const t = istMinutes(now);
  const wait = ((end - t + 1440) % 1440) || 1440;
  const out = new Date(now.getTime() + wait * 60_000);
  out.setUTCSeconds(0, 0);
  return out;
}

// ------------------------------------------------------------------ channel decision

export interface DecisionInput {
  spec: Pick<NotificationSpec, 'category' | 'critical' | 'only'>;
  prefs: ResolvedPrefs;
  consents: { whatsapp?: boolean; marketing_email?: boolean };
  planCode: string;
  hasEmail: boolean;
  hasVerifiedPhone: boolean;
  hasPush: boolean;
  now: Date;
}

export interface Decision {
  send: NotificationChannel[];
  skipped: Partial<Record<NotificationChannel, string>>;
  /** Present when the external channels should wait for quiet hours to end. */
  deferUntil?: Date;
}

const WHATSAPP_PLANS = ['premium', 'concierge'];

export function decideChannels(i: DecisionInput): Decision {
  const { spec, prefs, now } = i;
  const cat = prefs.channels[spec.category];
  const skipped: Decision['skipped'] = {};
  const send: NotificationChannel[] = [];
  const allowed = (c: NotificationChannel) => !spec.only || spec.only.includes(c);
  // Critical messages reach the member's in-app inbox and email even if they switched those off.
  const want = (c: NotificationChannel) => cat[c] || (spec.critical === true && (c === 'in_app' || c === 'email'));

  for (const c of ['in_app', 'email', 'push', 'whatsapp'] as NotificationChannel[]) {
    if (!allowed(c)) {
      skipped[c] = 'not_used_for_this_message';
      continue;
    }
    if (!want(c)) {
      skipped[c] = 'turned_off';
      continue;
    }
    if (c === 'email') {
      if (!i.hasEmail) {
        skipped[c] = 'no_email';
        continue;
      }
      if (spec.category === 'product_updates' && !i.consents.marketing_email) {
        skipped[c] = 'no_consent';
        continue;
      }
    }
    if (c === 'push' && !i.hasPush) {
      skipped[c] = 'no_device';
      continue;
    }
    if (c === 'whatsapp') {
      if (!i.consents.whatsapp) {
        skipped[c] = 'no_consent';
        continue;
      }
      if (!i.hasVerifiedPhone) {
        skipped[c] = 'no_verified_phone';
        continue;
      }
      if (!WHATSAPP_PLANS.includes(i.planCode)) {
        skipped[c] = 'plan';
        continue;
      }
    }
    send.push(c);
  }

  const external = send.some((c) => c !== 'in_app');
  if (external && !spec.critical && inQuietHours(now, prefs.quietHours)) {
    return { send, skipped, deferUntil: quietEnd(now, prefs.quietHours) };
  }
  return { send, skipped };
}
