import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase, IS_DEV_MOCK_AUTH_ENABLED } from '../../lib/supabase';
import { db } from '../../db';
import type { Profile, Role, Branch } from '../../types/database';

export interface UserSession {
  userId: string;
  email: string;
  profile: Profile;
  role: Role;
  branches: Branch[];
  currentBranchId: string;
  isOfflineSession: boolean;
}

interface AuthContextType {
  session: UserSession | null;
  loading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  currentBranch: Branch | null;
  switchBranch: (branchId: string) => Promise<void>;
  hasPermission: (module: string, action: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_STORAGE_KEY = 'cash_erp_validated_session';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const clearAuthError = () => setAuthError(null);

  // Request Persistent Storage on Mount (PWA Offline Safety)
  useEffect(() => {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((persistent) => {
        if (!persistent) {
          console.warn('Storage persistence not granted by browser.');
        }
      });
    }
  }, []);

  // Initialize Session: Load cached session for offline resilience, or check Supabase session
  useEffect(() => {
    const initAuth = async () => {
      try {
        // 1. Check if we have a cached validated session in storage
        const cached = localStorage.getItem(SESSION_STORAGE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as UserSession;
          setSession(parsed);
        }

        // 2. If online and not dev mock, check real Supabase auth session
        if (!IS_DEV_MOCK_AUTH_ENABLED && navigator.onLine) {
          const { data: { session: sbSession } } = await supabase.auth.getSession();
          if (sbSession?.user) {
            await loadAndValidateUserProfile(sbSession.user.id, sbSession.user.email || '');
          } else if (!cached) {
            setSession(null);
          }
        }
      } catch (err: any) {
        console.error('Failed to initialize session:', err);
      } finally {
        setLoading(false);
      }
    };

    initAuth();

    // Listen to Supabase Auth state changes when online
    if (!IS_DEV_MOCK_AUTH_ENABLED) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, sbSession) => {
        if (event === 'SIGNED_IN' && sbSession?.user) {
          try {
            await loadAndValidateUserProfile(sbSession.user.id, sbSession.user.email || '');
          } catch (err: any) {
            const rejectionMsg = err?.message || 'هذا المستخدم غير مسجل في شركة أو حسابه غير نشط...';
            console.error('Profile validation failed on auth change:', rejectionMsg);
            setAuthError(rejectionMsg);
            await supabase.auth.signOut();
            setSession(null);
            localStorage.removeItem(SESSION_STORAGE_KEY);
          }
        } else if (event === 'SIGNED_OUT') {
          setSession(null);
          localStorage.removeItem(SESSION_STORAGE_KEY);
        }
      });

