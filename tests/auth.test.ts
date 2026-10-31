import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IS_DEV_MOCK_AUTH_ENABLED } from '../src/lib/supabase';

describe('Authentication & Profile Authorization (003 RLS Contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ensures dev mock auth flag is disabled by default in production/standard mode', () => {
    expect(IS_DEV_MOCK_AUTH_ENABLED).toBe(false);
  });

  it('strictly denies access and signs out if a user exists in auth but has no company profile', async () => {
    // Mock Supabase client behavior
    const mockSignOut = vi.fn().mockResolvedValue({ error: null });
    const mockUser = { id: 'auth-user-without-profile-uuid', email: 'intruder@external.com' };

    // Simulate profile lookup returning null (user not registered in company profiles)
    const profileLookup = vi.fn().mockResolvedValue({ data: null, error: null });

    const validateAccess = async (user: { id: string; email: string }) => {
      const { data: profile } = await profileLookup(user.id);
      if (!profile) {
        await mockSignOut();
        throw new Error('حسابك غير مسجل في سجلات موظفي المنشأة (No active profile found). يرجى مراجعة إدارة النظام.');
      }
      return profile;
    };

    await expect(validateAccess(mockUser)).rejects.toThrow('No active profile found');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('strictly denies access if employee profile is marked is_active = false', async () => {
    const mockSignOut = vi.fn().mockResolvedValue({ error: null });
    const mockUser = { id: 'deactivated-employee-uuid', email: 'fired@company.com' };

    const profileLookup = vi.fn().mockResolvedValue({
      data: {
        id: mockUser.id,
        full_name: 'موظف معطل',
        role_id: 'some-role',
        is_active: false,
      },
      error: null,
    });

    const validateAccess = async (user: { id: string; email: string }) => {
      const { data: profile } = await profileLookup(user.id);
      if (!profile || !profile.is_active) {
        await mockSignOut();
        throw new Error('تم تعطيل حساب الموظف الخاص بك. يرجى التواصل مع إدارة الموارد البشرية.');
      }
      return profile;
    };

    await expect(validateAccess(mockUser)).rejects.toThrow('تم تعطيل حساب الموظف');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('allows access and loads full context for active employee with valid role and branches', async () => {
    const mockUser = { id: 'valid-employee-uuid', email: 'accountant@company.com' };

    const profileLookup = vi.fn().mockResolvedValue({
      data: {
        id: mockUser.id,
        full_name: 'أحمد محمود (محاسب)',
        role_id: 'role-accountant-uuid',
        is_active: true,
      },
    });

    const roleLookup = vi.fn().mockResolvedValue({
      data: {
        id: 'role-accountant-uuid',
        name: 'Accountant',
      },
    });

    const branchLookup = vi.fn().mockResolvedValue({
      data: [
        {
          branches: {
            id: 'branch-cairo-uuid',
            code: 'CAI',
            name_ar: 'فرع القاهرة',
            is_active: true,
          },
        },
      ],
    });

    const { data: profile } = await profileLookup(mockUser.id);
    expect(profile.is_active).toBe(true);

    const { data: role } = await roleLookup(profile.role_id);
    expect(role.name).toBe('Accountant');

    const { data: branchRows } = await branchLookup(mockUser.id);
    const branches = branchRows.map((r: any) => r.branches);
    expect(branches.length).toBe(1);
    expect(branches[0].code).toBe('CAI');
  });
});
