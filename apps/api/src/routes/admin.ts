import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ROLES, type Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requireAnyPermission, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { audit } from '../lib/audit';
import { runMatching } from '../services/matching';
import * as matches from '../services/matchReview';
import { getDataRequestSettings, getMatchingConfig, getRetention, getReviewSettings, saveSettings } from '../services/settings';
import { User } from '../models/core';
import { withTransaction } from '../db/connection';
import * as creditsSvc from '../services/credits';
import * as members from '../services/adminMembers';
import * as ops from '../services/adminOps';
import * as reviews from '../services/adminReviews';

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const idParams = z.object({ id: id24 });
const noStore = <T>(res: Response, body: T) => res.set('Cache-Control', 'no-store').json(body);

const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[], permissions: a.permissions as readonly string[] };
};

const memberQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'paused', 'suspended', 'banned', 'deletion_scheduled']).optional(),
  journeyState: z.string().max(40).optional(),
  plan: z.string().max(20).optional(),
  verified: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const statusBody = z.object({
  action: z.enum(['suspend', 'ban', 'pause', 'restore']),
  reason: z.string().trim().min(5, 'Please give a reason').max(500),
});

const noteBody = z.object({ body: z.string().trim().min(1).max(2000), pinned: z.boolean().optional() });
const notePatch = z.object({ body: z.string().trim().min(1).max(2000).optional(), pinned: z.boolean().optional() });

