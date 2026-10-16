import { Types } from 'mongoose';
import type { ConsentPurpose, LegalType } from '@marchmaker/shared';
import { Consent, LegalDocument } from '../models/auth';

/** Latest effective version of each document type. */
export async function latestLegal(types?: LegalType[]) {
  const docs = await LegalDocument.aggregate([
    { $match: { effectiveDate: { $lte: new Date() }, ...(types && { type: { $in: types } }) } },
    { $sort: { type: 1, effectiveDate: -1 } },
    { $group: { _id: '$type', doc: { $first: '$$ROOT' } } },
  ]);
  return docs.map((d) => d.doc as { type: LegalType; version: string; title: string; effectiveDate: Date; markdown: string; material: boolean });
}

export async function recordConsent(
  userId: Types.ObjectId | string,
  purpose: ConsentPurpose,
  granted: boolean,
  meta: { ip?: string; userAgent?: string; documentVersion?: string },
): Promise<void> {
  await Consent.create({ userId, purpose, granted, ...meta });
}

/** Current consent per purpose (the most recent record wins). */
export async function currentConsents(userId: Types.ObjectId | string) {
  const rows = await Consent.aggregate([
    // Aggregation does not cast ids, so convert explicitly.
    { $match: { userId: new Types.ObjectId(String(userId)) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$purpose', granted: { $first: '$granted' }, documentVersion: { $first: '$documentVersion' }, at: { $first: '$createdAt' } } },
  ]);
  return Object.fromEntries(
    rows.map((r) => [r._id as string, { granted: r.granted as boolean, documentVersion: r.documentVersion as string | undefined, at: r.at as Date }]),
  );
}

/** Terms/privacy versions the member has not yet accepted (material changes force re-acceptance). */
export async function pendingLegal(userId: Types.ObjectId | string) {
  const [latest, consents] = await Promise.all([latestLegal(['terms', 'privacy']), currentConsents(userId)]);
  return latest
    .filter((d) => d.material && !(consents[d.type]?.granted && consents[d.type]?.documentVersion === d.version))
    .map((d) => ({ type: d.type, version: d.version, title: d.title }));
}
