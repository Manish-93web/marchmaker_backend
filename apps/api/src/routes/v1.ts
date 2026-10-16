import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { DEFAULT_ROLE_PERMISSIONS, DEFAULTS, FEATURE_FLAGS, JOURNEY_STATES } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { authenticate, csrfProtection, originCheck, requireAuth } from '../middleware/auth';
import { accountRouter } from './account';
import { authRouter } from './auth';
import { contentRouter } from './content';
import { legalRouter } from './legal';
import { MEMBER_PREFIXES, memberRouter } from './member';
import { adminVerificationRouter, verificationRouter } from './verification';
import { adminRouter } from './admin';
import { SOCIAL_PREFIXES, socialRouter } from './social';
import { adminMessagingRouter } from './messaging';
import { adminSystemRouter } from './system';
import { EXTRAS_PREFIXES, adminExtrasRouter, extrasRouter, publicExtrasRouter } from './extras';
import { GROWTH_PREFIXES, adminGrowthRouter, growthRouter, publicGrowthRouter } from './growth';
import { REFERRAL_PREFIXES, adminReferralsRouter, referralsRouter } from './referrals';
import { SUPPORT_PREFIXES, adminSafetyRouter, appealsRouter, supportRouter } from './support';
import { NOTIFICATION_PREFIXES, notificationsRouter, unsubscribeRouter } from './notifications';
import { BILLING_PREFIXES, adminBillingRouter, billingRouter } from './billing';

/**
 * Versioned API root. Feature routers are mounted here phase by phase
 * (profile in Phase 4, introductions in Phase 9, ...).
 */
export function v1Router(ctx: AppContext): Router {
  const r = Router();
  r.use(cookieParser());
  r.use(originCheck(ctx));
  r.use(csrfProtection);
  r.use(authenticate(ctx));

  r.get('/meta', (_req, res) => {
    res.json({
      apiVersion: 'v1',
      journeyStates: JOURNEY_STATES,
      featureFlagKeys: FEATURE_FLAGS,
      limits: { maxPhotos: DEFAULTS.maxPhotos, firstNoteMin: DEFAULTS.firstNoteMin, firstNoteMax: DEFAULTS.firstNoteMax },
      roles: Object.keys(DEFAULT_ROLE_PERMISSIONS),
    });
  });

  r.use('/auth', authRouter(ctx));
  r.use('/account', accountRouter(ctx));
  r.use('/legal', legalRouter());
  r.use('/', unsubscribeRouter(ctx));
  r.use('/', appealsRouter(ctx));
  r.use('/', publicGrowthRouter(ctx));
  r.use('/', publicExtrasRouter(ctx));
  r.use('/', contentRouter(ctx));
  // Member routes need a session. Guarding by prefix (not by mounting under it) keeps
  // unknown paths answering 404 instead of 401.
  r.use((req, res, next) =>
    [...MEMBER_PREFIXES, ...SOCIAL_PREFIXES, ...BILLING_PREFIXES, ...NOTIFICATION_PREFIXES, ...SUPPORT_PREFIXES, ...REFERRAL_PREFIXES, ...GROWTH_PREFIXES, ...EXTRAS_PREFIXES].some((p) => req.path === p || req.path.startsWith(`${p}/`))
      ? requireAuth(req, res, next)
      : next(),
  );
  r.use('/', memberRouter(ctx));
  r.use('/', socialRouter(ctx));
  r.use('/', billingRouter(ctx));
  r.use('/', notificationsRouter(ctx));
  r.use('/', supportRouter(ctx));
  r.use('/', referralsRouter(ctx));
  r.use('/', growthRouter());
  r.use('/', extrasRouter(ctx));
  r.use('/admin/billing', adminBillingRouter(ctx));
  r.use('/admin', adminSafetyRouter(ctx));
  r.use('/admin', adminReferralsRouter());
  r.use('/admin', adminGrowthRouter());
  r.use('/admin', adminExtrasRouter(ctx));
  r.use('/admin', adminMessagingRouter(ctx));
  r.use('/admin', adminSystemRouter(ctx));
  r.use('/verification', verificationRouter(ctx));
  r.use('/admin/verification', adminVerificationRouter(ctx));
  r.use('/admin', adminRouter(ctx));

  return r;
}
