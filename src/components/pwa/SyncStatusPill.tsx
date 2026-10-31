import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wifi, WifiOff, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { OutboxRepository } from '../../db/outbox';

export const SyncStatusPill: React.FC = () => {
  const { t } = useTranslation();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [counts, setCounts] = useState({ pending: 0, inFlight: 0, conflict: 0 });

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Poll outbox counts every 2 seconds
    const interval = setInterval(async () => {
      try {
        const c = await OutboxRepository.getCounts();
        setCounts(c);
      } catch (e) {
        console.error('Error fetching outbox counts:', e);
      }
    }, 2000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  if (!isOnline) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800 select-none transition-colors"
        title="النظام يعمل محلياً بالكامل دون إنترنت"
      >
        <WifiOff className="w-3.5 h-3.5" />
        <span>{t('sync.offline')}</span>
        {counts.pending > 0 && (
          <span className="bg-amber-200 dark:bg-amber-900 px-1.5 py-0.2 rounded-full font-bold">
            {counts.pending}
          </span>
        )}
      </div>
    );
  }

  if (counts.conflict > 0) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-rose-50 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800 select-none animate-pulse"
        title="يوجد تعارض بحاجة إلى المراجعة"
      >
        <AlertTriangle className="w-3.5 h-3.5" />
        <span>{t('sync.conflicts', { count: counts.conflict })}</span>
      </div>
    );
  }

  if (counts.inFlight > 0) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800 select-none">
        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        <span>{t('sync.syncing')}</span>
      </div>
    );
  }

  if (counts.pending > 0) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800 select-none">
        <Wifi className="w-3.5 h-3.5 text-blue-600" />
        <span>{t('sync.pending_count', { count: counts.pending })}</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 select-none transition-colors"
      title="كافة البيانات متزامنة مع السحابة"
    >
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
      <span>{t('sync.synced')}</span>
    </div>
  );
};

