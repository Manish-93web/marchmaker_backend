import { z } from 'zod';

// ------------------------------------------------------------------ guides

export const guideInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words separated by dashes').max(80),
  title: z.string().trim().min(3).max(140),
  summary: z.string().trim().max(300).default(''),
  category: z.string().trim().max(40).optional(),
  bodyMarkdown: z.string().max(40_000).default(''),
  access: z.enum(['free', 'premium']).default('free'),
  published: z.boolean().default(false),
});
export type GuideInput = z.infer<typeof guideInputSchema>;

export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'] as const;
export const AUDIO_MAX_BYTES = 40 * 1024 * 1024;

export const guideAudioRequestSchema = z.object({
  contentType: z.enum(AUDIO_TYPES),
  sizeBytes: z.number().int().min(1_000).max(AUDIO_MAX_BYTES),
  seconds: z.number().int().min(5).max(7_200),
});

const PREMIUM_PLANS = ['premium', 'concierge'];

/** Free guides are for everyone; premium ones need a premium plan. */
export const guideAllowed = (access: 'free' | 'premium', planCode: string) => access === 'free' || PREMIUM_PLANS.includes(planCode);

// ------------------------------------------------------------------ safe markdown

export type Inline = { t: 'text' | 'strong' | 'em'; text: string } | { t: 'link'; text: string; href: string };
export type Block = { type: 'h2' | 'h3' | 'p'; inlines: Inline[] } | { type: 'ul' | 'ol'; items: Inline[][] };

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/))/i;

function inlines(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: 'text', text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'strong', text: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'em', text: m[2] });
    else if (m[3] !== undefined && m[4] !== undefined) {
      // A link with an unsafe scheme (javascript:, data:) is shown as plain text.
      if (SAFE_HREF.test(m[4])) out.push({ t: 'link', text: m[3], href: m[4] });
      else out.push({ t: 'text', text: m[3] });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', text: src.slice(last) });
  return out;
}

/**
 * A deliberately small markdown subset (headings, paragraphs, lists, bold, italic, links) parsed to
 * data. The page renders it as React elements, so raw HTML in a guide can never run.
 */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: Inline[][] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', inlines: inlines(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ type: h[1]!.length === 1 ? 'h2' : h[1]!.length === 2 ? 'h2' : 'h3', inlines: inlines(h[2]!) });
      continue;
    }
    const li = /^([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const type = /^\d/.test(li[1]!) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push(inlines(li[2]!));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

// ------------------------------------------------------------------ voice calls

/** Calls are placed between 9:00 and 21:00 India time. */
export const CALL_WINDOW = { startHour: 9, endHour: 21 } as const;
export const CALL_DAILY_LIMIT = 3;

export function callWindowOpen(now: Date): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const h = ist.getUTCHours();
  return h >= CALL_WINDOW.startHour && h < CALL_WINDOW.endHour;
}

export const callOptInSchema = z.object({ open: z.boolean() });

export const RTC_SIGNAL_KINDS = ['offer', 'answer', 'candidate', 'accept', 'decline', 'end'] as const;
export type RtcSignalKind = (typeof RTC_SIGNAL_KINDS)[number];

/** Session descriptions and ICE candidates are small; anything bigger is refused. */
export const rtcSignalSchema = z.object({
  callId: z.string().regex(/^[a-f\d]{24}$/i),
  kind: z.enum(RTC_SIGNAL_KINDS),
  payload: z.record(z.string().max(40), z.unknown()).optional(),
});
export const RTC_MAX_PAYLOAD_BYTES = 8 * 1024;

// ------------------------------------------------------------------ astrology

export const birthDetailsSchema = z.object({
  /** 24 hour local time of birth. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24 hour time, for example 06:45'),
  place: z.string().trim().min(2).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type BirthDetails = z.infer<typeof birthDetailsSchema>;

export const ASTROLOGY_DISCLAIMER =
  'Astrology is offered as cultural reference only. It is never used to choose, rank or filter introductions.';
