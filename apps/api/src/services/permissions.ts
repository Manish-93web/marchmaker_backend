import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Permission, type Role } from '@marchmaker/shared';
import { RolePermission } from '../models/admin';

/**
 * Resolves a staff member's permissions from the database-backed role mapping, falling back
 * to the seeded defaults. Results are cached briefly so a permission change takes effect
 * within seconds without a query on every request.
 */
export class PermissionStore {
  private cache: { at: number; map: Record<string, Permission[]> } | null = null;

  constructor(private readonly ttlMs = 15_000) {}

  invalidate(): void {
    this.cache = null;
  }

  async mapping(): Promise<Record<Role, Permission[]>> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > this.ttlMs) {
      const rows = await RolePermission.find().lean();
      const map: Record<string, Permission[]> = {};
      for (const role of ROLES) {
        const row = rows.find((r) => r.role === role);
        map[role] = row ? (row.permissions.filter((p) => (PERMISSIONS as readonly string[]).includes(p)) as Permission[]) : DEFAULT_ROLE_PERMISSIONS[role];
      }
      // super_admin can never be locked out of anything.
      map.super_admin = [...PERMISSIONS];
      this.cache = { at: now, map };
    }
    return this.cache.map as Record<Role, Permission[]>;
  }

  async forRoles(roles: readonly Role[]): Promise<Permission[]> {
    const m = await this.mapping();
    return [...new Set(roles.flatMap((r) => m[r] ?? []))];
  }
}
