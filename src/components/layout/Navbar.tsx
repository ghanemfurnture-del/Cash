import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  Search,
  Languages,
  Moon,
  Sun,
  LogOut,
  User as UserIcon,
  ChevronDown
} from 'lucide-react';
import { useAuth } from '../../core/auth';
import { SyncStatusPill } from '../pwa/SyncStatusPill';

export const Navbar: React.FC<{ onOpenCommandPalette?: () => void }> = ({ onOpenCommandPalette }) => {
  const { t, i18n } = useTranslation();
  const { session, currentBranch, switchBranch, logout } = useAuth();
  const [isDark, setIsDark] = React.useState(document.documentElement.classList.contains('dark'));
  const [showBranchMenu, setShowBranchMenu] = React.useState(false);
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  const toggleTheme = () => {
    if (isDark) {
      document.documentElement.classList.remove('dark');
      setIsDark(false);
    } else {
      document.documentElement.classList.add('dark');
      setIsDark(true);
    }
  };

  const toggleLanguage = () => {
    const nextLng = i18n.language === 'ar' ? 'en' : 'ar';
    i18n.changeLanguage(nextLng);
  };

  return (
    <header className="sticky top-0 z-40 w-full h-14 bg-background/90 backdrop-blur-md border-b border-border px-4 flex items-center justify-between gap-3">
      {/* Search / Command Palette (Ctrl+K) */}
      <div className="flex items-center gap-3 flex-1 max-w-md">
        <button
          onClick={onOpenCommandPalette}
          className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground bg-muted/60 hover:bg-muted border border-border/80 rounded-lg transition-colors group"
        >
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 group-hover:text-foreground transition-colors" />
            <span>{t('common.search')} (العملاء، الفواتير، الأصناف...)</span>
          </div>
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] bg-background border border-border rounded font-mono shadow-xs">
            Ctrl + K
          </kbd>
        </button>
      </div>

      {/* Right Controls: Branch switcher, Sync pill, Theme, Language, User */}
      <div className="flex items-center gap-2">
        {/* Branch Switcher */}
        {session && session.branches.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setShowBranchMenu(!showBranchMenu)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-muted/50 hover:bg-muted border border-border rounded-lg transition-colors"
            >
              <Building2 className="w-3.5 h-3.5 text-primary" />
              <span className="hidden md:inline-block max-w-[130px] truncate">
                {currentBranch?.name_ar || t('branch.current')}
              </span>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>

            {showBranchMenu && (
              <div
                className="absolute end-0 mt-1.5 w-48 bg-card border border-border rounded-xl shadow-lg p-1 z-50 animate-in fade-in-50"
                onClick={() => setShowBranchMenu(false)}
              >
                <div className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground border-b border-border/60">
                  {t('branch.switch')}
                </div>
                {session.branches.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => switchBranch(b.id)}
                    className={`w-full text-start px-2 py-1.5 text-xs rounded-lg transition-colors flex items-center justify-between ${
                      b.id === currentBranch?.id
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-muted text-foreground'
                    }`}
                  >
                    <span className="truncate">{b.name_ar}</span>
                    {b.is_main && (
                      <span className="text-[10px] px-1 py-0.2 bg-muted rounded text-muted-foreground">
                        رئيسي
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Sync Status Indicator */}
        <SyncStatusPill />

        {/* Language Toggle */}
        <button
          onClick={toggleLanguage}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="تبديل اللغة (العربية / English)"
        >
          <Languages className="w-4 h-4" />
        </button>

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="الوضع المظلم / الفاتح"
        >
          {isDark ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* User Profile Menu */}
        {session && (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-1.5 p-1 rounded-full border border-border bg-muted/40 hover:bg-muted transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-xs">
                {session.profile.full_name.charAt(0) || <UserIcon className="w-4 h-4" />}
              </div>
            </button>

            {showUserMenu && (
              <div
                className="absolute end-0 mt-1.5 w-48 bg-card border border-border rounded-xl shadow-lg p-1 z-50 animate-in fade-in-50"
                onClick={() => setShowUserMenu(false)}
              >
                <div className="px-3 py-2 border-b border-border/60">
                  <p className="text-xs font-semibold text-foreground truncate">{session.profile.full_name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{session.role.name}</p>
                </div>
                <button
                  onClick={logout}
                  className="w-full text-start flex items-center gap-2 px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition-colors mt-1"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{t('auth.logout')}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
};

