import { Router } from 'express';
import { LEGAL_TYPES, type LegalType } from '@marchmaker/shared';
import { notFound } from '../lib/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { LegalDocument } from '../models/auth';

export function legalRouter(): Router {
  const r = Router();

  r.get(
    '/',
    asyncHandler(async (_req, res) => {
      const docs = await LegalDocument.aggregate([
        { $match: { effectiveDate: { $lte: new Date() } } },
        { $sort: { effectiveDate: -1 } },
        { $group: { _id: '$type', version: { $first: '$version' }, title: { $first: '$title' }, effectiveDate: { $first: '$effectiveDate' } } },
      ]);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ items: docs.map((d) => ({ type: d._id, version: d.version, title: d.title, effectiveDate: d.effectiveDate })) });
    }),
  );

  r.get(
    '/:type',
    asyncHandler(async (req, res) => {
      const type = String(req.params.type) as LegalType;
      if (!LEGAL_TYPES.includes(type)) throw notFound();
      const doc = await LegalDocument.findOne({ type, effectiveDate: { $lte: new Date() } })
        .sort({ effectiveDate: -1 })
        .lean();
      if (!doc) throw notFound();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        type: doc.type,
        version: doc.version,
        title: doc.title,
        effectiveDate: doc.effectiveDate,
        markdown: doc.markdown,
      });
    }),
  );

  return r;
}
