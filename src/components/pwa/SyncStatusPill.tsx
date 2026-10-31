import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff, AlertTriangle, CloudOff, Info } from 'lucide-react';
import { OutboxRepository } from '../../db/outbox';
import { db } from '../../db';

export const SyncStatusPill: React.FC = () => {
  const { t } = useTranslation();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [counts, setCounts] = useState({ pending: 0, inFlight: 0, conflict: 0 });
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Poll outbox counts and last sync timestamp every 2 seconds
    const interval = setInterval(async () => {
      try {
        const c = await OutboxRepository.getCounts();
        setCounts(c);

        const lastSync = await db.sync_meta.get('last_sync_at');
        if (lastSync?.value) {
          setLastSyncTime(new Date(lastSync.value).toLocaleTimeString('ar-EG'));
        }
      } catch (e) {
        console.error('Error fetching outbox status:', e);
      }
    }, 2000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  // Offline State
  if (!isOnline) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800 select-none transition-colors"
        title={lastSyncTime ? `غير متصل - آخر مزامنة: ${lastSyncTime}` : 'النظام يعمل محلياً بالكامل دون اتصال'}
      >
        <WifiOff className="w-3.5 h-3.5" />
        <span>{t('sync.offline')}</span>
        {counts.pending > 0 && (
          <span className="bg-amber-200 dark:bg-amber-900 px-1.5 py-0.2 rounded-full font-bold">
            {counts.pending} معلق
          </span>
        )}
      </div>
    );
  }

  // Conflicts State
  if (counts.conflict > 0) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-rose-50 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800 select-none animate-pulse"
        title="يوجد تعارض في البيانات بحاجة إلى مراجعة"
      >
        <AlertTriangle className="w-3.5 h-3.5" />
        <span>{t('sync.conflicts', { count: counts.conflict })}</span>
      </div>
    );
  }

  // Honest Online State before Phase 2b Sync Engine
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700 select-none transition-colors"
      title={
        lastSyncTime
          ? `آخر مزامنة ناجحة: ${lastSyncTime}`
          : 'النظام متصل؛ محرك المزامنة السحابي التلقائي قيد التفعيل في المرحلة 2b'
      }
    >
      <CloudOff className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
      <span>متصل (المزامنة غير مفعلة بعد)</span>
      {counts.pending > 0 ? (
        <span className="bg-slate-200 dark:bg-slate-700 px-1.5 py-0.2 rounded-full font-bold text-[10px]">
          {counts.pending} محلي
        </span>
      ) : (
        <Info className="w-3 h-3 text-slate-400" />
      )}
    </div>
  );
};