      return () => {
        subscription.unsubscribe();
      };
    }
  }, []);

  /**
   * Loads profile, role, and branches from Supabase under 003 RLS policies.
   * STRICT ENFORCEMENT: Denies access if the user has no active profile in the company.
   */
  const loadAndValidateUserProfile = async (userId: string, email: string): Promise<UserSession> => {
    // 1. Fetch Profile (RLS: id = auth.uid() or is_admin())
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (profileError || !profile) {
      throw new Error('حسابك غير مسجل في سجلات موظفي المنشأة (No active profile found). يرجى مراجعة إدارة النظام.');
    }

    if (!profile.is_active) {
      throw new Error('تم تعطيل حساب الموظف الخاص بك. يرجى التواصل مع إدارة الموارد البشرية.');
    }

    // 2. Fetch Role (RLS: authenticated users can read roles)
    let role: Role = {
      id: profile.role_id || 'viewer-role',
      name: 'Viewer',
      description: 'مستعرض',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 1,
    };

    if (profile.role_id) {
      const { data: roleData, error: roleError } = await supabase
        .from('roles')
        .select('*')
        .eq('id', profile.role_id)
        .maybeSingle();

      if (!roleError && roleData) {
        role = roleData as Role;
      }
    }

    // 3. Fetch Branches (RLS: assigned branches or main/admin)
    let branches: Branch[] = [];
    if (role.name === 'Admin') {
      const { data: allBranches } = await supabase
        .from('branches')
        .select('*')
        .eq('is_active', true);
      branches = (allBranches as Branch[]) || [];
    } else {
      const { data: assigned } = await supabase
        .from('user_branches')
        .select('branch_id, branches(*)')
        .eq('user_id', userId);

      if (assigned && assigned.length > 0) {
        branches = assigned.map((row: any) => row.branches).filter(Boolean);
      }
    }

    // Fallback if company has single main branch
    if (branches.length === 0) {
      const { data: mainBranch } = await supabase
        .from('branches')
        .select('*')
        .eq('is_main', true)
        .maybeSingle();
      if (mainBranch) branches = [mainBranch as Branch];
    }

    const currentBranchId = branches[0]?.id || '';

    const newSession: UserSession = {
      userId,
      email,
      profile: profile as Profile,
      role,
      branches,
      currentBranchId,
      isOfflineSession: !navigator.onLine,
    };

    // Cache locally for offline availability
    setSession(newSession);
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));

    // Also mirror to Dexie
    await db.profiles.put(profile as Profile);
    await db.roles.put(role);
    for (const b of branches) {
      await db.branches.put(b);
    }

    return newSession;
  };

  /**
   * Real Supabase Authentication (Email + Password)
   * With explicit dev mock fallback ONLY when VITE_ENABLE_DEV_MOCK_AUTH === 'true'
   */
  const login = async (email: string, password: string): Promise<void> => {
    setLoading(true);
    setAuthError(null);

    try {
      // DEV MOCK ONLY (Off by default; requires VITE_ENABLE_DEV_MOCK_AUTH=true in .env.local)
      if (IS_DEV_MOCK_AUTH_ENABLED) {
        const mockProfile: Profile = {
          id: '00000000-0000-0000-0000-000000000001',
          full_name: 'مدير النظام (Dev Mock)',
          role_id: '00000000-0000-0000-0000-000000000002',
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          server_seq: 1,
        };
        const mockRole: Role = {
          id: '00000000-0000-0000-0000-000000000002',
          name: 'Admin',
          description: 'مدير عام',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          server_seq: 1,
        };
        const mockBranch: Branch = {
          id: '00000000-0000-0000-0000-000000000003',
          code: 'MAIN',
          name_ar: 'الفرع الرئيسي',
          is_main: true,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          server_seq: 1,
        };
        const mockSession: UserSession = {
          userId: mockProfile.id,
          email,
          profile: mockProfile,
          role: mockRole,
          branches: [mockBranch],
          currentBranchId: mockBranch.id,
          isOfflineSession: true,
        };
        setSession(mockSession);
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(mockSession));
        return;
      }

      // REAL SUPABASE AUTH (Email + Password)
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError || !authData.user) {
        const msg = authError?.message || '';
        if (msg.toLowerCase().includes('invalid login credentials') || msg.toLowerCase().includes('invalid grant')) {
          throw new Error('بيانات الدخول غير صحيحة. يرجى التأكد من البريد الإلكتروني وكلمة المرور.');
        } else if (msg.toLowerCase().includes('email not confirmed')) {
          throw new Error('البريد الإلكتروني لم يتم تأكيده بعد. يرجى تفعيل الحساب من رابط البريد.');
        } else if (msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('network')) {
          throw new Error('تعذر الاتصال بخادم المصادقة. يرجى التحقق من اتصالك بالإنترنت.');
        }
        throw new Error(authError?.message || 'تعذر تسجيل الدخول بالبيانات المدخلة.');
      }

      // Load Profile & Roles under RLS policies
      await loadAndValidateUserProfile(authData.user.id, authData.user.email || email);
    } catch (err: any) {
      const msg = err?.message || 'تعذر تسجيل الدخول بالبيانات المدخلة.';
      setAuthError(msg);
      // In case of profile validation failure, sign out from Supabase auth
      if (!IS_DEV_MOCK_AUTH_ENABLED) {
        try {
          await supabase.auth.signOut();
        } catch {
          // ignore signout errors
        }
      }
      setSession(null);
      localStorage.removeItem(SESSION_STORAGE_KEY);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const switchBranch = async (branchId: string) => {
    if (!session) return;
    const branch = session.branches.find((b) => b.id === branchId);
    if (!branch) return;

    const updated = { ...session, currentBranchId: branchId };
    setSession(updated);
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(updated));
  };

  const hasPermission = (_module: string, _action: string) => {
    if (!session) return false;
    if (session.role.name === 'Admin') return true;
    return true;
  };

  const logout = async () => {
    if (!IS_DEV_MOCK_AUTH_ENABLED) {
      await supabase.auth.signOut();
    }
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSession(null);
  };

  const currentBranch = session?.branches.find((b) => b.id === session.currentBranchId) || null;

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        authError,
        clearAuthError,
        currentBranch,
        switchBranch,
        hasPermission,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
