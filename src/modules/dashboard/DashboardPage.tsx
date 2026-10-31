import React, { useEffect, useState } from 'react';
import {
  TrendingUp,
  Boxes,
  Users,
  CreditCard,
  PlusCircle,
  Building2,
  HardDrive
} from 'lucide-react';
import { useAuth } from '../../core/auth';
import { formatMoney } from '../../core/decimal';
import { db } from '../../db';

export const DashboardPage: React.FC = () => {
  const { currentBranch, session } = useAuth();
  const [businessTableCount, setBusinessTableCount] = useState<number>(0);

  useEffect(() => {
    // Exclude client-only synchronization tables (outbox, sync_meta) to show accurate business tables count
    const clientInternalTables = ['outbox', 'sync_meta'];
    const businessTables = db.tables.filter((t) => !clientInternalTables.includes(t.name));
    setBusinessTableCount(businessTables.length);
  }, []);

  return (
    <div className="space-y-6">
      {/* Hero Welcome & Branch Info Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-card border border-border/70 shadow-xs">
        <div className="space-y-1">
          <h1 className="text-xl font-bold text-foreground">
            مرحباً بك، {session?.profile.full_name}
          </h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Building2 className="w-3.5 h-3.5 text-primary" />
            <span>فرع العمل الحالي: </span>
            <span className="font-semibold text-foreground">
              {currentBranch?.name_ar || 'كافة الفروع'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs transition-colors cursor-pointer">
            <PlusCircle className="w-4 h-4" />
            <span>فاتورة مبيعات جديدة</span>
          </button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Sales */}
        <div className="p-4 rounded-2xl bg-card border border-border shadow-xs space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">مبيعات اليوم</span>
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {formatMoney(0)}
          </div>
          <p className="text-[11px] text-muted-foreground">0 فواتير مسجلة اليوم</p>
        </div>

        {/* Treasury */}
        <div className="p-4 rounded-2xl bg-card border border-border shadow-xs space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">الخزينة والبنوك</span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CreditCard className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {formatMoney(0)}
          </div>
          <p className="text-[11px] text-muted-foreground">الرصيد النقدي المتاح</p>
        </div>

        {/* Receivables */}
        <div className="p-4 rounded-2xl bg-card border border-border shadow-xs space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">مستحقات العملاء</span>
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {formatMoney(0)}
          </div>
          <p className="text-[11px] text-muted-foreground">إجمالي الديون المستحقة</p>
        </div>

        {/* Inventory Value */}
        <div className="p-4 rounded-2xl bg-card border border-border shadow-xs space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">تقييم المخزون</span>
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Boxes className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {formatMoney(0)}
          </div>
          <p className="text-[11px] text-muted-foreground">بالتكلفة المرجحة (WAC)</p>
        </div>
      </div>

      {/* Offline Status & Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 p-5 rounded-2xl bg-card border border-border shadow-xs space-y-4">
          <h3 className="font-bold text-sm text-foreground">الوصول السريع للعمليات الأساسية</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-xl border border-border/80 hover:border-primary hover:bg-muted/40 transition-colors cursor-pointer space-y-1">
              <Boxes className="w-5 h-5 text-emerald-600" />
              <p className="text-xs font-semibold text-foreground">إدارة الأصناف</p>
              <p className="text-[10px] text-muted-foreground">تعديل الأسعار والباركود</p>
            </div>
            <div className="p-3.5 rounded-xl border border-border/80 hover:border-primary hover:bg-muted/40 transition-colors cursor-pointer space-y-1">
              <CreditCard className="w-5 h-5 text-blue-600" />
              <p className="text-xs font-semibold text-foreground">سندات الخزينة</p>
              <p className="text-[10px] text-muted-foreground">تسجيل سداد نقدي أو بنكي</p>
            </div>
            <div className="p-3.5 rounded-xl border border-border/80 hover:border-primary hover:bg-muted/40 transition-colors cursor-pointer space-y-1">
              <Users className="w-5 h-5 text-primary" />
              <p className="text-xs font-semibold text-foreground">دليل الأطراف</p>
              <p className="text-[10px] text-muted-foreground">إدارة العملاء والموردين</p>
            </div>
          </div>
        </div>

        {/* System Integrity & Offline Engine Card */}
        <div className="p-5 rounded-2xl bg-card border border-border shadow-xs space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-primary" />
            <h3 className="font-bold text-sm text-foreground">محرك العمل غير المتصل (IndexedDB)</h3>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            يعمل النظام محلياً عبر قاعدة بيانات IndexedDB بالمتصفح، مع جاهزية كاملة لحفظ الفواتير والقيود محلياً.
          </p>
          <div className="pt-2 border-t border-border/60 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">جداول الأعمال المنعكسة محلياً:</span>
            <span className="font-bold text-primary tabular-nums">
              {businessTableCount > 0 ? `${businessTableCount} جدولاً (مستبعداً outbox و sync_meta)` : 'جارِ الفحص...'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
