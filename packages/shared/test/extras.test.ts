import { describe, expect, it } from 'vitest';
import { birthDetailsSchema, callWindowOpen, guideAllowed, guideAudioRequestSchema, guideInputSchema, parseMarkdown } from '../src/extras';

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, lists and inline styles into data', () => {
    const blocks = parseMarkdown('# Title\n\nHello **world** and *you*.\nSecond line.\n\n- one\n- two\n\n1. first\n2. second\n\n### Small');
    expect(blocks.map((b) => b.type)).toEqual(['h2', 'p', 'ul', 'ol', 'h3']);
    const p = blocks[1];
    expect(p && 'inlines' in p && p.inlines.map((i) => i.t)).toEqual(['text', 'strong', 'text', 'em', 'text']);
    const ul = blocks[2];
    expect(ul && 'items' in ul && ul.items).toHaveLength(2);
  });

  it('never produces a script-capable link or HTML', () => {
    const blocks = parseMarkdown('[bad](javascript:alert(1)) and [ok](https://example.com) and <script>alert(1)</script> [rel](/pricing) [proto](//evil.com)');
    const p = blocks[0];
    const inl = p && 'inlines' in p ? p.inlines : [];
    const links = inl.filter((i) => i.t === 'link');
    expect(links.map((l) => 'href' in l && l.href)).toEqual(['https://example.com', '/pricing']);
    // The script tag stays inert text for React to escape.
    expect(inl.some((i) => i.t === 'text' && i.text.includes('<script>'))).toBe(true);
  });

  it('copes with empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

describe('guides', () => {
  it('gates premium guides on plan', () => {
    expect(guideAllowed('free', 'free')).toBe(true);
    expect(guideAllowed('premium', 'free')).toBe(false);
    expect(guideAllowed('premium', 'essential')).toBe(false);
    expect(guideAllowed('premium', 'premium')).toBe(true);
    expect(guideAllowed('premium', 'concierge')).toBe(true);
  });
  it('validates slugs and audio uploads', () => {
    expect(guideInputSchema.safeParse({ slug: 'first-call-tips', title: 'First call tips' }).success).toBe(true);
    expect(guideInputSchema.safeParse({ slug: 'Bad Slug', title: 'First call tips' }).success).toBe(false);
    expect(guideAudioRequestSchema.safeParse({ contentType: 'audio/mpeg', sizeBytes: 3_000_000, seconds: 240 }).success).toBe(true);
    expect(guideAudioRequestSchema.safeParse({ contentType: 'video/mp4', sizeBytes: 3_000_000, seconds: 240 }).success).toBe(false);
    expect(guideAudioRequestSchema.safeParse({ contentType: 'audio/mpeg', sizeBytes: 90_000_000, seconds: 240 }).success).toBe(false);
  });
});

describe('call window', () => {
  it('is 9:00 to 21:00 India time', () => {
    expect(callWindowOpen(new Date('2026-03-10T03:29:00Z'))).toBe(false); // 08:59 IST
    expect(callWindowOpen(new Date('2026-03-10T03:30:00Z'))).toBe(true); // 09:00 IST
    expect(callWindowOpen(new Date('2026-03-10T15:29:00Z'))).toBe(true); // 20:59 IST
    expect(callWindowOpen(new Date('2026-03-10T15:30:00Z'))).toBe(false); // 21:00 IST
  });
});

describe('birth details', () => {
  it('wants a 24 hour time and a real place', () => {
    const ok = { time: '06:45', place: 'Pune', latitude: 18.52, longitude: 73.85 };
    expect(birthDetailsSchema.safeParse(ok).success).toBe(true);
    expect(birthDetailsSchema.safeParse({ ...ok, time: '6:45pm' }).success).toBe(false);
    expect(birthDetailsSchema.safeParse({ ...ok, latitude: 123 }).success).toBe(false);
  });
});
