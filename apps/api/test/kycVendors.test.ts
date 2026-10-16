import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateKycResult } from '@marchmaker/shared';
import { VENDOR_PRESETS, VendorKycProvider, createVendorKyc, fill, getPath, mapResult } from '../src/lib/kycVendors';

// Vendor payloads below are written from public documentation, not captured from live accounts.
// They prove the mapping tables behave; docs/KYC.md lists what to confirm against real credentials.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('mapping helpers', () => {
  it('reads nested and array paths and fills templates', () => {
    expect(getPath({ a: { b: [{ c: 5 }] } }, 'a.b.0.c')).toBe(5);
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    expect(fill({ x: 'Hi {name}', y: ['{name}'] }, { name: 'Asha' })).toEqual({ x: 'Hi Asha', y: ['Asha'] });
  });
});

describe('result mapping', () => {
  it('maps a clean HyperVerge-style result to an auto-approvable outcome', () => {
    const raw = { result: { status: 'auto_approved', results: { faceMatch: { match: 'yes', confidence: 96 }, nameMatch: { match: 'yes' }, dobMatch: { match: 'yes' }, liveness: { liveFace: 'yes' }, idCard: { documentType: 'aadhaar card', idNumber: '123456781234' } } } };
    const r = mapResult(VENDOR_PRESETS.hyperverge, raw);
    expect(r).toMatchObject({ status: 'completed', nameMatch: true, dobMatch: true, faceMatch: true, livenessPassed: true, docType: 'aadhaar_masked', docLast4: '1234' });
    expect(r.confidence).toBeCloseTo(0.96);
    expect(evaluateKycResult(r)).toEqual({ action: 'approve' });
  });

  it('never approves on a mismatch, failed liveness, unknown status or an empty body', () => {
    const base = { result: { status: 'approved', results: { faceMatch: { match: 'yes', confidence: 99 }, nameMatch: { match: 'no' }, dobMatch: { match: 'yes' }, liveness: { liveFace: 'yes' } } } };
    expect(evaluateKycResult(mapResult(VENDOR_PRESETS.hyperverge, base))).toMatchObject({ action: 'manual_review', reason: 'mismatch' });
    expect(mapResult(VENDOR_PRESETS.hyperverge, { result: { status: 'in_progress' } }).status).toBe('pending');
    expect(mapResult(VENDOR_PRESETS.hyperverge, { result: { status: 'error' } }).status).toBe('failed');
    const empty = mapResult(VENDOR_PRESETS.idfy, {});
    expect(empty).toMatchObject({ status: 'pending', nameMatch: false, faceMatch: false, livenessPassed: false, confidence: 0 });
  });

  it('maps IDfy scores by threshold and Digio booleans', () => {
    const idfy = mapResult(VENDOR_PRESETS.idfy, [{ status: 'completed', result: { source_output: { name_match: 91, dob_match: true, face_match_score: 88, liveness_check: 'passed' } } }]);
    expect(idfy).toMatchObject({ status: 'completed', nameMatch: true, dobMatch: true, faceMatch: true, livenessPassed: true });
    const weak = mapResult(VENDOR_PRESETS.idfy, [{ status: 'completed', result: { source_output: { name_match: 40, dob_match: true, face_match_score: 88, liveness_check: 'passed' } } }]);
    expect(weak.nameMatch).toBe(false);
    const digio = mapResult(VENDOR_PRESETS.digio, { status: 'approved', actions: [{ details: { name_match: 'true', dob_match: 'true' }, face_match: { verified: true }, liveness: { status: 'success' } }] });
    expect(digio).toMatchObject({ status: 'completed', nameMatch: true, faceMatch: true, livenessPassed: true });
  });
});

describe('vendor provider', () => {
  const make = (fetchImpl: typeof fetch) => new VendorKycProvider(VENDOR_PRESETS.hyperverge, 'https://kyc.example', 'app', 'key', 'whsec', fetchImpl);

  it('opens a session with the templated request and reads the redirect', async () => {
    let seen: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const p = make((async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
      return json({ result: { transactionId: 'tx1', startKycUrl: 'https://hosted.example/tx1' } });
    }) as unknown as typeof fetch);
    const s = await p.createSession({ referenceId: 'ref1', firstName: 'Asha', callbackUrl: 'https://app/cb' });
    expect(s).toEqual({ sessionId: 'tx1', redirectUrl: 'https://hosted.example/tx1' });
    expect(seen!.url).toBe('https://kyc.example/link-kyc/start');
    expect(seen!.body).toMatchObject({ transactionId: 'ref1', redirectUrl: 'https://app/cb' });
    expect(seen!.headers).toMatchObject({ appId: 'app', appKey: 'key' });
  });

  it('fails clearly on a vendor error or a response without a session', async () => {
    await expect(make((async () => json({}, 500)) as unknown as typeof fetch).createSession({ referenceId: 'r', firstName: 'A', callbackUrl: 'u' })).rejects.toThrow('returned 500');
    await expect(make((async () => json({ result: {} })) as unknown as typeof fetch).createSession({ referenceId: 'r', firstName: 'A', callbackUrl: 'u' })).rejects.toThrow('did not include a session');
  });

  it('accepts a webhook only with a valid signature', () => {
    const p = make(fetch);
    const body = Buffer.from(JSON.stringify({ eventId: 'e1', transactionId: 'tx1' }));
    const good = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(p.verifyWebhook(body, { 'x-hyperverge-signature': good })).toEqual({ eventId: 'e1', sessionId: 'tx1' });
    expect(p.verifyWebhook(body, { 'x-hyperverge-signature': 'bad' })).toBeNull();
    expect(p.verifyWebhook(body, {})).toBeNull();
  });

  it('lets a deployment correct the mapping with KYC_MAPPING_JSON', async () => {
    const p = createVendorKyc({
      KYC_PROVIDER: 'digio',
      KYC_BASE_URL: 'https://api.example/',
      KYC_API_KEY: 'id',
      KYC_API_SECRET: 'secret',
      KYC_WEBHOOK_SECRET: 'w',
      KYC_MAPPING_JSON: JSON.stringify({ createSession: { path: '/custom/start' } }),
    });
    expect(p?.name).toBe('digio');
    expect(createVendorKyc({ KYC_PROVIDER: 'rest', KYC_API_KEY: 'x', KYC_WEBHOOK_SECRET: 'w' } as never)).toBeNull();
  });
});
