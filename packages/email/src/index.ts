import { render } from '@react-email/render';
import { createElement } from 'react';
import { VerifyEmail, type VerifyEmailProps } from './templates/VerifyEmail';
import { Notice, type NoticeProps } from './templates/Notice';

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
