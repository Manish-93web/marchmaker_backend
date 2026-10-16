import express, { Router } from 'express';
import { z } from 'zod';
import { answersPatchSchema, photoOrderSchema, photoUploadRequestSchema, PROFILE_STEPS, preferencesSchema } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { AppError, badRequest } from '../lib/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { FeatureFlag } from '../models/core';
import * as assessments from '../services/assessments';
import * as photos from '../services/photos';
import * as prefs from '../services/preferences';
import * as profile from '../services/profile';

const stepParams = z.object({ step: z.enum(PROFILE_STEPS) });
const idParams = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

function ifMatch(header: string | undefined): number {
  const raw = header?.replace(/"/g, '');
  if (!raw || !/^\d+$/.test(raw)) {
    throw new AppError(428, 'PRECONDITION_REQUIRED', 'Send the profile version in the If-Match header');
  }
  return Number(raw);
}

/** Member-owned data: profile, preferences and photos. The v1 router guards these prefixes with requireAuth. */
export const MEMBER_PREFIXES = ['/profile', '/preferences', '/photos', '/transcribe', '/assessments'];

export function memberRouter(ctx: AppContext): Router {
  const r = Router();

  // ---- profile
  r.get(
    '/profile',
    asyncHandler(async (req, res) => {
      res.json(await profile.getProfile(ctx, authedUser(req).userId));
    }),
  );

  r.patch(
    '/profile/steps/:step',
    validate({ params: stepParams }),
    asyncHandler(async (req, res) => {
      const out = await profile.saveStep(
        ctx,
        authedUser(req).userId,
        String(req.params.step) as (typeof PROFILE_STEPS)[number],
        req.body,
        ifMatch(req.get('if-match')),
      );
      res.set('ETag', `"${out.version}"`).json(out);
    }),
  );

  r.post(
    '/profile/submit',
    asyncHandler(async (req, res) => {
      res.json(await profile.submitProfile(ctx, authedUser(req).userId));
    }),
  );

  r.get(
    '/profile/journey',
    asyncHandler(async (req, res) => {
      res.json(await profile.journeySummary(authedUser(req).userId));
    }),
  );

  // ---- preferences
  r.get(
    '/preferences',
    asyncHandler(async (req, res) => {
      res.json(await prefs.getPreferences(authedUser(req).userId));
    }),
  );
  r.put(
    '/preferences',
    validate({ body: preferencesSchema }),
    asyncHandler(async (req, res) => {
      const header = req.get('if-match');
      res.json(await prefs.putPreferences(authedUser(req).userId, req.body, header ? ifMatch(header) : undefined));
    }),
  );
  r.get(
    '/preferences/pool-estimate',
    asyncHandler(async (req, res) => {
      res.json(await prefs.poolEstimate(authedUser(req).userId));
    }),
  );

  // ---- photos
  r.get(
    '/photos',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ items: await photos.listOwnPhotos(ctx, authedUser(req).userId) });
    }),
  );
  r.post(
    '/photos/upload-url',
    validate({ body: photoUploadRequestSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await photos.createUpload(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/photos/:id/confirm',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await photos.confirmUpload(ctx, authedUser(req).userId, String(req.params.id)));
    }),
  );
  r.patch(
    '/photos/:id/primary',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      await photos.setPrimary(authedUser(req).userId, String(req.params.id));
      res.json({ ok: true });
    }),
  );
  r.put(
    '/photos/order',
    validate({ body: photoOrderSchema }),
    asyncHandler(async (req, res) => {
      await photos.reorder(authedUser(req).userId, req.body.order);
      res.json({ ok: true });
    }),
  );
  r.delete(
    '/photos/:id',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      await photos.removePhoto(ctx, authedUser(req).userId, String(req.params.id));
      res.status(204).end();
    }),
  );

  // ---- assessments (:id is the assessment key, e.g. "values")
  r.get(
    '/assessments',
    asyncHandler(async (req, res) => {
      res.json({ items: await assessments.listForMember(authedUser(req).userId) });
    }),
  );
  r.get(
    '/assessments/:id',
    asyncHandler(async (req, res) => {
      res.json(await assessments.getForMember(authedUser(req).userId, String(req.params.id)));
    }),
  );
  r.put(
    '/assessments/:id/responses',
    validate({ body: answersPatchSchema }),
    asyncHandler(async (req, res) => {
      res.json(await assessments.saveAnswers(authedUser(req).userId, String(req.params.id), req.body.answers));
    }),
  );
  r.post(
    '/assessments/:id/complete',
    asyncHandler(async (req, res) => {
      res.json(await assessments.completeAssessment(ctx, authedUser(req).userId, String(req.params.id)));
    }),
  );
  r.get(
    '/assessments/:id/result',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await assessments.resultFor(authedUser(req).userId, String(req.params.id)));
    }),
  );

  // ---- voice typing fallback: audio is transcribed in memory and never stored
  r.post(
    '/transcribe',
    express.raw({ type: ['audio/*', 'video/webm'], limit: '5mb' }),
    asyncHandler(async (req, res) => {
      const flag = await FeatureFlag.findOne({ key: 'voice_transcription_server' }).lean();
      if (!flag?.enabled || !ctx.transcriber) {
        throw new AppError(501, 'NOT_AVAILABLE', 'Voice transcription is not available. Please type your answer.');
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('No audio received');
      const lang = z.enum(['en', 'hi']).catch('en').parse(req.query.lang);
      const text = await ctx.transcriber.transcribe(body, req.get('content-type') ?? 'audio/webm', lang);
      res.json({ text });
    }),
  );

  return r;
}
