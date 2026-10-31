import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, ShoppingCart, Receipt, Boxes, Landmark, Menu } from 'lucide-react';
import { cn } from '../../lib/utils';

export const MobileNav: React.FC<{ onOpenMore?: () => void }> = ({ onOpenMore }) => {
  const { t } = useTranslation();

  const navItems = [
    { to: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    { to: '/sales', labelKey: 'nav.sales', icon: ShoppingCart },
    { to: '/pos', labelKey: 'nav.pos', icon: Receipt },
    { to: '/inventory', labelKey: 'nav.inventory', icon: Boxes },
    { to: '/treasury', labelKey: 'nav.treasury', icon: Landmark },
  ];

  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-background/95 backdrop-blur-md border-t border-border flex items-center justify-around h-16 px-1 safe-area-pb">
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center justify-center flex-1 h-full min-h-[44px] min-w-[44px] gap-1 text-[10px] font-medium transition-colors select-none',
                isActive
                  ? 'text-primary font-bold'
                  : 'text-muted-foreground hover:text-foreground'
              )
            }
          >
            <Icon className="w-5 h-5" />
            <span className="truncate max-w-[64px]">{t(item.labelKey)}</span>
          </NavLink>
        );
      })}

      {/* More / Menu Drawer trigger */}
      <button
        onClick={onOpenMore}
        className="flex flex-col items-center justify-center flex-1 h-full min-h-[44px] min-w-[44px] gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors select-none"
        aria-label="المزيد من القوائم"
      >
        <Menu className="w-5 h-5" />
        <span>{t('nav.more')}</span>
      </button>
    </nav>
  );
};

