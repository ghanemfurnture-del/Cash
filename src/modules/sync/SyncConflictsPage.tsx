import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  RefreshCw,
  Server,
  Smartphone,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';
import { ConflictService, isPostedRecord } from '../../services/sync/conflictService';
import type { SyncConflict } from '../../types/database';
import { useAuth } from '../../core/auth';

export const SyncConflictsPage: React.FC = () => {
  const { session } = useAuth();
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadConflicts = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const list = await ConflictService.getUnresolvedConflicts();
      setConflicts(list);
    } catch (err: any) {
      setErrorMsg(err?.message || 'تعذر تحميل سجلات التعارض.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConflicts();
  }, []);

  const handleServerWins = async (conflict: SyncConflict) => {
    setActionLoadingId(conflict.id);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      await ConflictService.resolveServerWins(conflict.id, session?.userId || 'user');
      setSuccessMsg(`تم اعتماد بيانات السيرفر بنجاح للسجل (${conflict.entity_id.slice(0, 8)}).`);
      await loadConflicts();
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل اعتماد بيانات السيرفر.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleLocalWins = async (conflict: SyncConflict) => {
    setActionLoadingId(conflict.id);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      await ConflictService.resolveLocalWins(conflict.id, session?.userId || 'user');
      setSuccessMsg(`تمت إعادة جدولة تطبيق التعديل المحلي بنسخة السيرفر المحدثة (${conflict.entity_id.slice(0, 8)}).`);
      await loadConflicts();
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل إعادة تطبيق التعديل المحلي.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const getEntityDisplayName = (entity: string): string => {
    switch (entity) {
      case 'documents':
        return 'فاتورة / مستند';
      case 'document_lines':
        return 'بند مستند';
      case 'items':
        return 'صنف / منتج';
      case 'parties':
        return 'عميل / مورد';
      case 'accounts':
        return 'حساب مالي';
      case 'journal_entries':
        return 'قيد يومية';
      case 'payments':
        return 'سند دفع / قبض';
      default:
        return entity;
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center font-bold">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">معالجة تعارضات المزامنة</h1>
              <p className="text-xs text-muted-foreground">
                مراجعة وحل الاختلافات بين التعديلات المحلية غير المزامنة والبيانات الواردة من السيرفر السحابي
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadConflicts}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>تحديث السجلات</span>
          </button>
        </div>
      </div>

      {/* Alert Banners */}
      {errorMsg && (
        <div className="p-3.5 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 rounded-2xl flex items-start gap-2.5 text-rose-800 dark:text-rose-200 text-xs">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3.5 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 rounded-2xl flex items-start gap-2.5 text-emerald-800 dark:text-emerald-200 text-xs">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Empty State */}
      {!loading && conflicts.length === 0 && (
        <div className="bg-card border border-border rounded-3xl p-10 text-center space-y-3 shadow-xs">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <h2 className="text-base font-bold text-foreground">لا توجد أي تعارضات معلقة في المزامنة</h2>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            كافة البيانات والسجلات المحلية متطابقة تماماً مع الخادم السحابي دون أي تضارب في النسخ.
          </p>
        </div>
      )}

      {/* Conflicts List */}
      <div className="space-y-4">
        {conflicts.map((conflict) => {
          const isPosted =
            isPostedRecord(conflict.server_payload) || isPostedRecord(conflict.local_payload);
          const isProcessing = actionLoadingId === conflict.id;

          return (
            <div
              key={conflict.id}
              className="bg-card border border-border rounded-2xl p-4 sm:p-5 shadow-xs space-y-4 transition-all"
            >
              {/* Conflict Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-500/10 text-amber-700 dark:text-amber-300">
                    {getEntityDisplayName(conflict.entity)}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">
                    ID: {conflict.entity_id}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {isPosted && (
                    <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                      <Lock className="w-3 h-3" />
                      <span>مستند معتمد (محمي من التعديل)</span>
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    توقيت النشوء: {new Date(conflict.created_at).toLocaleString('ar-EG')}
                  </span>
                </div>
              </div>

              {/* Side-by-Side Payload Comparison */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Local Side */}
                <div className="p-3.5 rounded-xl border border-sky-200 dark:border-sky-900 bg-sky-50/40 dark:bg-sky-950/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-sky-800 dark:text-sky-300 flex items-center gap-1.5">
                      <Smartphone className="w-3.5 h-3.5" />
                      <span>البيانات المحلية المعلقة (Local Draft)</span>
                    </span>
                    <span className="text-[11px] text-sky-600 dark:text-sky-400">
                      نسخة الأساس: {conflict.base_version ?? 1}
                    </span>
                  </div>

                  <div className="text-[11px] font-mono bg-background/80 p-2.5 rounded-lg border border-border/60 max-h-48 overflow-y-auto space-y-1">
                    {Object.entries(conflict.local_payload || {}).map(([k, v]) => (
                      <div key={k} className="flex justify-between border-b border-border/30 py-0.5">
                        <span className="text-muted-foreground">{k}:</span>
                        <span className="text-foreground font-semibold">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Server Side */}
                <div className="p-3.5 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                      <Server className="w-3.5 h-3.5" />
                      <span>بيانات السيرفر السحابي (Cloud Server)</span>
                    </span>
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      النسخة الحالية: {conflict.server_payload?.version ?? 1} (تسلسل: {conflict.server_payload?.server_seq ?? 0})
                    </span>
                  </div>

                  <div className="text-[11px] font-mono bg-background/80 p-2.5 rounded-lg border border-border/60 max-h-48 overflow-y-auto space-y-1">
                    {Object.entries(conflict.server_payload || {}).map(([k, v]) => (
                      <div key={k} className="flex justify-between border-b border-border/30 py-0.5">
                        <span className="text-muted-foreground">{k}:</span>
                        <span className="text-foreground font-semibold">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                <p className="text-[11px] text-muted-foreground">
                  {isPosted
                    ? 'هذا السجل معتمد في السيرفر ولا يمكن إعادة تطبيق التعديل المحلي فوقه. يجب اعتماد السيرفر.'
                    : 'اختر اعتماد نسخة السيرفر أو إعادة تطبيق التعديل المحلي بنسخة السيرفر الجديدة.'}
                </p>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {/* Action 1: Server Wins */}
                  <button
                    onClick={() => handleServerWins(conflict)}
                    disabled={isProcessing}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>اعتماد بيانات السيرفر (Server Wins)</span>
                  </button>

                  {/* Action 2: Local Wins */}
                  <button
                    onClick={() => handleLocalWins(conflict)}
                    disabled={isProcessing || isPosted}
                    title={isPosted ? 'لا يمكن تعديل مستند معتمد' : 'إعادة تطبيق التعديل برقم نسخة السيرفر'}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>إعادة تطبيق المحلي (Re-apply)</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
