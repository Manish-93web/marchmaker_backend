import { describe, expect, it } from 'vitest';
import { decisionSchema, evaluateKycResult, verificationSubmitSchema, type KycResult } from '../src';

const good: KycResult = {
  status: 'completed',
  confidence: 0.97,
  nameMatch: true,
  dobMatch: true,
  faceMatch: true,
  livenessPassed: true,
};

describe('KYC decision policy', () => {
  it('approves only when every check passes with high confidence', () => {
    expect(evaluateKycResult(good)).toEqual({ action: 'approve' });
  });
  it('waits while the provider is still working', () => {
    expect(evaluateKycResult({ ...good, status: 'pending' })).toEqual({ action: 'wait' });
  });
  it('never rejects automatically: failures and doubts go to a person', () => {
    expect(evaluateKycResult({ ...good, status: 'failed' })).toEqual({ action: 'manual_review', reason: 'provider_failed' });
    expect(evaluateKycResult({ ...good, livenessPassed: false })).toEqual({ action: 'manual_review', reason: 'liveness_failed' });
    expect(evaluateKycResult({ ...good, faceMatch: false })).toEqual({ action: 'manual_review', reason: 'mismatch' });
    expect(evaluateKycResult({ ...good, nameMatch: false })).toEqual({ action: 'manual_review', reason: 'mismatch' });
    expect(evaluateKycResult({ ...good, confidence: 0.6 })).toEqual({ action: 'manual_review', reason: 'low_confidence' });
  });
  it('honours a stricter threshold', () => {
    expect(evaluateKycResult({ ...good, confidence: 0.92 }, 0.95).action).toBe('manual_review');
  });
});

describe('verification schemas', () => {
  it('accepts only the last four characters of a document', () => {
    expect(verificationSubmitSchema.safeParse({ docType: 'aadhaar_masked', docLast4: '1234' }).success).toBe(true);
    expect(verificationSubmitSchema.safeParse({ docType: 'pan', docLast4: 'ABCDE1234F' }).success).toBe(false);
    expect(verificationSubmitSchema.safeParse({ docType: 'aadhaar', docLast4: '1234' }).success).toBe(false);
  });
  it('requires a reason to reject and kinds to request a re-upload', () => {
    expect(decisionSchema.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(decisionSchema.safeParse({ decision: 'reject', reason: 'expired' }).success).toBe(true);
    expect(decisionSchema.safeParse({ decision: 'request_reupload', kinds: [] }).success).toBe(false);
    expect(
      decisionSchema.safeParse({
        decision: 'approve',
        checklist: { nameMatches: true, dobMatches: true, photoMatches: true, notExpired: true, notTampered: true },
      }).success,
    ).toBe(true);
  });
});
