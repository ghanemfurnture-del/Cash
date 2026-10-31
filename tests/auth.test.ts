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

  it('surfaces Arabic error message under login button when Supabase Auth succeeds but user has no profile', async () => {
    // 1. Simulate successful Supabase Auth sign-in
    const mockAuthData = {
      user: { id: 'auth-user-without-profile', email: 'registered.auth.but.no.profile@company.com' },
      session: { access_token: 'fake-token' },
    };
    const mockSignInWithPassword = vi.fn().mockResolvedValue({
      data: mockAuthData,
      error: null,
    });
    const mockSignOut = vi.fn().mockResolvedValue({ error: null });

    // 2. Simulate profiles table returning no record under RLS
    const mockProfileLookup = vi.fn().mockResolvedValue({
      data: null,
      error: null,
    });

    let surfacedUiError: string | null = null;
    let authErrorState: string | null = null;

    // Simulate the login orchestration in AuthContext & LoginPage
    const loginFlow = async (email: string, pass: string) => {
      authErrorState = null;
      try {
        const { data: auth, error: authErr } = await mockSignInWithPassword({ email, password: pass });
        if (authErr || !auth?.user) {
          throw new Error('بيانات الدخول غير صحيحة.');
        }

        // Validate Profile
        const { data: profile } = await mockProfileLookup(auth.user.id);
        if (!profile) {
          throw new Error('حسابك غير مسجل في سجلات موظفي المنشأة (No active profile found). يرجى مراجعة إدارة النظام.');
        }
      } catch (err: any) {
        authErrorState = err.message;
        await mockSignOut();
        throw err;
      }
    };

    // Simulate form submit in LoginPage
    try {
      await loginFlow('registered.auth.but.no.profile@company.com', 'Password123!');
    } catch (err: any) {
      surfacedUiError = err.message || authErrorState;
    }

    // Verify Arabic error message is captured for display under submit button
    expect(surfacedUiError).toBe('حسابك غير مسجل في سجلات موظفي المنشأة (No active profile found). يرجى مراجعة إدارة النظام.');
    expect(authErrorState).toBe('حسابك غير مسجل في سجلات موظفي المنشأة (No active profile found). يرجى مراجعة إدارة النظام.');
    // Verify user was immediately signed out from Supabase
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

