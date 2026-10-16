import { describe, expect, it } from 'vitest';
import { renderVerifyEmail } from './index';

describe('email templates', () => {
  it('renders html and a plain-text alternative with the link', async () => {
    const out = await renderVerifyEmail({ firstName: 'Asha', verifyUrl: 'https://app.example/verify?t=abc' });
    expect(out.html).toContain('https://app.example/verify?t=abc');
    expect(out.html).toContain('color-scheme');
    expect(out.text.toLowerCase()).toContain('welcome, asha');
    expect(out.text).not.toContain('<');
  });
});
