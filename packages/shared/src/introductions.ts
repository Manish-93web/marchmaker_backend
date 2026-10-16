import { z } from 'zod';
import { DEFAULTS } from './constants';
import { DECLINE_REASONS, REPORT_CATEGORIES, type ReportCategory, type Severity } from './enums';

// ------------------------------------------------------------------ contact-info and language filters

const DIGIT_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine|ek|do|teen|char|paanch|chhe|saat|aath|nau|shunya';

/**
 * Detects phone numbers, links, email addresses and chat handles, including common ways of
 * spelling them out. Used before a mutual unlock, where contact details must not leak.
 */
export function containsContactInfo(text: string): boolean {
  const t = text.toLowerCase();
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|co|net|org|me|io|app)\b)/.test(t)) return true;
  if (/[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\sat\s)\s*[a-z0-9.-]+\s*(\.|\(dot\)|\sdot\s)\s*[a-z]{2,}/.test(t)) return true;
  // Ten digits in a row, with any separators between them.
  const digitsOnly = t.replace(/[^\d]/g, '');
  if (/\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d[\s\-.()]*\d/.test(t)) return true;
  if (digitsOnly.length >= 10 && /\+?91/.test(t)) return true;
  // Digits spelled out as words: "nine eight seven six ...".
  const words = t.match(new RegExp(`\\b(${DIGIT_WORDS})\\b`, 'g')) ?? [];
  if (words.length >= 7) return true;
  if (/\b(whats\s?app|telegram|insta(gram)?|snap(chat)?|signal)\b.{0,20}(\d|@|id|number|no\b)/.test(t)) return true;
  return false;
}

/** A deliberately small list. Human review and reports are the real safeguard. */
const BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'bastard', 'slut', 'whore', 'madarchod', 'bhenchod', 'chutiya', 'randi'];

export function containsProfanity(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, '');
  return BLOCKED_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(t));
}

export function firstNoteProblems(text: string): string[] {
  const t = text.trim();
  const out: string[] = [];
  if (t.length < DEFAULTS.firstNoteMin) out.push(`Please write at least ${DEFAULTS.firstNoteMin} characters so they can get a sense of you.`);
  if (t.length > DEFAULTS.firstNoteMax) out.push(`Please keep it under ${DEFAULTS.firstNoteMax} characters.`);
  if (containsContactInfo(t)) out.push('Please do not include phone numbers, links or email addresses. You can share contact details after you connect.');
  if (containsProfanity(t)) out.push('Please keep your note respectful.');
  return out;
}

export function messageProblems(text: string): string[] {
  const t = text.trim();
  const out: string[] = [];
  if (t.length === 0) out.push('Write a message first.');
  if (t.length > 1000) out.push('Please keep messages under 1000 characters.');
  if (containsContactInfo(t)) out.push('To share a phone number or link, use "Share my contact" so both of you agree.');
  if (containsProfanity(t)) out.push('Please keep your message respectful.');
  return out;
}

// ------------------------------------------------------------------ schemas

export const acceptSchema = z.object({ firstNote: z.string().trim().min(1).max(1200) });

export const declineSchema = z.object({
  reason: z.enum(DECLINE_REASONS).optional(),
  /** Private note to the team. Never shown to the other member. */
  note: z.string().trim().max(500).optional(),
});

export const messageSchema = z.object({ body: z.string().trim().min(1).max(1200) });

export const reportSchema = z
  .object({
    category: z.enum(REPORT_CATEGORIES),
    introductionId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
    userId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
    details: z.string().trim().max(2000).optional(),
    /** Screenshot keys returned by the attachment presign endpoint. */
    evidence: z.array(z.string().regex(/^attachments\/report\/[a-f\d]{24}\/[\w-]{8,64}\.(png|jpg|webp)$/)).max(3).default([]),
  })
  .refine((v) => v.introductionId || v.userId, { message: 'Say who you are reporting' });

export const blockSchema = z
  .object({
    userId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
    introductionId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  })
  .refine((v) => v.userId || v.introductionId, { message: 'Say who you want to block' });

/** Severity is set from the category; moderators can raise it. Critical reports jump the queue. */
export const REPORT_SEVERITY: Record<ReportCategory, Severity> = {
  safety_threat: 'critical',
  underage: 'critical',
  scam_money_request: 'high',
  harassment: 'high',
  married_misrepresentation: 'high',
  fake_profile: 'medium',
  inappropriate_content: 'medium',
  other: 'low',
};

/** The only message a member sees when the other person declines or lets it lapse. */
export const NEUTRAL_ENDING = "This introduction didn't move forward. We'll keep looking.";
