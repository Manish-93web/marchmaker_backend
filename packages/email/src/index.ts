import { render } from '@react-email/render';
import { createElement } from 'react';
import { VerifyEmail, type VerifyEmailProps } from './templates/VerifyEmail';
import { Notice, type NoticeProps } from './templates/Notice';
import { DigestEmail, IntroductionEmail, PaymentEmail, SupportEmail, VerificationEmail, type EventEmailProps } from './templates/Events';

export { DigestEmail, IntroductionEmail, PaymentEmail, SupportEmail, VerificationEmail, type EventEmailProps } from './templates/Events';

export { Layout } from './Layout';
export { VerifyEmail, type VerifyEmailProps } from './templates/VerifyEmail';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Every template renders both HTML and a plain-text alternative. */
export async function renderVerifyEmail(props: VerifyEmailProps): Promise<RenderedEmail> {
  const el = createElement(VerifyEmail, props);
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { subject: 'Confirm your email', html, text };
}

export { Notice, type NoticeProps } from './templates/Notice';

export async function renderNotice(props: NoticeProps & { subject: string }): Promise<RenderedEmail> {
  const { subject, ...rest } = props;
  const el = createElement(Notice, rest);
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { subject, html, text };
}

const EVENT_TEMPLATES: [prefix: string, component: (p: EventEmailProps) => ReturnType<typeof IntroductionEmail>][] = [
  ['introduction.', IntroductionEmail],
  ['message.digest', DigestEmail],
  ['verification.', VerificationEmail],
  ['profile.', VerificationEmail],
  ['billing.', PaymentEmail],
  ['subscription.', PaymentEmail],
  ['order.', PaymentEmail],
  ['payment.', PaymentEmail],
  ['invoice.', PaymentEmail],
  ['support.', SupportEmail],
  ['moderation.', SupportEmail],
  ['report.', SupportEmail],
];

/** The named template for an event type, or null when it should use the generic notice. */
export function templateFor(eventType: string) {
  return EVENT_TEMPLATES.find(([prefix]) => eventType.startsWith(prefix))?.[1] ?? null;
}

/** Each event type gets its own layout; anything else falls back to the generic notice. */
export async function renderEventEmail(eventType: string, props: EventEmailProps & { subject?: string }): Promise<RenderedEmail> {
  const Component = templateFor(eventType);
  const subject = props.subject ?? props.title;
  const el = Component ? createElement(Component, props) : createElement(Notice, { preview: props.body, heading: props.title, paragraphs: [props.body], cta: { label: 'Open Marchmaker', url: props.url }, unsubscribeUrl: props.unsubscribeUrl });
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { subject, html, text };
}
