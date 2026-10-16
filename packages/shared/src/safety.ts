import { z } from 'zod';
import { REPORT_CATEGORIES, type Severity } from './enums';

// ------------------------------------------------------------------ moderation

export const MODERATION_ACTIONS = ['dismiss', 'warn', 'suspend', 'ban', 'escalate'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Hours within which a report of this severity should be picked up. */
export const REPORT_SLA_HOURS: Record<Severity, number> = { critical: 1, high: 4, medium: 24, low: 72 };

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const reportDueAt = (severity: Severity, from: Date) =>
  new Date(from.getTime() + REPORT_SLA_HOURS[severity] * 3_600_000);

export const caseActionSchema = z
  .object({
    action: z.enum(MODERATION_ACTIONS),
    /** Recorded internally. Never shown to the reported member verbatim. */
    reason: z.string().trim().min(10, 'Please explain the decision').max(1000),
    /** Shown to the member for a warning: kind, specific, no reporter details. */
    memberMessage: z.string().trim().min(10).max(600).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'warn' && !v.memberMessage) {
      ctx.addIssue({ code: 'custom', path: ['memberMessage'], message: 'Write what the member will be told' });
    }
  });
export type CaseActionInput = z.infer<typeof caseActionSchema>;

// ------------------------------------------------------------------ support

export const TICKET_CATEGORIES = ['account', 'billing', 'technical', 'matching', 'safety', 'feedback', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** open = new, awaiting_member = we replied, awaiting_team = the member replied, then resolved and closed. */
export const TICKET_STATUSES = ['open', 'awaiting_member', 'awaiting_team', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['normal', 'high'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** First-response targets in hours. */
export const TICKET_SLA_HOURS: Record<TicketPriority, number> = { high: 4, normal: 24 };

export const ticketDueAt = (priority: TicketPriority, from: Date) =>
  new Date(from.getTime() + TICKET_SLA_HOURS[priority] * 3_600_000);

/** Billing and safety problems start as high priority. */
export const defaultPriority = (category: TicketCategory): TicketPriority =>
  category === 'billing' || category === 'safety' ? 'high' : 'normal';

const attachmentKeys = z.array(z.string().regex(/^attachments\/(ticket|report)\/[a-f\d]{24}\/[\w-]{8,64}\.(png|jpg|webp|pdf)$/)).max(3).default([]);

export const ticketCreateSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().trim().min(5, 'Add a short subject').max(120),
  body: z.string().trim().min(10, 'Please tell us a little more').max(4000),
  attachments: attachmentKeys,
});

export const ticketReplySchema = z.object({ body: z.string().trim().min(1).max(4000), attachments: attachmentKeys });

export const ticketRatingSchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() });

export const ATTACHMENT_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' } as const;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const attachmentPresignSchema = z.object({
  scope: z.enum(['ticket', 'report']),
  contentType: z.enum(Object.keys(ATTACHMENT_TYPES) as [keyof typeof ATTACHMENT_TYPES, ...(keyof typeof ATTACHMENT_TYPES)[]]),
  size: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
  name: z.string().trim().max(120).default('attachment'),
});

export const ticketEscalateSchema = z.object({
  category: z.enum(REPORT_CATEGORIES),
  reportedUserId: z.string().regex(/^[a-f\d]{24}$/i),
  note: z.string().trim().min(5).max(1000),
});

/** India helplines shown in the safety centre. */
export const SAFETY_HELPLINES = [
  { number: '112', name: 'Emergency response', note: 'Police, fire and ambulance across India' },
  { number: '1091', name: 'Women helpline', note: 'Help for women in distress, 24 hours' },
  { number: '181', name: 'Women helpline (domestic abuse)', note: 'Counselling and referrals' },
  { number: '1930', name: 'Cyber crime helpline', note: 'Report online fraud and financial scams quickly' },
  { number: '1098', name: 'Childline', note: 'For anyone under 18 who needs help' },
  { number: '14416', name: 'Tele-MANAS', note: 'Free mental-health support in many languages' },
] as const;

export const ticketUpdateSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    assigneeId: z.string().regex(/^[a-f\d]{24}$/i).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const cannedReplySchema = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(10).max(2000),
});

// ------------------------------------------------------------------ appeals

export const APPEAL_STATUSES = ['pending', 'upheld', 'overturned'] as const;

/** Public: a suspended member cannot sign in, so an appeal is made with the email on the account. */
export const appealSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  message: z.string().trim().min(30, 'Please tell us a little more (at least a couple of sentences)').max(3000),
  /** Honeypot. */
  website: z.string().max(100).optional(),
});

export const appealDecisionSchema = z.object({
  decision: z.enum(['upheld', 'overturned']),
  note: z.string().trim().min(10).max(1000),
  /** Sent to the member by email. */
  memberMessage: z.string().trim().min(10).max(1000),
});
