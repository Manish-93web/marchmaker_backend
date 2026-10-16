import { describe, expect, it } from 'vitest';
import {
  REPORT_SEVERITY,
  REPORT_CATEGORIES,
  containsContactInfo,
  containsProfanity,
  firstNoteProblems,
  messageProblems,
} from '../src';

describe('contact information filter', () => {
  it.each([
    'call me on 9876543210',
    'my number is 98765 43210',
    'reach me at +91 98765-43210',
    'nine eight seven six five four three two one zero',
    'visit www.example.com',
    'https://instagram.com/asha',
    'write to asha@example.com',
    'asha at example dot com',
    'my whatsapp is 98765',
    'find me on insta @asha.k',
    'asha.rao.in',
  ])('catches: %s', (t) => {
    expect(containsContactInfo(t)).toBe(true);
  });

  it.each([
    'I am 29 years old and I have lived in Pune for 8 years.',
    'I love hiking and cooking for friends. Weekends are for family.',
    'I work at a company in Bengaluru and I travel twice a year.',
    'We could talk about books, or maybe our favourite place in the hills.',
  ])('allows normal sentences: %s', (t) => {
    expect(containsContactInfo(t)).toBe(false);
  });
});

describe('first note and message rules', () => {
  const good = 'Hello! I enjoyed reading about your love for the hills. I would like to know what a perfect weekend looks like for you.';

  it('enforces 50 to 500 characters and cleanliness', () => {
    expect(firstNoteProblems(good)).toEqual([]);
    expect(firstNoteProblems('Hi there').join(' ')).toMatch(/at least 50/);
    expect(firstNoteProblems('x'.repeat(501)).join(' ')).toMatch(/under 500/);
    expect(firstNoteProblems(`${good} Call me on 9876543210`).join(' ')).toMatch(/phone numbers/);
    expect(firstNoteProblems(`${good} you are a bitch`).join(' ')).toMatch(/respectful/);
  });

  it('keeps chat free of contact details, pointing to the share feature', () => {
    expect(messageProblems('How was your day?')).toEqual([]);
    expect(messageProblems('')[0]).toMatch(/first/);
    expect(messageProblems('text me on 9876543210')[0]).toMatch(/Share my contact/);
  });

  it('detects profanity on whole words only', () => {
    expect(containsProfanity('What a lovely class assignment')).toBe(false);
    expect(containsProfanity('you are a bastard')).toBe(true);
  });
});

describe('report severity', () => {
  it('covers every category and treats safety and underage as critical', () => {
    for (const c of REPORT_CATEGORIES) expect(REPORT_SEVERITY[c]).toBeTruthy();
    expect(REPORT_SEVERITY.safety_threat).toBe('critical');
    expect(REPORT_SEVERITY.underage).toBe('critical');
    expect(REPORT_SEVERITY.other).toBe('low');
  });
});
