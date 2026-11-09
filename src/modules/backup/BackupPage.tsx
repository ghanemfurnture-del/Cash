import React, { useState, useEffect } from 'react';
import {
  DatabaseBackup,
  Download,
  Upload,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Layers,
} from 'lucide-react';
import {
  getPersistenceStatus,
  requestPersistentStorage,
} from '../../services/backup/persistenceService';
import {
  exportEncryptedBackup,
  downloadBackupFile,
} from '../../services/backup/backupService';
import {
  inspectBackupFile,
  executeRestore,
} from '../../services/backup/restoreService';
import type {
  PersistenceStatus,
  RestorePreview,
} from '../../services/backup/types';

const DevDataGenerator = import.meta.env.DEV
  ? React.lazy(() => import('../dev/DevDataGenerator').then((m) => ({ default: m.DevDataGenerator })))
  : null;

export const BackupPage: React.FC = () => {
  // Persistence state
  const [persistence, setPersistence] = useState<PersistenceStatus | null>(null);
  const [requestingPersist, setRequestingPersist] = useState(false);

  // Export state
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportStatusText, setExportStatusText] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  // Restore state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectStatusText, setInspectStatusText] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  // Preview Modal state
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmationInput, setConfirmationInput] = useState('');
  const [safetyExporting, setSafetyExporting] = useState(false);

  // Load persistence status
  const loadPersistence = async () => {
    const status = await getPersistenceStatus();
    setPersistence(status);
  };

  useEffect(() => {
    loadPersistence();
  }, []);

  const handleRequestPersist = async () => {
    setRequestingPersist(true);
    await requestPersistentStorage();
    await loadPersistence();
    setRequestingPersist(false);
  };

  // Handle Export
  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setExportError(null);
    setExportSuccess(null);

    if (!exportPassword) {
      setExportError('يرجى إدخال كلمة مرور لحماية ملف النسخة الاحتياطية.');
      return;
    }
    if (exportPassword.length < 6) {
      setExportError('يجب أن لا تقل كلمة المرور عن 6 خانات.');
      return;
    }
    if (exportPassword !== exportPasswordConfirm) {
      setExportError('كلمتا المرور غير متطابقتين.');
      return;
    }

    setExporting(true);
    setExportStatusText('جاري اشتقاق مفتاح التشفير (PBKDF2 - 600,000 دورة)...');
    try {
      // Yield to UI to render waiting indicator
      await new Promise((r) => setTimeout(r, 50));
      setExportStatusText('جاري تشفير وتجهيز ملف النسخة الاحتياطية (AES-256-GCM)...');
      const bytes = await exportEncryptedBackup(exportPassword);
      downloadBackupFile(bytes);
      setExportSuccess('تم إنشاء النسخة الاحتياطية وتشفيرها وتحميلها بنجاح.');
      // Zero-leakage: clear password from state immediately
      setExportPassword('');
      setExportPasswordConfirm('');
    } catch (err: any) {
      setExportError(err?.message || 'فشل تصدير النسخة الاحتياطية.');
    } finally {
      setExporting(false);
      setExportStatusText(null);
    }
  };

  // Handle Inspect & Preview
  const handleInspect = async (e: React.FormEvent) => {
    e.preventDefault();
    setRestoreError(null);
    setRestoreSuccess(null);

    if (!selectedFile) {
      setRestoreError('يرجى اختيار ملف النسخة الاحتياطية (.cashbak).');
      return;
    }
    if (!restorePassword) {
      setRestoreError('يرجى إدخال كلمة المرور لفك تشفير النسخة.');
      return;
    }

    setInspecting(true);
    setInspectStatusText('جاري اشتقاق المفتاح وفك التشفير (PBKDF2 - 600,000 دورة)...');
    try {
      await new Promise((r) => setTimeout(r, 50));
      setInspectStatusText('جاري التحقق من الترويسة وبنية المخطط...');
      const arrayBuffer = await selectedFile.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const previewData = await inspectBackupFile(bytes, restorePassword);
      setPreview(previewData);
      setConfirmationInput('');
      setRestorePassword(''); // zero-leakage
    } catch (err: any) {
      setRestoreError(err?.message || 'تعذر فحص ملف النسخة الاحتياطية.');
    } finally {
      setInspecting(false);
      setInspectStatusText(null);
    }
  };

  // Handle Safety Export before restore
  const handleSafetyExport = async () => {
    setSafetyExporting(true);
    try {
      // Export current local state with a random safety password or standard export
      const bytes = await exportEncryptedBackup('SafetyBackup123!');
      downloadBackupFile(bytes, `safety-backup-before-restore-${Date.now()}.cashbak`);
      alert('تم تصدير نسخة أمان محلية من حالتك الراهنة بنجاح.');
    } catch (err: any) {
      alert(`فشل تصدير نسخة الأمان: ${err?.message}`);
    } finally {
      setSafetyExporting(false);
    }
  };

  // Handle Execute Restore
  const handleExecuteRestore = async () => {
    if (!preview) return;

    if (
      preview.requiresExplicitConfirmation &&
      confirmationInput !== 'استبدال ومسح العمليات غير المزامنة'
    ) {
      setRestoreError('يرجى كتابة جملة التأكيد الصريحة بدقة للمتابعة.');
      return;
    }

    setRestoring(true);
    setRestoreError(null);

    try {
      await executeRestore(preview);
      setRestoreSuccess('تمت استعادة البيانات بنجاح وتحديث قاعدة البيانات المحلية.');
      setPreview(null);
      setSelectedFile(null);
      // Reload persistence and window after short delay
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err: any) {
      setRestoreError(err?.message || 'فشلت عملية الاستعادة.');
    } finally {
      setRestoring(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(1)} ميجابايت`;
    return `${(mb / 1024).toFixed(2)} جيجابايت`;
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2 text-foreground">
            <DatabaseBackup className="w-7 h-7 text-primary" />
            النسخ الاحتياطي والاستعادة واستدامة التخزين
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة النسخ الاحتياطية المشفرة (AES-256-GCM)، حماية البيانات دون اتصال، والتحقق من بقاء التخزين على أجهزة iOS.
          </p>
        </div>
      </div>

      {/* SECTION 1: Storage Persistence & iOS Status */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-primary" />
            <h2 className="font-semibold text-base">حالة استدامة التخزين المحلي (Storage Persistence)</h2>
          </div>
          {persistence && (
            <div className="flex items-center gap-2">
              {persistence.isPersisted ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  🟢 التخزين دائم ومحمي من الحذف
                  {persistence.isStandalone && ' (تطبيق PWA مثبت)'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  🟡 التخزين مؤقت (معرض لسياسة الحذف)
                </span>
              )}
            </div>
          )}
        </div>

        {persistence?.warningMessage && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-3 text-amber-800 dark:text-amber-200 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600 mt-0.5" />
            <div>
              <p className="font-medium">تنبيه لأجهزة iOS و Safari:</p>
              <p className="text-xs mt-0.5 opacity-90">{persistence.warningMessage}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          <div className="p-3 bg-muted/40 rounded-lg">
            <span className="text-xs text-muted-foreground block">المساحة المستخدمة حالياً</span>
            <span className="text-lg font-bold text-foreground">
              {persistence ? formatBytes(persistence.usageBytes) : '...'}
            </span>
          </div>
          <div className="p-3 bg-muted/40 rounded-lg">
            <span className="text-xs text-muted-foreground block">السعة التخزينية المتاحة</span>
            <span className="text-lg font-bold text-foreground">
              {persistence ? formatBytes(persistence.quotaBytes) : '...'}
            </span>
          </div>
          <div className="p-3 bg-muted/40 rounded-lg flex items-center justify-between">
            <div>
              <span className="text-xs text-muted-foreground block">طلب الاستدامة العتادية</span>
              <span className="text-xs font-medium">
                {persistence?.isPersisted ? 'ممنوحة بالفعل' : 'غير ممنوحة'}
              </span>
            </div>
            {!persistence?.isPersisted && (
              <button
                type="button"
                onClick={handleRequestPersist}
                disabled={requestingPersist}
                className="px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-lg hover:bg-primary/90 transition"
              >
                {requestingPersist ? 'جاري الطلب...' : 'تثبيت التخزين'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Grid: Export & Restore */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* SECTION 2: Encrypted Export */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center gap-2 border-b border-border pb-3 mb-4">
              <Download className="w-5 h-5 text-emerald-600" />
              <h2 className="font-bold text-base">1. تصدير نسخة مشفرة (.cashbak)</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              يتم تشفير كافة الجداول الـ 13 وصندوق الصادر (`outbox`) عتادياً بواسطة معيار `AES-256-GCM` مع اشتقاق المفتاح بـ `600,000` دورة PBKDF2. كلمة المرور لا تُسجل ولا تُخزن نهائياً.
            </p>

            <form onSubmit={handleExport} className="space-y-3 mt-4">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  كلمة مرور التشفير
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={exportPassword}
                    onChange={(e) => setExportPassword(e.target.value)}
                    placeholder="أدخل كلمة مرور قوية (6 خانات على الأقل)"
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary pl-9"
                  />
                  <Lock className="w-4 h-4 text-muted-foreground absolute left-3 top-2.5" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  تأكيد كلمة المرور
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={exportPasswordConfirm}
                    onChange={(e) => setExportPasswordConfirm(e.target.value)}
                    placeholder="أعد كتابة كلمة المرور للتأكيد"
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary pl-9"
                  />
                  <Lock className="w-4 h-4 text-muted-foreground absolute left-3 top-2.5" />
                </div>
              </div>

              {exportError && (
                <div className="p-2.5 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg">
                  {exportError}
                </div>
              )}
              {exportSuccess && (
                <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs rounded-lg flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  {exportSuccess}
                </div>
              )}

              <button
                type="submit"
                disabled={exporting}
                className="w-full mt-2 py-2 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-sm rounded-lg shadow-sm flex items-center justify-center gap-2 transition disabled:opacity-50"
              >
                {exporting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    {exportStatusText || 'جاري اشتقاق المفتاح والتصدير (600,000 دورة)...'}
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    تصدير وتحميل ملف النسخة الاحتياطية
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* SECTION 3: Encrypted Restore */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center gap-2 border-b border-border pb-3 mb-4">
              <Upload className="w-5 h-5 text-blue-600" />
              <h2 className="font-bold text-base">2. استعادة نسخة احتياطية مشفرة</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              تخضع النسخة لمعاينة مسبقة، وفحص سلامة الترويسة، والكشف التلقائي عن أي عمليات محلية غير مرفوعة لمنع فقدان البيانات، قبل إجراء الاستبدال الذري المحمي بلقطة الأمان.
            </p>

            <form onSubmit={handleInspect} className="space-y-3 mt-4">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  اختر ملف النسخة الاحتياطية (.cashbak)
                </label>
                <input
                  type="file"
                  accept=".cashbak,application/octet-stream"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer border border-input rounded-lg p-1 bg-background"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  كلمة مرور فك التشفير
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    placeholder="أدخل كلمة المرور الخاصة بالملف"
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary pl-9"
                  />
                  <Lock className="w-4 h-4 text-muted-foreground absolute left-3 top-2.5" />
                </div>
              </div>

              {restoreError && (
                <div className="p-2.5 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg">
                  {restoreError}
                </div>
              )}
              {restoreSuccess && (
                <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs rounded-lg flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  {restoreSuccess}
                </div>
              )}

              <button
                type="submit"
                disabled={inspecting || !selectedFile}
                className="w-full mt-2 py-2 px-4 bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-sm rounded-lg shadow-sm flex items-center justify-center gap-2 transition disabled:opacity-50"
              >
                {inspecting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    {inspectStatusText || 'جاري فك التشفير واشتقاق المفتاح (600,000 دورة)...'}
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    فحص ومعاينة النسخة الاحتياطية
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* SECTION 4: PREVIEW MODAL */}
      {preview && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-card border border-border rounded-xl shadow-xl max-w-3xl w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto animate-in fade-in-50 zoom-in-95">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2.5">
                <Layers className="w-6 h-6 text-primary" />
                <div>
                  <h3 className="font-bold text-lg text-foreground">معاينة محتويات النسخة الاحتياطية قبل التطبيق</h3>
                  <p className="text-xs text-muted-foreground">
                    تاريخ النسخة: {new Date(preview.metadata.backup_created_at).toLocaleString('ar-EG')} | كود الجهاز المصدر: {preview.metadata.source_device_code}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-muted-foreground hover:text-foreground text-sm font-semibold px-2 py-1"
              >
                ✕
              </button>
            </div>

            {/* UNSYNCED WORK ALERT (CRITICAL GUARANTEE) */}
            {preview.requiresExplicitConfirmation && (
              <div className="p-4 bg-destructive/10 border-2 border-destructive/40 rounded-xl space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-bold text-destructive text-sm">
                      تنبيه أمان حرج: تم اكتشاف عمليات ومستندات محلية غير مرفوعة للسيرفر!
                    </h4>
                    <p className="text-xs text-destructive/90 mt-1 leading-relaxed">
                      يحتوي جهازك حالياً على <strong>{preview.unsyncedWork.outboxCount}</strong> عملية معلقة في صندوق الصادر و <strong>{preview.unsyncedWork.unsyncedDocCount}</strong> مستند محلي لم يتم رفعها للسيرفر ولا توجد في ملف النسخة الاحتياطية. استبدال البيانات سيؤدي إلى مسح هذه العمليات نهائياً.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-destructive/20">
                  <button
                    type="button"
                    onClick={() => {
                      setPreview(null);
                      window.location.href = '/';
                    }}
                    className="px-3 py-1.5 bg-background text-foreground border border-input text-xs font-semibold rounded-lg hover:bg-accent transition"
                  >
                    1. مزامنة أولاً مع السيرفر
                  </button>
                  <button
                    type="button"
                    onClick={handleSafetyExport}
                    disabled={safetyExporting}
                    className="px-3 py-1.5 bg-destructive text-destructive-foreground text-xs font-semibold rounded-lg hover:bg-destructive/90 transition flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    2. تصدير نسخة أمان من البيانات المحلية الحالية فوراً
                  </button>
                </div>

                <div className="pt-2">
                  <label className="block text-xs font-medium text-destructive mb-1">
                    للمتابعة والاستبدال رغم ذلك، اكتب عبارة: <code className="bg-destructive/20 px-1 py-0.5 rounded font-mono">استبدال ومسح العمليات غير المزامنة</code>
                  </label>
                  <input
                    type="text"
                    value={confirmationInput}
                    onChange={(e) => setConfirmationInput(e.target.value)}
                    placeholder="اكتب العبارة بدقة هنا للتأكيد..."
                    className="w-full px-3 py-1.5 text-xs bg-background border border-destructive/40 rounded-lg focus:outline-none focus:ring-2 focus:ring-destructive font-mono"
                  />
                </div>
              </div>
            )}

            {/* Table Comparisons */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                مقارنة أعداد السجلات بين الجهاز الحالي والنسخة الاحتياطية:
              </h4>
              <div className="border border-border rounded-lg overflow-hidden max-h-56 overflow-y-auto">
                <table className="w-full text-xs text-right">
                  <thead className="bg-muted text-muted-foreground sticky top-0">
                    <tr>
                      <th className="p-2.5 font-semibold">اسم الجدول</th>
                      <th className="p-2.5 font-semibold">السجلات الحالية</th>
                      <th className="p-2.5 font-semibold">سجلات النسخة المستوردة</th>
                      <th className="p-2.5 font-semibold">الأثر المتوقع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.tableComparisons.map((c) => (
                      <tr key={c.table} className="hover:bg-muted/50">
                        <td className="p-2 font-mono">{c.table}</td>
                        <td className="p-2">{c.localCount}</td>
                        <td className="p-2 font-semibold text-primary">{c.backupCount}</td>
                        <td className="p-2 text-muted-foreground">
                          {c.backupCount > c.localCount ? (
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">+{c.backupCount - c.localCount} سجل</span>
                          ) : c.backupCount < c.localCount ? (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">{c.backupCount - c.localCount} سجل</span>
                          ) : (
                            'مطابق'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="px-4 py-2 border border-input bg-background hover:bg-accent text-sm font-medium rounded-lg transition"
              >
                إلغاء العملية (دون أي تغيير)
              </button>
              <button
                type="button"
                onClick={handleExecuteRestore}
                disabled={
                  restoring ||
                  (preview.requiresExplicitConfirmation &&
                    confirmationInput !== 'استبدال ومسح العمليات غير المزامنة')
                }
                className="px-5 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-bold rounded-lg shadow-sm flex items-center gap-2 transition disabled:opacity-40"
              >
                {restoring ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    جاري أخذ لقطة الأمان والاستبدال الذري...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    تأكيد وتنفيذ الاستعادة
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dev-Only Seed Data Tool (Strictly conditional on import.meta.env.DEV) */}
      {import.meta.env.DEV && DevDataGenerator && (
        <React.Suspense fallback={<div className="p-4 text-xs text-muted-foreground">جاري تحميل أداة التطوير...</div>}>
          <DevDataGenerator />
        </React.Suspense>
      )}
    </div>
  );
};
