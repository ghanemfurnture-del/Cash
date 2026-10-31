import React, { createContext, useContext, useEffect, useState } from 'react';
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
  currentBranch: Branch | null;
  switchBranch: (branchId: string) => Promise<void>;
  hasPermission: (module: string, action: string) => boolean;
  loginOffline: (email: string, pin?: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_STORAGE_KEY = 'cash_erp_cached_session';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);

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

  // Load cached session or seed default admin profile for initial development
  useEffect(() => {
    const initializeSession = async () => {
      try {
        const cached = localStorage.getItem(SESSION_STORAGE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as UserSession;
          setSession(parsed);
          setLoading(false);
          return;
        }

        // Initialize default admin branch and role if local database is empty
        const branchCount = await db.branches.count();
        if (branchCount === 0) {
          const mainBranch: Branch = {
            id: 'b1111111-1111-1111-1111-111111111111',
            code: 'MAIN',
            name_ar: 'الفرع الرئيسي - القاهرة',
            name_en: 'Main Branch - Cairo',
            is_main: true,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            server_seq: 1,
          };
          await db.branches.put(mainBranch);

          const adminRole: Role = {
            id: 'r1111111-1111-1111-1111-111111111111',
            name: 'Admin',
            description: 'مدير عام للنظام بكافة الصلاحيات',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            server_seq: 1,
          };
          await db.roles.put(adminRole);

          const adminProfile: Profile = {
            id: 'u1111111-1111-1111-1111-111111111111',
            full_name: 'مدير النظام (Admin)',
            role_id: adminRole.id,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            server_seq: 1,
          };
          await db.profiles.put(adminProfile);

          const defaultSession: UserSession = {
            userId: adminProfile.id,
            email: 'admin@cash.local',
            profile: adminProfile,
            role: adminRole,
            branches: [mainBranch],
            currentBranchId: mainBranch.id,
            isOfflineSession: true,
          };
          localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(defaultSession));
          setSession(defaultSession);
        }
      } catch (err) {
        console.error('Failed to initialize session:', err);
      } finally {
        setLoading(false);
      }
    };

    initializeSession();
  }, []);

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
    // Admins bypass all module checks
    if (session.role.name === 'Admin') return true;
    // Granular permissions will be queried from role_permissions table in Phase 2b
    return true;
  };

  const loginOffline = async (email: string, _pin?: string): Promise<boolean> => {
    // Look up profiles and branches from local Dexie database
    const profile = await db.profiles.toCollection().first();
    const role = profile?.role_id ? await db.roles.get(profile.role_id) : null;
    const branches = await db.branches.where('is_active').equals(1).toArray();

    if (profile && role) {
      const offlineSession: UserSession = {
        userId: profile.id,
        email,
        profile,
        role,
        branches,
        currentBranchId: branches[0]?.id || '',
        isOfflineSession: true,
      };
      setSession(offlineSession);
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(offlineSession));
      return true;
    }
    return false;
  };

  const logout = async () => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSession(null);
  };

  const currentBranch = session?.branches.find((b) => b.id === session.currentBranchId) || null;

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        currentBranch,
        switchBranch,
        hasPermission,
        loginOffline,
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
