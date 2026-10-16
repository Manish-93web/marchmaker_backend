import { z } from 'zod';
import { ID_DOC_TYPES } from './enums';

export const EVIDENCE_KINDS = ['id_front', 'id_back', 'selfie'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

export const evidenceUploadSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  contentType: z.enum(EVIDENCE_CONTENT_TYPES),
  sizeBytes: z.number().int().min(2048).max(EVIDENCE_MAX_BYTES),
});

export const verificationSubmitSchema = z.object({
  docType: z.enum(ID_DOC_TYPES),
  /** Last four visible characters only. The full number is never collected. */
  docLast4: z.string().trim().regex(/^[A-Za-z0-9]{4}$/, 'Enter the last 4 characters shown on the document'),
});

export const DECISION_CHECKLIST = ['nameMatches', 'dobMatches', 'photoMatches', 'notExpired', 'notTampered'] as const;
export type ChecklistKey = (typeof DECISION_CHECKLIST)[number];

export const REJECTION_REASONS = [
  'unreadable',
  'name_mismatch',
  'dob_mismatch',
  'photo_mismatch',
  'expired',
  'suspected_tampering',
  'unsupported_document',
  'unmasked_aadhaar',
  'other',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const decisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approve'),
    checklist: z.object(Object.fromEntries(DECISION_CHECKLIST.map((k) => [k, z.boolean()])) as Record<ChecklistKey, z.ZodBoolean>),
  }),
  z.object({
    decision: z.literal('reject'),
    reason: z.enum(REJECTION_REASONS),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    decision: z.literal('request_reupload'),
    kinds: z.array(z.enum(EVIDENCE_KINDS)).min(1),
    note: z.string().trim().max(500).optional(),
  }),
]);
export type VerificationDecision = z.infer<typeof decisionSchema>;

/** Plain-language text shown to members for each rejection reason (never blames the member). */
export const REJECTION_COPY: Record<RejectionReason, string> = {
  unreadable: 'We could not read the document clearly. A sharper, well-lit photo will help.',
  name_mismatch: 'The name on the document did not match your profile.',
  dob_mismatch: 'The date of birth on the document did not match your profile.',
  photo_mismatch: 'We could not match the selfie to the photo on the document.',
  expired: 'The document appears to have expired. Please use a valid one.',
  suspected_tampering: 'We were unable to verify this document. Please contact support if you think this is a mistake.',
  unsupported_document: 'That type of document is not accepted. Please choose one from the list.',
  unmasked_aadhaar: 'For your safety, please upload a masked Aadhaar showing only the last 4 digits.',
  other: 'We could not complete your verification. Please try again or contact support.',
};

// ---------------------------------------------------------------- automated KYC

export interface KycResult {
  /** Provider's own state for the session. */
  status: 'pending' | 'completed' | 'failed';
  confidence: number; // 0..1
  nameMatch: boolean;
  dobMatch: boolean;
  faceMatch: boolean;
  livenessPassed: boolean;
  docType?: (typeof ID_DOC_TYPES)[number];
  docLast4?: string;
}

export type KycOutcome =
  | { action: 'approve' }
  | { action: 'wait' }
  | { action: 'manual_review'; reason: 'low_confidence' | 'mismatch' | 'liveness_failed' | 'provider_failed' };

export const KYC_AUTO_APPROVE_CONFIDENCE = 0.9;

/**
 * Automation may approve; it never rejects. Anything uncertain goes to a person.
 */
export function evaluateKycResult(r: KycResult, threshold = KYC_AUTO_APPROVE_CONFIDENCE): KycOutcome {
  if (r.status === 'pending') return { action: 'wait' };
  if (r.status === 'failed') return { action: 'manual_review', reason: 'provider_failed' };
  if (!r.livenessPassed) return { action: 'manual_review', reason: 'liveness_failed' };
  if (!r.nameMatch || !r.dobMatch || !r.faceMatch) return { action: 'manual_review', reason: 'mismatch' };
  if (r.confidence < threshold) return { action: 'manual_review', reason: 'low_confidence' };
  return { action: 'approve' };
}

export const VERIFICATION_BADGES = ['id', 'selfie', 'phone', 'email'] as const;
export type VerificationBadge = (typeof VERIFICATION_BADGES)[number];
