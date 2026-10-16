import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import {
  billingProfileSchema,
  changePlanSchema,
  packOrderSchema,
  subscribeSchema,
  decisionSchema,
  evidenceUploadSchema,
  verificationSubmitSchema,
  answersPatchSchema,
  photoOrderSchema,
  photoUploadRequestSchema,
  preferencesSchema,
  accountPatchSchema,
  apiErrorSchema,
  consentSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  notificationPrefsSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  totpCodeSchema,
  verifyEmailSchema,
  API_PREFIX,
} from '@marchmaker/shared';

const registry = new OpenAPIRegistry();
registry.registerComponent('securitySchemes', 'cookieAuth', { type: 'apiKey', in: 'cookie', name: 'mm_at' });
registry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });

const Err = { description: 'Error', content: { 'application/json': { schema: apiErrorSchema } } };
const Ok = (description = 'OK') => ({ description, content: { 'application/json': { schema: z.object({}).loose() } } });

interface Route {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  tag: string;
  body?: z.ZodType;
  auth?: boolean;
  status?: number;
}

const routes: Route[] = [
  { method: 'post', path: '/auth/register', summary: 'Create an account (always 202; never reveals existing accounts)', tag: 'Auth', body: registerSchema, status: 202 },
  { method: 'post', path: '/auth/login', summary: 'Sign in with email + password (+ TOTP for staff)', tag: 'Auth', body: loginSchema },
  { method: 'post', path: '/auth/refresh', summary: 'Rotate the refresh token', tag: 'Auth', body: refreshSchema },
  { method: 'post', path: '/auth/logout', summary: 'Sign out this device', tag: 'Auth', status: 204 },
  { method: 'post', path: '/auth/logout-all', summary: 'Sign out every device', tag: 'Auth', auth: true, status: 204 },
  { method: 'get', path: '/auth/me', summary: 'Current member, journey and pending legal acceptance', tag: 'Auth', auth: true },
  { method: 'post', path: '/auth/verify-email', summary: 'Confirm an email link', tag: 'Auth', body: verifyEmailSchema },
  { method: 'post', path: '/auth/resend-verification', summary: 'Resend the verification email', tag: 'Auth', body: resendVerificationSchema, status: 202 },
  { method: 'post', path: '/auth/otp/request', summary: 'Request a one-time code', tag: 'Auth', body: otpRequestSchema, status: 202 },
  { method: 'post', path: '/auth/otp/verify', summary: 'Verify a one-time code', tag: 'Auth', body: otpVerifySchema },
  { method: 'post', path: '/auth/password/forgot', summary: 'Email a password reset link', tag: 'Auth', body: forgotPasswordSchema, status: 202 },
  { method: 'post', path: '/auth/password/reset', summary: 'Set a new password with a reset token', tag: 'Auth', body: resetPasswordSchema },
  { method: 'get', path: '/auth/sessions', summary: 'List active sessions', tag: 'Auth', auth: true },
  { method: 'delete', path: '/auth/sessions/{id}', summary: 'Revoke a session', tag: 'Auth', auth: true, status: 204 },
  { method: 'post', path: '/auth/2fa/setup', summary: 'Begin TOTP setup (staff)', tag: 'Auth', auth: true },
  { method: 'post', path: '/auth/2fa/confirm', summary: 'Confirm TOTP setup (staff)', tag: 'Auth', body: totpCodeSchema, auth: true },
  { method: 'patch', path: '/account', summary: 'Update name, locale or password', tag: 'Account', body: accountPatchSchema, auth: true },
  { method: 'post', path: '/account/pause', summary: 'Pause matching', tag: 'Account', auth: true },
  { method: 'post', path: '/account/resume', summary: 'Resume matching', tag: 'Account', auth: true },
  { method: 'post', path: '/account/delete', summary: 'Schedule deletion (14 day grace period)', tag: 'Account', body: deleteAccountSchema, auth: true },
  { method: 'post', path: '/account/restore', summary: 'Cancel a scheduled deletion', tag: 'Account', auth: true },
  { method: 'post', path: '/account/export', summary: 'Request a data export (async, emailed signed link)', tag: 'Account', auth: true, status: 202 },
  { method: 'get', path: '/account/notification-preferences', summary: 'Read notification preferences', tag: 'Account', auth: true },
  { method: 'put', path: '/account/notification-preferences', summary: 'Replace notification preferences', tag: 'Account', body: notificationPrefsSchema, auth: true },
  { method: 'get', path: '/account/consents', summary: 'Consent history', tag: 'Account', auth: true },
  { method: 'post', path: '/account/consents', summary: 'Grant or withdraw a consent', tag: 'Account', body: consentSchema, auth: true, status: 201 },
  { method: 'get', path: '/profile', summary: 'Own profile with step completion and version', tag: 'Profile', auth: true },
  { method: 'patch', path: '/profile/steps/{step}', summary: 'Autosave one step (If-Match: version; 409 VERSION_CONFLICT returns the server copy)', tag: 'Profile', auth: true },
  { method: 'post', path: '/profile/submit', summary: 'Submit the profile for human review', tag: 'Profile', auth: true },
  { method: 'get', path: '/profile/journey', summary: 'Journey tracker, resume point and checklist', tag: 'Profile', auth: true },
  { method: 'get', path: '/preferences', summary: 'Own preferences', tag: 'Preferences', auth: true },
  { method: 'put', path: '/preferences', summary: 'Replace preferences (must-have vs flexible)', tag: 'Preferences', body: preferencesSchema, auth: true },
  { method: 'get', path: '/preferences/pool-estimate', summary: 'Coarse pool bucket and hint (never a count)', tag: 'Preferences', auth: true },
  { method: 'get', path: '/photos', summary: 'Own photos with short-lived signed links', tag: 'Photos', auth: true },
  { method: 'post', path: '/photos/upload-url', summary: 'Pre-signed PUT for a private upload', tag: 'Photos', body: photoUploadRequestSchema, auth: true, status: 201 },
  { method: 'post', path: '/photos/{id}/confirm', summary: 'Confirm an upload and queue processing', tag: 'Photos', auth: true },
  { method: 'patch', path: '/photos/{id}/primary', summary: 'Choose the primary photo', tag: 'Photos', auth: true },
  { method: 'put', path: '/photos/order', summary: 'Reorder photos', tag: 'Photos', body: photoOrderSchema, auth: true },
  { method: 'delete', path: '/photos/{id}', summary: 'Delete a photo and all its variants', tag: 'Photos', auth: true, status: 204 },
  { method: 'post', path: '/transcribe', summary: 'Server speech-to-text fallback (feature flagged; audio is never stored)', tag: 'Profile', auth: true },
  { method: 'get', path: '/assessments', summary: 'Assessments with status and retake date', tag: 'Assessments', auth: true },
  { method: 'get', path: '/assessments/{id}', summary: 'Questions (without scoring data) and saved answers', tag: 'Assessments', auth: true },
  { method: 'put', path: '/assessments/{id}/responses', summary: 'Autosave answers', tag: 'Assessments', body: answersPatchSchema, auth: true },
  { method: 'post', path: '/assessments/{id}/complete', summary: 'Score and write the result (words only)', tag: 'Assessments', auth: true },
  { method: 'get', path: '/assessments/{id}/result', summary: 'The written result; never contains numbers', tag: 'Assessments', auth: true },
  { method: 'get', path: '/verification/status', summary: 'Verification state, badges and next step', tag: 'Verification', auth: true },
  { method: 'post', path: '/verification/upload-url', summary: 'Pre-signed PUT to the private identity bucket', tag: 'Verification', body: evidenceUploadSchema, auth: true, status: 201 },
  { method: 'post', path: '/verification/submit', summary: 'Submit uploaded ID and selfie for review', tag: 'Verification', body: verificationSubmitSchema, auth: true },
  { method: 'post', path: '/verification/kyc/session', summary: 'Start automated KYC + liveness (feature flagged)', tag: 'Verification', auth: true, status: 201 },
  { method: 'get', path: '/admin/verification', summary: 'Verifier queue', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/verification/{id}', summary: 'Case detail with short-lived evidence links (audited)', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/verification/{id}/decision', summary: 'Approve, reject or request re-upload', tag: 'Admin', body: decisionSchema, auth: true },
  { method: 'post', path: '/webhooks/kyc', summary: 'Signed provider callback (stored, then processed by the worker)', tag: 'Webhooks', status: 200 },
  { method: 'get', path: '/admin/dashboard', summary: 'Queue sizes and headline counts', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/members', summary: 'Search members (name, email, phone, id, filters, cursor)', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/members/{id}', summary: 'Member detail; full sections need member.view_full (audited)', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/members/{id}/status', summary: 'Suspend, ban, pause or restore with a reason', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/members/{id}/as-member', summary: 'Read-only view of what the member sees (audited)', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/members/{id}/notes', summary: 'Internal notes', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/members/{id}/notes', summary: 'Add an internal note', tag: 'Admin', auth: true, status: 201 },
  { method: 'get', path: '/admin/profiles', summary: 'Profile review queue', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/profiles/{id}/decision', summary: 'Approve, request changes or reopen', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/photos', summary: 'Photo review queue', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/photos/{id}/decision', summary: 'Approve or reject a photo', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/audit', summary: 'Audit log explorer', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/audit/export.csv', summary: 'CSV export (formula-safe, audited)', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/staff', summary: 'Team list', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/staff', summary: 'Invite a staff member by single-use link', tag: 'Admin', auth: true, status: 201 },
  { method: 'get', path: '/admin/roles', summary: 'Role and permission matrix', tag: 'Admin', auth: true },
  { method: 'put', path: '/admin/roles/{role}', summary: 'Set the permissions of a role (effective immediately)', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/flags', summary: 'Feature flags', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/assessments', summary: 'Question banks', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/assessments/{key}/versions', summary: 'Publish the next version of a question bank', tag: 'Admin', auth: true, status: 201 },
  { method: 'get', path: '/admin/matches', summary: 'Match review queue (plan priority, then waiting time)', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/matches/{id}', summary: 'Side-by-side review; opening claims it', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/matches/{id}/decision', summary: 'Approve (with why-text), reject, snooze or escalate', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/matches/{id}/undo', summary: 'Undo an approval inside the cool-off window', tag: 'Admin', auth: true },
  { method: 'post', path: '/admin/matches/manual', summary: 'Create an introduction by hand', tag: 'Admin', auth: true, status: 201 },
  { method: 'post', path: '/admin/matches/run', summary: 'Run matching now', tag: 'Admin', auth: true },
  { method: 'get', path: '/admin/settings', summary: 'Matching weights and review limits', tag: 'Admin', auth: true },
  { method: 'get', path: '/introductions', summary: 'Your introductions (blurred photo, reviewed explanation)', tag: 'Introductions', auth: true },
  { method: 'get', path: '/introductions/{id}', summary: 'One introduction; marks it viewed', tag: 'Introductions', auth: true },
  { method: 'post', path: '/introductions/{id}/accept', summary: 'Say yes with a first note (Idempotency-Key required; holds a credit)', tag: 'Introductions', auth: true },
  { method: 'post', path: '/introductions/{id}/decline', summary: 'Decline kindly; the other member sees only a neutral ending', tag: 'Introductions', auth: true },
  { method: 'post', path: '/introductions/{id}/share-contact', summary: 'Choose to share contact details (both must)', tag: 'Introductions', auth: true },
  { method: 'get', path: '/introductions/{id}/contact', summary: 'Contact details, only when both have shared', tag: 'Introductions', auth: true },
  { method: 'get', path: '/introductions/{id}/photos', summary: 'Short-lived photo links, only after mutual acceptance', tag: 'Introductions', auth: true },
  { method: 'get', path: '/threads', summary: 'Conversations with unread counts', tag: 'Messages', auth: true },
  { method: 'get', path: '/threads/{id}/messages', summary: 'Messages (newest page first, cursor by id)', tag: 'Messages', auth: true },
  { method: 'post', path: '/threads/{id}/messages', summary: 'Send a text message (contact details are refused)', tag: 'Messages', auth: true, status: 201 },
  { method: 'post', path: '/threads/{id}/read', summary: 'Mark a conversation read', tag: 'Messages', auth: true },
  { method: 'post', path: '/blocks', summary: 'Block a member; ends the introduction and conversation', tag: 'Safety', auth: true, status: 201 },
  { method: 'delete', path: '/blocks/{userId}', summary: 'Remove a block', tag: 'Safety', auth: true },
  { method: 'post', path: '/reports', summary: 'Report a concern (critical categories alert the team)', tag: 'Safety', auth: true, status: 201 },
  { method: 'get', path: '/reports/mine', summary: 'Status of your reports', tag: 'Safety', auth: true },
  { method: 'get', path: '/billing/credits/ledger', summary: 'Your credit history', tag: 'Billing', auth: true },
  { method: 'post', path: '/admin/members/{id}/credits', summary: 'Grant credits with a reason (audited)', tag: 'Admin', auth: true, status: 201 },
  { method: 'get', path: '/plans', summary: 'Active plans and introduction packs (GST inclusive, paise)', tag: 'Content' },
  { method: 'get', path: '/success-stories', summary: 'Published, consented success stories', tag: 'Content' },
  { method: 'get', path: '/guides', summary: 'Published e-guide index', tag: 'Content' },
  { method: 'post', path: '/contact', summary: 'Send a message to the team', tag: 'Content', status: 202 },
  { method: 'get', path: '/legal', summary: 'Latest version of every legal document', tag: 'Legal' },
  { method: 'get', path: '/legal/{type}', summary: 'Latest version of one legal document', tag: 'Legal' },
  { method: 'get', path: '/billing', summary: 'Plan, subscription, credits and billing profile', tag: 'Billing', auth: true },
  { method: 'get', path: '/billing/payments', summary: 'Payment history', tag: 'Billing', auth: true },
  { method: 'get', path: '/billing/invoices', summary: 'GST invoices and credit notes', tag: 'Billing', auth: true },
  { method: 'get', path: '/billing/invoices/{id}/download', summary: 'Short-lived invoice PDF link', tag: 'Billing', auth: true },
  { method: 'put', path: '/billing/profile', summary: 'Save legal name, GSTIN and state for invoices', tag: 'Billing', auth: true, body: billingProfileSchema },
  { method: 'post', path: '/billing/coupon/check', summary: 'Check a coupon for a pack or plan', tag: 'Billing', auth: true },
  { method: 'post', path: '/billing/subscribe', summary: 'Start a subscription checkout', tag: 'Billing', auth: true, body: subscribeSchema, status: 201 },
  { method: 'post', path: '/billing/packs/order', summary: 'Create a payment order for an introduction pack', tag: 'Billing', auth: true, body: packOrderSchema, status: 201 },
  { method: 'post', path: '/billing/confirm', summary: 'Ask the server to confirm a checkout with the provider', tag: 'Billing', auth: true },
  { method: 'post', path: '/billing/change-plan', summary: 'Upgrade now or downgrade at cycle end', tag: 'Billing', auth: true, body: changePlanSchema },
  { method: 'post', path: '/billing/cancel', summary: 'Cancel at the end of the paid period', tag: 'Billing', auth: true },
  { method: 'post', path: '/webhooks/razorpay', summary: 'Payment provider webhook (signature verified)', tag: 'Billing' },
];

for (const r of routes) {
  registry.registerPath({
    method: r.method,
    path: `${API_PREFIX}${r.path}`,
    summary: r.summary,
    tags: [r.tag],
    security: r.auth ? [{ cookieAuth: [] }, { bearerAuth: [] }] : [],
    request: r.body ? { body: { content: { 'application/json': { schema: r.body } } } } : undefined,
    responses: {
      [r.status ?? 200]: r.status === 204 ? { description: 'No content' } : Ok(),
      400: Err,
      401: Err,
      422: Err,
      429: Err,
    },
  });
}

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Marchmaker API', version: '1.0.0', description: 'Intent-to-marry introductions platform' },
    servers: [{ url: '/' }],
  });
}

export function docsRouter(): Router {
  const r = Router();
  let cached: ReturnType<typeof buildOpenApiDocument> | undefined;
  r.get('/openapi.json', (_req, res) => {
    cached ??= buildOpenApiDocument();
    res.json(cached);
  });
  return r;
}
