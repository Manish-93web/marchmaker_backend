import { defineMachine } from './machine';

export const JOURNEY_STATES = [
  'registered',
  'email_verified',
  'profile_in_progress',
  'profile_submitted',
  'profile_changes_requested',
  'profile_approved',
  'verification_pending',
  'verification_rejected',
  'verified',
  'matching_active',
  'paused',
  'suspended',
  'banned',
  'deletion_scheduled',
  'deleted',
] as const;
export type JourneyState = (typeof JOURNEY_STATES)[number];

const EXIT = ['deletion_scheduled', 'suspended', 'banned'] as const;

export const journeyMachine = defineMachine<JourneyState>('journey', 'registered', {
  registered: ['email_verified', ...EXIT],
  email_verified: ['profile_in_progress', ...EXIT],
  profile_in_progress: ['profile_submitted', ...EXIT],
  profile_submitted: ['profile_changes_requested', 'profile_approved', ...EXIT],
  profile_changes_requested: ['profile_submitted', ...EXIT],
  // A reviewer can reopen an approved profile when something needs correcting.
  profile_approved: ['verification_pending', 'verified', 'profile_changes_requested', ...EXIT],
  verification_pending: ['verified', 'verification_rejected', ...EXIT],
  verification_rejected: ['verification_pending', ...EXIT],
  verified: ['matching_active', ...EXIT],
  matching_active: ['paused', ...EXIT],
  paused: ['matching_active', ...EXIT],
  // Lifting a suspension returns the member to where they were.
  suspended: [
    'registered',
    'email_verified',
    'profile_in_progress',
    'profile_submitted',
    'profile_changes_requested',
    'profile_approved',
    'verification_pending',
    'verification_rejected',
    'verified',
    'matching_active',
    'paused',
    'banned',
    'deletion_scheduled',
  ],
  banned: ['deletion_scheduled'],
  deletion_scheduled: ['deleted', 'registered', 'email_verified', 'profile_in_progress', 'matching_active'],
  deleted: [],
});

/** Who is the member waiting on, per tracker step (Section S2). */
export type Waiting = 'you' | 'team' | 'none';
export const TRACKER_STEPS = [
  'account',
  'profile',
  'verification',
  'profile_review',
  'matching',
  'introductions',
  'connected',
] as const;
export type TrackerStep = (typeof TRACKER_STEPS)[number];

export interface TrackerStatus {
  step: TrackerStep;
  waitingOn: Waiting;
  etaText: string | null;
  ctaKey: string;
}

export function trackerFor(state: JourneyState, opts: { hasUnlockedIntro?: boolean } = {}): TrackerStatus {
  switch (state) {
    case 'registered':
      return { step: 'account', waitingOn: 'you', etaText: null, ctaKey: 'verify_email' };
    case 'email_verified':
    case 'profile_in_progress':
    case 'profile_changes_requested':
      return { step: 'profile', waitingOn: 'you', etaText: null, ctaKey: 'continue_profile' };
    case 'profile_submitted':
      return { step: 'profile_review', waitingOn: 'team', etaText: 'Usually within 48 hours', ctaKey: 'none' };
    case 'profile_approved':
    case 'verification_rejected':
      return { step: 'verification', waitingOn: 'you', etaText: null, ctaKey: 'start_verification' };
    case 'verification_pending':
      return { step: 'verification', waitingOn: 'team', etaText: 'Usually within 24 hours', ctaKey: 'none' };
    case 'verified':
    case 'matching_active':
      return opts.hasUnlockedIntro
        ? { step: 'connected', waitingOn: 'none', etaText: null, ctaKey: 'open_messages' }
        : {
            step: 'matching',
            waitingOn: 'team',
            etaText: 'We review every introduction by hand',
            ctaKey: 'view_introductions',
          };
    default:
      return { step: 'account', waitingOn: 'none', etaText: null, ctaKey: 'contact_support' };
  }
}