const auditQuery = z.object({
  actor: z.string().trim().max(254).optional(),
  subject: z.string().trim().max(60).optional(),
  action: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Staff console API. Every route needs a TOTP-verified session plus the stated permission. */
export function adminRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    '/dashboard',
    requirePermission('metrics.view'),
    asyncHandler(async (_req, res) => noStore(res, await ops.dashboard())),
  );

  // ----- members
  r.get(
    '/members',
    requirePermission('member.search'),
    validate({ query: memberQuery }),
    asyncHandler(async (req, res) => {
      noStore(res, await members.searchMembers(ctx, req.query as unknown as members.MemberQuery));
    }),
  );
  r.get(
    '/members/:id',
    requireAnyPermission('member.view_basic', 'member.view_full'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res, await members.memberDetail(ctx, req, String(req.params.id), actorOf(req)));
    }),
  );
  r.post(
    '/members/:id/status',
    requirePermission('member.suspend'),
    validate({ params: idParams, body: statusBody }),
    asyncHandler(async (req, res) => {
      const { action, reason } = req.body as z.infer<typeof statusBody>;
      if (action === 'ban' && !authedUser(req).permissions.includes('member.ban')) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this', requestId: String(req.id) } });
        return;
      }
      res.json(await members.changeStatus(ctx, req, String(req.params.id), action, reason, actorOf(req)));
    }),
  );
  r.get(
    '/members/:id/as-member',
    requirePermission('member.impersonate_view'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res, await members.viewAsMember(ctx, req, String(req.params.id), actorOf(req)));
    }),
  );

  // ----- notes
  r.get(
    '/members/:id/notes',
    requirePermission('member.notes'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => noStore(res, { items: await members.listNotes(String(req.params.id)) })),
  );
  r.post(
    '/members/:id/notes',
    requirePermission('member.notes'),
    validate({ params: idParams, body: noteBody }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await members.addNote(req, String(req.params.id), authedUser(req).userId, req.body.body, req.body.pinned));
    }),
  );
  r.patch(
    '/notes/:id',
    requirePermission('member.notes'),
    validate({ params: idParams, body: notePatch }),
    asyncHandler(async (req, res) => {
      await members.updateNote(req, String(req.params.id), actorOf(req), req.body);
      res.json({ ok: true });
    }),
  );
  r.delete(
    '/notes/:id',
    requirePermission('member.notes'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      await members.deleteNote(req, String(req.params.id), actorOf(req));
      res.status(204).end();
    }),
  );

  // ----- profile review
  r.get(
    '/profiles',
    requirePermission('profile.review'),
    asyncHandler(async (req, res) => {
      const status = z.enum(['submitted', 'changes_requested', 'approved']).catch('submitted').parse(req.query.status);
      noStore(res, { items: await reviews.profileQueue(status) });
    }),
  );
  r.post(
    '/profiles/:id/decision',
    requirePermission('profile.review'),
    validate({ params: idParams, body: reviews.profileDecisionSchema }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      res.json(await reviews.decideProfile(req, String(req.params.id), { userId: a.userId, roles: a.roles }, req.body));
    }),
  );

  // ----- photo review
  r.get(
    '/photos',
    requirePermission('photo.review'),
    asyncHandler(async (req, res) => {
      const status = z.enum(['pending', 'approved', 'rejected']).catch('pending').parse(req.query.status);
      noStore(res, { items: await reviews.photoQueue(ctx, status) });
    }),
  );
  r.post(
    '/photos/:id/decision',
    requirePermission('photo.review'),
    validate({ params: idParams, body: reviews.photoDecisionSchema }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      res.json(await reviews.decidePhoto(req, String(req.params.id), { userId: a.userId, roles: a.roles }, req.body));
    }),
  );

  // ----- matching and review
  r.get(
    '/matches',
    requirePermission('match.review'),
    asyncHandler(async (req, res) => {
      const status = z.enum(['open', 'suggested', 'in_review', 'snoozed', 'escalated', 'approved']).catch('open').parse(req.query.status);
      noStore(res, { items: await matches.queue(status) });
    }),
  );
  r.post(
    '/matches/run',
    requirePermission('match.review'),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      const summary = await runMatching(ctx);
      await audit(req, { action: 'match.run', actorId: a.userId, actorRoles: a.roles, after: summary });
      res.json(summary);
    }),
  );
  r.post(
    '/matches/manual',
    requirePermission('match.create_manual'),
    validate({ body: matches.manualSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await matches.createManual(ctx, req, actorOf(req), req.body));
    }),
  );
  r.get(
    '/matches/:id',
    requirePermission('match.review'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res, await matches.detail(ctx, req, String(req.params.id), actorOf(req)));
    }),
  );
  r.post(
    '/matches/:id/decision',
    requirePermission('match.review'),
    validate({ params: idParams, body: matches.decisionSchema }),
    asyncHandler(async (req, res) => {
      res.json(await matches.decide(ctx, req, String(req.params.id), actorOf(req), req.body));
    }),
  );
  r.post(
    '/matches/:id/undo',
    requirePermission('match.approve'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await matches.undo(req, String(req.params.id), actorOf(req)));
    }),
  );
  r.post(
    '/members/:id/review-flag',
    requirePermission('member.suspend'),
    validate({ params: idParams, body: z.object({ twoPerson: z.boolean(), reason: z.string().trim().min(5).max(300) }) }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      await User.updateOne({ _id: String(req.params.id), roles: 'member' }, { $set: { 'reviewFlags.twoPerson': req.body.twoPerson } });
      await audit(req, {
        action: 'member.review_flag',
        actorId: a.userId,
        actorRoles: a.roles,
        subjectType: 'user',
        subjectId: String(req.params.id),
        after: req.body,
      });
      res.json({ ok: true });
    }),
  );
  r.get(
    '/settings',
    requirePermission('settings.manage'),
    asyncHandler(async (_req, res) => {
      noStore(res, {
        matching: await getMatchingConfig(),
        review: await getReviewSettings(),
        retention: await getRetention(ctx.env),
        data_requests: await getDataRequestSettings(),
      });
    }),
  );
  r.put(
    '/settings/:key',
    requirePermission('settings.manage'),
    asyncHandler(async (req, res) => {
      const key = z.enum(['matching', 'review', 'retention', 'data_requests']).parse(req.params.key);
      const a = authedUser(req);
      const { before, after } = await saveSettings(key, req.body, a.userId, ctx.env);
      await audit(req, {
        action: `settings.${key}_changed`,
        actorId: a.userId,
        actorRoles: a.roles,
        subjectType: 'settings',
        subjectId: key,
        before,
        after,
      });
      res.json(after);
    }),
  );

  // ----- credits
  r.post(
    '/members/:id/credits',
    requirePermission('credits.grant'),
    validate({ params: idParams, body: z.object({ amount: z.number().int().min(1).max(50), reason: z.string().trim().min(5).max(300) }) }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      const out = await withTransaction((session) =>
        creditsSvc.grant(String(req.params.id), req.body.amount, req.body.reason, session, a.userId),
      );
      await audit(req, {
        action: 'credits.granted',
        actorId: a.userId,
        actorRoles: a.roles,
        subjectType: 'user',
        subjectId: String(req.params.id),
        after: { amount: req.body.amount, reason: req.body.reason },
      });
      res.status(201).json(out);
    }),
  );

  // ----- audit
  r.get(
    '/audit',
    requirePermission('audit.view'),
    validate({ query: auditQuery }),
    asyncHandler(async (req, res) => noStore(res, await ops.searchAudit(req.query as unknown as ops.AuditQuery))),
  );
  r.get(
    '/audit/export.csv',
    requirePermission('audit.view'),
    validate({ query: auditQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as ops.AuditQuery;
      const filter = { actor: q.actor, subject: q.subject, action: q.action, from: q.from, to: q.to };
      const csv = await ops.auditCsv(req, filter, actorOf(req));
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-log.csv"',
        'Cache-Control': 'no-store',
      });
      res.send(csv);
    }),
  );

  // ----- team and permissions
  r.get(
    '/staff',
    requirePermission('admin_users.manage'),
    asyncHandler(async (_req, res) => noStore(res, { items: await ops.listStaff() })),
  );
  r.post(
    '/staff',
    requirePermission('admin_users.manage'),
    validate({ body: ops.staffCreateSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await ops.inviteStaff(ctx, req, actorOf(req), req.body));
    }),
  );
  r.put(
    '/staff/:id/roles',
    requirePermission('admin_users.manage'),
    validate({
      params: idParams,
      body: z.object({ roles: z.array(z.enum(ROLES as unknown as [Role, ...Role[]])).min(1).max(4) }),
    }),
    asyncHandler(async (req, res) => {
      await ops.setStaffRoles(req, String(req.params.id), actorOf(req), req.body.roles);
      res.json({ ok: true });
    }),
  );
  r.post(
    '/staff/:id/reset-2fa',
    requirePermission('admin_users.manage'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      await ops.resetStaffTwoFactor(ctx, req, String(req.params.id), actorOf(req));
      res.json({ ok: true });
    }),
  );
  r.post(
    '/staff/:id/active',
    requirePermission('admin_users.manage'),
    validate({ params: idParams, body: z.object({ active: z.boolean() }) }),
    asyncHandler(async (req, res) => {
      await ops.setStaffActive(req, String(req.params.id), actorOf(req), req.body.active);
      res.json({ ok: true });
    }),
  );
  r.get(
    '/roles',
    requirePermission('roles.manage'),
    asyncHandler(async (_req, res) => noStore(res, await ops.roleMatrix(ctx))),
  );
  r.put(
    '/roles/:role',
    requirePermission('roles.manage'),
    validate({ body: ops.rolePermissionsSchema }),
    asyncHandler(async (req, res) => {
      res.json(await ops.setRolePermissions(ctx, req, String(req.params.role), actorOf(req), req.body.permissions));
    }),
  );

  // ----- flags and question banks
  r.get(
    '/flags',
    requirePermission('flags.manage'),
    asyncHandler(async (_req, res) => noStore(res, { items: await ops.listFlags() })),
  );
  r.put(
    '/flags/:key',
    requirePermission('flags.manage'),
    validate({ body: z.object({ enabled: z.boolean() }) }),
    asyncHandler(async (req, res) => {
      res.json(await ops.setFlag(req, String(req.params.key), req.body.enabled, actorOf(req)));
    }),
  );
  r.get(
    '/assessments',
    requirePermission('content.manage'),
    asyncHandler(async (_req, res) => noStore(res, { items: await ops.listBanks() })),
  );
  r.get(
    '/assessments/:key',
    requirePermission('content.manage'),
    asyncHandler(async (req, res) => noStore(res, await ops.bankDetail(String(req.params.key)))),
  );
  r.post(
    '/assessments/:key/versions',
    requirePermission('content.manage'),
    validate({ body: ops.bankPublishSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await ops.publishBank(req, String(req.params.key), actorOf(req), req.body));
    }),
  );

  return r;
}
