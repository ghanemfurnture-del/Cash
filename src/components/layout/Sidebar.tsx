import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  ShoppingCart,
  ShoppingBag,
  Boxes,
  Landmark,
  Scale,
  Receipt,
  Users2,
  Users,
  Briefcase,
  PieChart,
  FileSpreadsheet,
  Settings,
  ShieldAlert,
  DatabaseBackup,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../core/auth';

interface NavItem {
  to: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  module: string;
}

const navSections: { titleKey?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard, module: 'dashboard' },
    ],
  },
  {
    titleKey: 'العمليات التجارية واليومية',
    items: [
      { to: '/sales', labelKey: 'nav.sales', icon: ShoppingCart, module: 'sales' },
      { to: '/pos', labelKey: 'nav.pos', icon: Receipt, module: 'pos' },
      { to: '/purchases', labelKey: 'nav.purchases', icon: ShoppingBag, module: 'purchases' },
      { to: '/inventory', labelKey: 'nav.inventory', icon: Boxes, module: 'inventory' },
      { to: '/treasury', labelKey: 'nav.treasury', icon: Landmark, module: 'treasury' },
    ],
  },
  {
    titleKey: 'الأطراف والمحاسبة',
    items: [
      { to: '/parties', labelKey: 'nav.parties', icon: Users2, module: 'parties' },
      { to: '/accounting', labelKey: 'nav.accounting', icon: Scale, module: 'accounting' },
      { to: '/reports', labelKey: 'nav.reports', icon: FileSpreadsheet, module: 'reports' },
    ],
  },
  {
    titleKey: 'الموارد والأصول والضبط',
    items: [
      { to: '/hr', labelKey: 'nav.hr', icon: Users, module: 'hr' },
      { to: '/fixed-assets', labelKey: 'nav.fixed_assets', icon: Briefcase, module: 'fixed_assets' },
      { to: '/budgets', labelKey: 'nav.budgets', icon: PieChart, module: 'budgets' },
      { to: '/audit', labelKey: 'nav.audit', icon: ShieldAlert, module: 'audit' },
      { to: '/backup', labelKey: 'nav.backup', icon: DatabaseBackup, module: 'backup' },
      { to: '/settings', labelKey: 'nav.settings', icon: Settings, module: 'settings' },
    ],
  },
];

export const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();

  return (
    <aside className="hidden lg:flex flex-col w-64 border-e border-border bg-card/60 backdrop-blur-sm select-none shrink-0 h-[calc(100vh-3.5rem)] sticky top-14">
      {/* Brand & Badge */}
      <div className="p-4 border-b border-border/70 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg shadow-sm">
          خ
        </div>
        <div>
          <h2 className="font-bold text-sm text-foreground tracking-tight">نظام الخزينة</h2>
          <p className="text-[11px] text-muted-foreground">ERP غير متصل بالإنترنت</p>
        </div>
      </div>

      {/* Nav List */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {navSections.map((section, idx) => {
          // Filter items based on permissions
          const visibleItems = section.items.filter((item) => hasPermission(item.module, 'view'));
          if (visibleItems.length === 0) return null;

          return (
            <div key={idx} className="space-y-1">
              {section.titleKey && (
                <div className="px-3 py-1 text-[11px] font-semibold text-muted-foreground/70">
                  {section.titleKey}
                </div>
              )}
              {visibleItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground shadow-xs font-semibold'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/70'
                      )
                    }
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
};
