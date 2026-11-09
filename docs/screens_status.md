# حالة شاشات ومسارات التطبيق (Screens & Routes Status)
# Cash ERP - Application Navigation & Realization Matrix

> تاريخ التحديث: 2026-11-04  
> يوضح هذا الجدول حالة كافة الشاشات والمسارات المسجلة في `src/app/routes.tsx` والشريط الجانبي `src/components/layout/Sidebar.tsx`، مبيناً الشاشات الفعلية الحية وتلك التي لا تزال في حالة مسودة/قريباً (Placeholder).

---

| المسار (Route Path) | اسم الشاشة | الحالة الحالية | المرحلة المخصصة | الجداول والخدمات التي تعتمد عليها |
| :--- | :--- | :---: | :---: | :--- |
| `/` | **لوحة التحكم والمؤشرات (Dashboard)** | 🟢 **شاشة فعلية حية** | مكتملة ومحدثة | `db.documents`, `db.outbox`, `db.sync_meta`, `useAuth`, `SyncStatusPill` |
| `/backup` | **النسخ الاحتياطي والاستعادة واستدامة التخزين** | 🟢 **شاشة فعلية حية** | Phase 2b-3b | `backupService`, `restoreService`, `persistenceService`, `DevDataGenerator`, Web Crypto AES-256-GCM |
| `/sync-conflicts` | **معالجة تعارضات المزامنة** | 🟢 **شاشة فعلية حية** | Phase 2c | `ConflictService`, `db.sync_conflicts`, `db.outbox`, `db.items`, `db.documents`, `useAuth` |
| `/accounting` | **المحاسبة العامة ودفتر الأستاذ** | 🟡 مسودة (Placeholder) | المرحلة 3 | `accounts`, `journal_entries`, `journal_lines`, `fiscal_years`, `fiscal_periods` |
| `/sales` | **إدارة المبيعات والعملاء** | 🟡 مسودة (Placeholder) | المرحلة 4 | `documents`, `document_lines`, `parties`, `tax_codes` |
| `/parties` | **دليل العملاء والموردين** | 🟡 مسودة (Placeholder) | المرحلة 4 | `parties`, `user_branches` |
| `/purchases` | **إدارة المشتريات والموردين** | 🟡 مسودة (Placeholder) | المرحلة 5 | `documents`, `document_lines`, `parties`, `warehouses` |
| `/inventory` | **إدارة المستودعات والمخزون** | 🟡 مسودة (Placeholder) | المرحلة 6 | `items`, `warehouses`, `stock_movements`, `units` |
| `/treasury` | **الخزينة والبنوك والشيكات** | 🟡 مسودة (Placeholder) | المرحلة 7 | `treasury_accounts`, `payments`, `cheques`, `bank_reconciliations` |
| `/pos` | **نقطة البيع السريعة (POS)** | ⚪ قريباً (Coming Soon) | المرحلة 8 | `pos_terminals`, `pos_shifts`, `pos_cash_movements`, `eReceipt` |
| `/fixed-assets` | **إدارة الأصول الثابتة** | ⚪ قريباً (Coming Soon) | المرحلة 9 | `fixed_assets`, `asset_categories`, `depreciation_runs` |
| `/hr` | **الموارد البشرية والرواتب** | ⚪ قريباً (Coming Soon) | المرحلة 10 | `employees`, `departments`, `payroll_runs`, `payslips` |
| `/budgets` | **الموازنات التقديرية والتكاليف** | ⚪ قريباً (Coming Soon) | المرحلة 11 | `budgets`, `budget_lines`, `cost_centers` |
| `/reports` | **التقارير المالية والتحليلية** | 🟡 مسودة (Placeholder) | المرحلة 12 | كافة جداول دفتر الأستاذ والمبيعات والمخزون |
| `/audit` | **سجل التدقيق والمراجعة** | 🟡 مسودة (Placeholder) | متقدمة | `audit_log`, `sync_ops` |
| `/settings` | **إعدادات النظام والفروع والضرائب** | 🟡 مسودة (Placeholder) | متقدمة | `company_settings`, `branches`, `tax_codes`, `currencies` |

---

## ملاحظات الربط البرمجي:
- الشاشات الموسومة بـ 🟢 هي شاشات كاملة برمجياً بواجهاتها واختباراتها المؤتمتة وتعتمد على IndexedDB و Dexie وتعمل أوفلاين.
- الشاشات الموسومة بـ 🟡 و ⚪ تستخدم المكون الموحد `ModulePlaceholder` لعرض ملخص نطاق المرحلة القادمة وتمنع حدوث أخطاء 404 للمستخدم.

