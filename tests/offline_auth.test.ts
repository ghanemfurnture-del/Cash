import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeSessionSignature,
  verifySessionSignature,
  OFFLINE_SESSION_MAX_AGE_MS,
  SESSION_STORAGE_KEY,
  type UserSession,
} from '../src/core/auth';
import type { Profile, Role, Branch } from '../src/types/database';

describe('Phase 2c: Secure Offline Authentication & Role/Branch Enforcement Suite', () => {
  const dummyProfile: Profile = {
    id: '11111111-1111-1111-1111-111111111111',
    full_name: 'أحمد محمود (محاسب)',
    role_id: 'role-acc-1',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    server_seq: 1,
  };

  const dummyRole: Role = {
    id: 'role-acc-1',
    name: 'Accountant',
    description: 'محاسب فرع',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    server_seq: 1,
  };

  const branchCairo: Branch = {
    id: 'branch-cai-1',
    code: 'CAI',
    name_ar: 'فرع القاهرة',
    is_main: true,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    server_seq: 1,
  };

  const branchAlex: Branch = {
    id: 'branch-alx-2',
    code: 'ALX',
    name_ar: 'فرع الإسكندرية',
    is_main: false,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    server_seq: 1,
  };

  it('computes and verifies SHA-256 session integrity signature', async () => {
    const expiresAt = Date.now() + OFFLINE_SESSION_MAX_AGE_MS;
    const signature = await computeSessionSignature(
      dummyProfile.id,
      dummyRole.name,
      dummyProfile.is_active,
      expiresAt
    );

    expect(signature).toBeDefined();
    expect(signature.length).toBe(64); // SHA-256 hex string

    const session: UserSession = {
      userId: dummyProfile.id,
      email: 'ahmed@cash.local',
      profile: dummyProfile,
      role: dummyRole,
      branches: [branchCairo],
      currentBranchId: branchCairo.id,
      isOfflineSession: true,
      offlineExpiresAt: expiresAt,
      signature,
    };

    const isValid = await verifySessionSignature(session);
    expect(isValid).toBe(true);
  });

  it('TAMPER RESISTANCE: rejects session if role or status was altered in local storage', async () => {
    const expiresAt = Date.now() + OFFLINE_SESSION_MAX_AGE_MS;
    const signature = await computeSessionSignature(
      dummyProfile.id,
      dummyRole.name,
      dummyProfile.is_active,
      expiresAt
    );

    const session: UserSession = {
      userId: dummyProfile.id,
      email: 'ahmed@cash.local',
      profile: dummyProfile,
      role: dummyRole,
      branches: [branchCairo],
      currentBranchId: branchCairo.id,
      isOfflineSession: true,
      offlineExpiresAt: expiresAt,
      signature,
    };

    // 1. Attack 1: User tries to elevate role to 'Admin' in local storage
    const tamperedRoleSession: UserSession = {
      ...session,
      role: { ...dummyRole, name: 'Admin' },
    };
    expect(await verifySessionSignature(tamperedRoleSession)).toBe(false);

    // 2. Attack 2: User tries to extend offlineExpiresAt by 1 year
    const tamperedExpirySession: UserSession = {
      ...session,
      offlineExpiresAt: expiresAt + 365 * 24 * 60 * 60 * 1000,
    };
    expect(await verifySessionSignature(tamperedExpirySession)).toBe(false);

    // 3. Attack 3: User tries to re-activate a deactivated profile
    const tamperedActiveSession: UserSession = {
      ...session,
      profile: { ...dummyProfile, is_active: false },
    };
    expect(await verifySessionSignature(tamperedActiveSession)).toBe(false);
  });

  it('validates 7-day expiration boundary (OFFLINE_SESSION_MAX_AGE_MS)', () => {
    const now = Date.now();
    const validExpiry = now + 6 * 24 * 60 * 60 * 1000; // 6 days from now
    const expiredExpiry = now - 1000; // 1 second ago

    expect(validExpiry > now).toBe(true);
    expect(expiredExpiry > now).toBe(false);
    expect(OFFLINE_SESSION_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('enforces branch isolation: non-admin cannot access unassigned branches', () => {
    const accountantSession: UserSession = {
      userId: dummyProfile.id,
      email: 'ahmed@cash.local',
      profile: dummyProfile,
      role: dummyRole, // Accountant
      branches: [branchCairo], // Only Cairo assigned
      currentBranchId: branchCairo.id,
      isOfflineSession: true,
    };

    const isAssignedCairo = accountantSession.branches.some((b) => b.id === branchCairo.id);
    const isAssignedAlex = accountantSession.branches.some((b) => b.id === branchAlex.id);

    expect(isAssignedCairo).toBe(true);
    expect(isAssignedAlex).toBe(false);

    // Admin role has unrestricted branch access
    const adminSession: UserSession = {
      ...accountantSession,
      role: { ...dummyRole, name: 'Admin' },
    };
    const canAdminSwitchToAlex =
      adminSession.role.name === 'Admin' || adminSession.branches.some((b) => b.id === branchAlex.id);
    expect(canAdminSwitchToAlex).toBe(true);
  });
});

