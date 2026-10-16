import type { RequestHandler } from 'express';
import type { FeatureFlagKey } from '@marchmaker/shared';
import { AppError } from './errors';
import { FeatureFlag } from '../models/core';

export async function flagEnabled(key: FeatureFlagKey): Promise<boolean> {
  return (await FeatureFlag.findOne({ key }).lean())?.enabled === true;
}

/** A switched-off feature answers exactly like a route that does not exist. */
export const requireFlag =
  (key: FeatureFlagKey): RequestHandler =>
  (_req, _res, next) => {
    flagEnabled(key)
      .then((on) => next(on ? undefined : new AppError(404, 'NOT_FOUND', 'We could not find that')))
      .catch(next);
  };
