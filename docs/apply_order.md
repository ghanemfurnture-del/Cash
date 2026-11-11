# ترتيب تطبيق الهجرات ونشر الدوال على `cash-dev` (Apply Order)

> **قاعدة حاكمة:** الهجرات [`001`](file:///e:/cash/supabase/migrations/001_core_schema.sql) إلى [`008`](file:///e:/cash/supabase/migrations/008_sync_push_document_hardening.sql) ثابتة وممنوع تعديلها. كل مسودة جديدة في `supabase/migrations_draft/` لا تتجاوز `14,000` حرف ويُرفق بها اختبار SQL ذاتي الإلغاء يطبع النتائج عبر `RAISE EXCEPTION`.

---

## 1. الهجرات الأساسية المعتمدة (Baseline `001` – `008`)

| الترتيب | الملف | الاختبار المرافق | الحالة |
| :---: | :--- | :--- | :--- |
| 1–7 | `001_core_schema.sql` .. `007_sync_engine_rpcs.sql` | `rls_and_ledger_validation_test.sql`, `sync_engine_validation_test.sql` | مطبقة على `cash-dev` |
| 8 | [`008_sync_push_document_hardening.sql`](file:///e:/cash/supabase/migrations/008_sync_push_document_hardening.sql) | [`migration_008_validation_test.sql`](file:///e:/cash/supabase/tests/migration_008_validation_test.sql) | مجهزة (تُطبّق أولاً على `cash-dev` قبل مسودات المرحلة H+) |

---

## 2. مسودات التصليب والنواة (Draft Migrations `009a` – `012`)

| الترتيب | ملف المسودة | يسبقه (تحقق / اختبار) | يليه (اختبار تحقق) | الاعتمادية |
| :---: | :--- | :--- | :--- | :--- |
| **9أ** | `supabase/migrations_draft/009a_posted_children_and_period_hardening_draft.sql` *(تُنشأ في H3)* | `draft_hardening_posted_children_test.sql` + استعلام فحص تداخل `fiscal_periods` داخل التعليق | `draft_hardening_apply_and_test.sql` | `001`, `002`, `005` |
| **9ب** | `supabase/migrations_draft/009b_disable_standalone_journal_sync_draft.sql` *(تُنشأ في H3)* | مراجعة ألا توجد عمليات معلقة منفردة لـ `journal_*` في `outbox` | `draft_009b_journal_bundle_only_test.sql` | `007`, `008`, `009a` |
| **10** | [`supabase/migrations_draft/010_core_ledger_helpers_draft.sql`](file:///e:/cash/supabase/migrations_draft/010_core_ledger_helpers_draft.sql) | `009a`, `009b` | `draft_010a_ledger_validation_test.sql`, `draft_010b_ledger_reversal_test.sql` | `001`, `005`, `009a` |
| **11** | [`supabase/migrations_draft/011_eta_readiness.sql`](file:///e:/cash/supabase/migrations_draft/011_eta_readiness.sql) *(تجهيز المرحلة 4)* | اكتمال هجرات المرحلة 3ب | اختبارات ETA المرحلة 4 | `001`–`010` |
| **12** | [`supabase/migrations_draft/012_seed_tax_defaults_draft.sql`](file:///e:/cash/supabase/migrations_draft/012_seed_tax_defaults_draft.sql) *(تجهيز المرحلة 4)* | تطبيق `011_eta_readiness.sql` | تحقق جدول `tax_codes` (`VAT-14`, `VAT-0-EXP`, وبقية النسب معطلة) | `011` |

*(سيتم تحديث هذا الملف فوراً مع كل هجرة جديدة تُضاف في المراحل 3أ، 3ب، 4–12، وإضافة أوامر نشر `sync-push` Edge Function عند تعديل `validator.ts`/`index.ts`.)*
