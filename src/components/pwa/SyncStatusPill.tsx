import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WifiOff, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { OutboxRepository } from '../../db/outbox';
import { db } from '../../db';
import { SyncEngine } from '../../services/sync/syncEngine';

export const SyncStatusPill: React.FC = () => {
  const { t } = useTranslation();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [counts, setCounts] = useState({ pending: 0, inFlight: 0, conflict: 0 });
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  const refreshCounts = async () => {
    try {
      const c = await OutboxRepository.getCounts();
      const conflictRecords = await db.sync_conflicts.filter((r) => !r.resolved_at).count();
      const maxConflicts = Math.max(c.conflict, conflictRecords);
      setCounts({ ...c, conflict: maxConflicts });

      const lastSync = await db.sync_meta.get('last_sync_timestamp');
      if (lastSync?.value) {
        setLastSyncTime(new Date(lastSync.value).toLocaleTimeString('ar-EG'));
      }
    } catch (e) {
      console.error('Error fetching outbox status:', e);
    }
  };

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    refreshCounts();
    const interval = setInterval(refreshCounts, 3000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  const handleManualSync = async () => {
    if (!isOnline || isSyncing) return;
    setIsSyncing(true);
    try {
      await SyncEngine.syncAll();
      await refreshCounts();
    } catch (err) {
      console.error('Manual sync failed:', err);
    } finally {
      setIsSyncing(false);
    }
  };

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
      <Link
        to="/sync-conflicts"
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-rose-50 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800 select-none animate-pulse hover:bg-rose-100 dark:hover:bg-rose-900/50 transition-colors cursor-pointer"
        title="يوجد تعارض في البيانات بحاجة إلى مراجعة في جدول التعارضات (انقر للمعالجة)"
      >
        <AlertTriangle className="w-3.5 h-3.5" />
        <span>{t('sync.conflicts', { count: counts.conflict })}</span>
      </Link>
    );
  }

  // Syncing State
  if (isSyncing || counts.inFlight > 0) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-sky-50 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800 select-none"
        title="جاري رفع وتحديث البيانات مع الخادم السحابي..."
      >
        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        <span>{t('sync.syncing')}</span>
      </div>
    );
  }

  // Pending Outbox State
  if (counts.pending > 0) {
    return (
      <button
        onClick={handleManualSync}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors cursor-pointer select-none"
        title="اضغط لبدء المزامنة الفورية مع السيرفر"
      >
        <RefreshCw className="w-3.5 h-3.5 text-amber-600" />
        <span>{t('sync.pending_count', { count: counts.pending })}</span>
      </button>
    );
  }

  // Fully Synced State
  return (
    <button
      onClick={handleManualSync}
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors cursor-pointer select-none"
      title={lastSyncTime ? `متصل ومزامن (آخر مزامنة: ${lastSyncTime}) - اضغط للمزامنة` : 'متصل ومزامن بالكامل مع السيرفر'}
    >
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
      <span>{t('sync.synced')}</span>
    </button>
  );
};
