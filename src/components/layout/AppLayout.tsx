import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { IosInstallDrawer } from '../pwa/IosInstallDrawer';

export const AppLayout: React.FC = () => {
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  return (
    <div className="min-h-screen bg-background flex flex-col antialiased">
      <Navbar onOpenCommandPalette={() => setShowCommandPalette(true)} />

      <div className="flex-1 flex w-full">
        <Sidebar />

        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 max-w-7xl mx-auto w-full">
          <Outlet />
        </main>
      </div>

      <MobileNav onOpenMore={() => {}} />
      <IosInstallDrawer />

      {/* Quick Command Palette Modal Placeholder */}
      {showCommandPalette && (
        <div
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs flex items-start justify-center pt-20 px-4 animate-in fade-in"
          onClick={() => setShowCommandPalette(false)}
        >
          <div
            className="w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border pb-2">
              <input
                autoFocus
                placeholder="ابحث عن أي شاشة أو مستند أو عميل... (اضغط Esc للإغلاق)"
                className="w-full bg-transparent text-sm text-foreground focus:outline-hidden placeholder:text-muted-foreground"
              />
            </div>
            <div className="py-2 text-xs text-muted-foreground space-y-1">
              <p className="font-semibold text-foreground">إجراءات سريعة:</p>
              <div className="p-2 hover:bg-muted rounded-lg cursor-pointer transition-colors">
                إنشاء فاتورة مبيعات جديدة (+ Sales Invoice)
              </div>
              <div className="p-2 hover:bg-muted rounded-lg cursor-pointer transition-colors">
                إضافة عميل أو مورد جديد (+ New Party)
              </div>
              <div className="p-2 hover:bg-muted rounded-lg cursor-pointer transition-colors">
                سند قبض نقدي جديد (+ Receipt Voucher)
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
