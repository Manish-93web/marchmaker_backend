import type { Role } from './enums';

export const PERMISSIONS = [
  'member.search',
  'member.view_basic',
  'member.view_full',
  'member.suspend',
  'member.ban',
  'member.notes',
  'member.impersonate_view',
  'profile.review',
  'photo.review',
  'verification.view_evidence',
  'verification.decide',
  'match.review',
  'match.approve',
  'match.create_manual',
  'introduction.view',
  'moderation.view',
  'moderation.act',
  'messages.view_reported',
  'support.view',
  'support.reply',
  'payment.view',
  'payment.refund',
  'plan.manage',
  'coupon.manage',
  'credits.grant',
  'wallet.adjust',
  'content.manage',
  'legal.manage',
  'settings.manage',
  'flags.manage',
  'roles.manage',
  'admin_users.manage',
  'audit.view',
  'jobs.manage',
  'data_requests.approve',
  'metrics.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];

/** Seed defaults only; the live mapping is stored in the DB and editable by super_admin. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  member: [],
  support_agent: ['member.search', 'member.view_basic', 'member.notes', 'support.view', 'support.reply'],
  matchmaker: [
    'member.search',
    'member.view_full',
    'member.notes',
    'profile.review',
    'match.review',
    'match.approve',
    'match.create_manual',
    'introduction.view',
  ],
  verifier: ['member.view_basic', 'photo.review', 'verification.view_evidence', 'verification.decide'],
  moderator: [
    'member.search',
    'member.view_basic',
    'member.suspend',
    'member.ban',
    'member.notes',
    'moderation.view',
    'moderation.act',
    'messages.view_reported',
    'introduction.view',
  ],
  finance: ['member.view_basic', 'payment.view', 'payment.refund', 'coupon.manage', 'metrics.view'],
  admin: ALL.filter((p) => !['roles.manage', 'admin_users.manage', 'data_requests.approve'].includes(p)),
  super_admin: ALL,
};

export function hasPermission(userPerms: readonly string[], required: Permission): boolean {
  return userPerms.includes(required);
}

export function permissionsForRoles(
  roles: readonly Role[],
  mapping: Record<string, readonly string[]> = DEFAULT_ROLE_PERMISSIONS,
): Permission[] {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of mapping[r] ?? []) out.add(p as Permission);
  return [...out];
}

export const STAFF_ROLES: readonly Role[] = [
  'support_agent',
  'matchmaker',
  'verifier',
  'moderator',
  'finance',
  'admin',
  'super_admin',
];
export const isStaff = (roles: readonly Role[]) => roles.some((r) => STAFF_ROLES.includes(r));
