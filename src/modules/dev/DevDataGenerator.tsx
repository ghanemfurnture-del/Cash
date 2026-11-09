import React, { useState, useEffect } from 'react';
import { db } from '../../db';
import { OutboxRepository } from '../../db/outbox';
import { Beaker, Trash2, CheckCircle2, AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react';

export const DevDataGenerator: React.FC = () => {
  // STRICT GUARD: Must never render or execute in production builds
  if (!import.meta.env.DEV) {
    return null;
  }

  const [hasRealData, setHasRealData] = useState(false);
  const [includeOutbox, setIncludeOutbox] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  const checkExistingData = async () => {
    try {
      const docs = await db.documents.toArray();
      const realDocs = docs.filter((d: any) => !d.is_mock);
      const items = await db.items.toArray();
      const realItems = items.filter((i: any) => !i.is_mock);
      setHasRealData(realDocs.length > 0 || realItems.length > 0);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    checkExistingData();
  }, []);

  const handleGenerate = async () => {
    setMessage(null);
    if (hasRealData && confirmInput !== 'تأكيد توليد بيانات تجريبية') {
      setMessage({
        text: 'تحذير: توجد بيانات فعلية غير تجريبية في قاعدة البيانات! يُشترط كتابة عبارة التأكيد الصريحة لمتابعة التوليد.',
        type: 'error',
      });
      return;
    }

    setLoading(true);
    try {
      const branchId = 'dev-branch-d1';
      const uomId = 'dev-uom-pcs';
      const taxCodeId = 'dev-tax-v14';

      await db.transaction(
        'rw',
        [
          db.branches,
          db.accounts,
          db.units,
          db.tax_codes,
          db.items,
          db.parties,
          db.documents,
          db.document_lines,
          db.outbox,
          db.sync_meta,
        ],
        async () => {
          // 1. Branch
          await db.branches.put({
            id: branchId,
            code: 'CAI',
            name_ar: 'فرع المعادي التجريبي',
            is_main: true,
            is_active: true,
            version: 1,
            server_seq: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_mock: true,
          } as any);

          // 2. Units & Tax
          await db.units.put({
            id: uomId,
            code: 'PCS',
            name_ar: 'قطعة',
            is_active: true,
            version: 1,
            server_seq: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_mock: true,
          } as any);

          await db.tax_codes.put({
            id: taxCodeId,
            code: 'T1-V009',
            name_ar: 'ضريبة القيمة المضافة 14%',
            rate: 14,
            tax_type: 'T1',
            sub_type: 'V009',
            is_active: true,
            version: 1,
            server_seq: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_mock: true,
          } as any);

          // 3. Accounts
          const accounts = [
            { id: 'dev-acc-cash', code: '10101', name_ar: 'صندوق النقدية الرئيسي', type: 'asset', is_active: true },
            { id: 'dev-acc-sales', code: '40101', name_ar: 'إيرادات مبيعات عامة', type: 'revenue', is_active: true },
            { id: 'dev-acc-vat', code: '20201', name_ar: 'ضريبة القيمة المضافة مخرجات', type: 'liability', is_active: true },
            { id: 'dev-acc-ar', code: '10201', name_ar: 'العملاء والمدينون', type: 'asset', is_active: true },
          ];
          for (const acc of accounts) {
            await db.accounts.put({
              ...acc,
              version: 1,
              server_seq: 1,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_mock: true,
            } as any);
          }

          // 4. Items
          const items = [
            { id: 'dev-item-1', code: 'ITM-LAP', name: 'لابتوب ديل تجريبي', sale_price: 15000, cost_price: 12000 },
            { id: 'dev-item-2', code: 'ITM-MOU', name: 'ماوس لاسلكي تجريبي', sale_price: 450, cost_price: 300 },
          ];
          for (const item of items) {
            await db.items.put({
              ...item,
              unit_id: uomId,
              is_active: true,
              version: 1,
              server_seq: 1,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_mock: true,
            } as any);
          }

          // 5. Parties
          const parties = [
            { id: 'dev-party-1', code: 'CUS-01', name: 'شركة النيل للبرمجيات (B2B)', type: 'customer', tax_id: '123456789' },
            { id: 'dev-party-2', code: 'CUS-02', name: 'محمد علي أحمد (عميل نقدي B2C)', type: 'customer' },
          ];
          for (const party of parties) {
            await db.parties.put({
              ...party,
              is_active: true,
              version: 1,
              server_seq: 1,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_mock: true,
            } as any);
          }

          // 6. Generate 10 Documents (INV-D1-000001 to INV-D1-000010)
          for (let i = 1; i <= 10; i++) {
            const docId = `dev-doc-${String(i).padStart(3, '0')}`;
            const lineId = `dev-doc-line-${String(i).padStart(3, '0')}`;
            const seqNo = i;
            const docNo = `INV-D1-${String(seqNo).padStart(6, '0')}`;
            const isPosted = i <= 5;
            const subtotal = 1000 * i;
            const taxTotal = subtotal * 0.14;
            const total = subtotal + taxTotal;

            await db.documents.put({
              id: docId,
              doc_type: 'sale_invoice',
              series_code: 'D1',
              seq_no: seqNo,
              doc_no: docNo,
              doc_date: new Date().toISOString().slice(0, 10),
              party_id: i % 2 === 0 ? 'dev-party-1' : 'dev-party-2',
              branch_id: branchId,
              currency_code: 'EGP',
              exchange_rate: 1,
              subtotal,
              discount_total: 0,
              tax_total: taxTotal,
              total,
              status: isPosted ? 'posted' : 'draft',
              posted_at: isPosted ? new Date().toISOString() : null,
              notes: '[DEMO_MOCK_RECORD] فاتورة تجريبية لاختبار المنظومة',
              version: 1,
              server_seq: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_mock: true,
            } as any);

            await db.document_lines.put({
              id: lineId,
              document_id: docId,
              line_no: 1,
              item_id: i % 2 === 0 ? 'dev-item-1' : 'dev-item-2',
              item_name: i % 2 === 0 ? 'لابتوب ديل تجريبي' : 'ماوس لاسلكي تجريبي',
              quantity: i,
              unit_id: uomId,
              unit_price: 1000,
              tax_code_id: taxCodeId,
              tax_rate: 14,
              tax_amount: taxTotal,
              total,
              notes: 'بند تجريبي',
              version: 1,
              server_seq: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_mock: true,
            } as any);
          }

          // 7. Queue mock pending outbox operations (ONLY if explicitly enabled by user)
          if (includeOutbox) {
            for (let k = 8; k <= 10; k++) {
              const outboxDocId = `dev-doc-${String(k).padStart(3, '0')}`;
              await OutboxRepository.queueOperation({
                entity: 'documents',
                entity_id: outboxDocId,
                op: 'insert',
                payload: {
                  id: outboxDocId,
                  doc_no: `INV-D1-${String(k).padStart(6, '0')}`,
                  total: 1000 * k * 1.14,
                  is_mock: true,
                },
                user_id: 'dev-user-mock',
              });
            }
          }

          // 8. Update counter in sync_meta
          await db.sync_meta.put({
            key: 'counter:sale_invoice:D1',
            value: 10,
            updated_at: new Date().toISOString(),
          });
        }
      );

      setMessage({
        text: includeOutbox
          ? 'تم توليد البيانات التجريبية بنجاح: 10 فواتير (INV-D1-000001 إلى INV-D1-000010) و3 عمليات معلقة في صندوق الصادر.'
          : 'تم توليد البيانات التجريبية بنجاح: 10 فواتير محلية فقط (دون إرسال أو قيد عمليات في صندوق الصادر).',
        type: 'success',
      });
      setConfirmInput('');
      await checkExistingData();
    } catch (err: any) {
      setMessage({
        text: `فشل توليد البيانات التجريبية: ${err?.message || err}`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setMessage(null);
    setLoading(true);
    try {
      const tables = [
        db.documents,
        db.document_lines,
        db.items,
        db.parties,
        db.accounts,
        db.branches,
        db.units,
        db.tax_codes,
      ];

      for (const table of tables) {
        const records = await table.toArray();
        const mockRecords = records.filter((r: any) => r.is_mock);
        for (const m of mockRecords) {
          await table.delete(m.id);
        }
      }

      // Clear mock outbox
      const outboxOps = await db.outbox.toArray();
      const mockOutbox = outboxOps.filter((op) => (op.payload as any)?.is_mock);
      for (const op of mockOutbox) {
        await db.outbox.delete(op.id);
      }

      // Reset counter
      await db.sync_meta.delete('counter:sale_invoice:D1');

      setMessage({
        text: 'تم مسح كافة البيانات التجريبية الموسومة بنجاح من قاعدة البيانات المحلية.',
        type: 'info',
      });
      await checkExistingData();
    } catch (err: any) {
      setMessage({
        text: `فشل مسح البيانات التجريبية: ${err?.message || err}`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid="dev-data-generator"
      className="p-5 bg-amber-500/10 border-2 border-dashed border-amber-500/40 rounded-2xl space-y-4 my-6"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-bold text-sm">
          <Beaker className="w-5 h-5" />
          <span>أداة بيانات التطوير والاختبار التجريبية (Dev Only Seed Tool)</span>
        </div>
        <span className="text-[10px] bg-amber-500/20 text-amber-800 dark:text-amber-200 px-2 py-0.5 rounded-full font-mono">
          import.meta.env.DEV = true
        </span>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        تُنشئ هذه الأداة بيانات افتراضية محلية في Dexie دون إرسال أي حركة للسيرفر (فرع، أصناف، حسابات، عملاء، و10 فواتير برقم السلسلة INV-D1-000001 إلى 000010، وعمليات معلقة في outbox). كافة السجلات موسومة بـ <code>is_mock: true</code> لسهولة مسحها.
      </p>

      {message && (
        <div
          className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
              : message.type === 'error'
              ? 'bg-rose-500/10 text-rose-600 border border-rose-500/20'
              : 'bg-sky-500/10 text-sky-600 border border-sky-500/20'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : message.type === 'error' ? (
            <ShieldAlert className="w-4 h-4 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {hasRealData && (
        <div className="p-3 bg-card border border-amber-300 rounded-xl space-y-2">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>توجد بيانات غير تجريبية في النظام. لتأكيد التوليد فوقها، اكتب العبارة التالية:</span>
          </p>
          <p className="text-xs font-mono text-muted-foreground select-all bg-muted p-1 rounded">
            تأكيد توليد بيانات تجريبية
          </p>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="اكتب العبارة هنا للمتابعة..."
            className="w-full px-3 py-1.5 text-xs bg-background border border-input rounded-lg"
          />
        </div>
      )}

      {/* Outbox opt-in option with safety warning */}
      <div className="space-y-2 p-3 bg-background/60 rounded-xl border border-border">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            data-testid="dev-include-outbox-checkbox"
            checked={includeOutbox}
            onChange={(e) => setIncludeOutbox(e.target.checked)}
            className="w-4 h-4 rounded border-input text-amber-600 focus:ring-amber-500 cursor-pointer"
          />
          <span className="text-xs font-semibold text-foreground">
            تضمين عمليات المزامنة في Outbox
          </span>
        </label>
        {includeOutbox && (
          <div
            data-testid="dev-outbox-warning"
            className="p-2.5 bg-rose-500/15 border border-rose-500/30 rounded-lg flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs font-bold"
          >
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>تنبيه: سيتم إرسال البيانات التجريبية إلى سيرفر الإنتاج في المزامنة القادمة</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={loading || (hasRealData && confirmInput !== 'تأكيد توليد بيانات تجريبية')}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl shadow-xs flex items-center gap-2 transition disabled:opacity-50 cursor-pointer"
        >
          {loading ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Beaker className="w-3.5 h-3.5" />
          )}
          <span>توليد 10 فواتير وبيانات تجريبية</span>
        </button>

        <button
          type="button"
          onClick={handleClear}
          disabled={loading}
          className="px-4 py-2 border border-border bg-card hover:bg-muted text-rose-600 text-xs font-bold rounded-xl shadow-xs flex items-center gap-2 transition disabled:opacity-50 cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>مسح البيانات التجريبية فقط</span>
        </button>
      </div>
    </div>
  );
};
