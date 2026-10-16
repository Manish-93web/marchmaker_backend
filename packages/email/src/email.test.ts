import { describe, expect, it } from 'vitest';
import { renderEventEmail, renderVerifyEmail, templateFor } from './index';

describe('email templates', () => {
  it('renders html and a plain-text alternative with the link', async () => {
    const out = await renderVerifyEmail({ firstName: 'Asha', verifyUrl: 'https://app.example/verify?t=abc' });
    expect(out.html).toContain('https://app.example/verify?t=abc');
    expect(out.html).toContain('color-scheme');
    expect(out.text.toLowerCase()).toContain('welcome, asha');
    expect(out.text).not.toContain('<');
  });

  it('gives each kind of event its own layout and a plain-text alternative', async () => {
    const props = { title: 'Hello there', body: 'Something happened.', url: 'https://app.example/x' };
    const intro = await renderEventEmail('introduction.released', props);
    const pay = await renderEventEmail('order.paid', { ...props, detail: 'Rs 499' });
    const digest = await renderEventEmail('message.digest', { ...props, detail: '3 unread' });
    expect(intro.html).toContain('Chosen for you');
    expect(pay.html).toContain('Rs 499');
    expect(digest.html).toContain('3 unread');
    expect(new Set([intro.html, pay.html, digest.html]).size).toBe(3);
    expect(intro.text).not.toContain('<');
    expect(templateFor('story.decided')).toBeNull();
  });
});
