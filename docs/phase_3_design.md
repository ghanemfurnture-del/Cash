# التصميم المعماري للمرحلة 3: النواة المحاسبية ودفتر الأستاذ العام
# Phase 3 Architecture Design: Core Ledger & Double-Entry Engine

> **حالة الوثيقة:** مسودة تصميم هندسي للمرحلة 3 (Design Specification - Draft).  
> **الهدف:** توثيق قواعد توليد قيود اليومية المزدوجة عبر مفاتيح `account_mappings`، توثيق السلوك الفعلي المتحقق منه للفترات المحاسبية، تقسيم التنفيذ إلى `3أ / 3ب / 3ج`، وتوثيق مسودات التصليب والاختبارات.  
> **المرجع الحاكم:** لا تعديل على الهجرات المعتمدة `001` إلى `008`؛ ولا تغيير في حالة القرارات المفتوحة في [`docs/decisions_needed.md`](file:///e:/cash/docs/decisions_needed.md).

---

## 1. مصدر توليد القيود (Client-Side Generation vs Server-Side Generation)

### القرار المعماري المقترح:
يتولد قيد اليومية (`journal_entries` و `journal_lines`) في جانب العميل داخل المتصفح، ويُضمّن في حزمة المستند الذرية نفسها ليرسل في معاملة واحدة عبر Edge Function `sync-push` إلى النسخة المحدثة في المرحلة 3ب من دالة `sync_push_document`.

```
[ العميل / الكاشير أوفلاين ]
         │
         ├── 1. إنشاء الفاتورة (Document + Lines)
         └── 2. توليد القيد آلياً عبر account_mappings (Journal Entry + Balanced Lines)
         │
         ▼
[ حزمة ذرية واحدة: Document + Journal Bundle ]
         │
         ▼
[ خادم Supabase: RPC sync_push_document (تحديث المرحلة 3ب) ]
         ├── 1. إدخال رأس الفاتورة وبنودها بحالة draft ثم ترحيلها
         ├── 2. إدخال رأس القيد بحالة draft ثم إدخال بنود القيد
         ├── 3. التحقق الخادمي الشامل من تطابق الحزمة ومفاتيح account_mappings
         └── 4. ترحيل القيد (status = 'posted') وتفعيل check_entry_balanced
```

### المقارنة الفنية والمخاطر الأمنية:
| المعيار | التوليد في جانب العميل (المقترح) | التوليد في جانب السيرفر عبر Trigger |
| :--- | :--- | :--- |
| **العمل دون اتصال (Offline-First)** | يملك العميل القيد فوراً محلياً، ويمكنه عرض كشف الحساب وميزان المراجعة والقيود دون انتظار الإنترنت. | العميل لا يرى القيد ولا رصيد الحساب المحدث إلا بعد الاتصال بالإنترنت ومزامنة السيرفر. |
| **الذرية والمزامنة** | الفاتورة وقيدها يحملان نفس معرف العملية (`op_id`)، إما أن يُقبلا معاً أو يُرفضا معاً في نفس المعاملة. | احتمال حدوث فجوة أو تباين بين بيانات العميل وتوليد السيرفر إن اختلف المنطق. |
| **عبء المعالجة** | توزيع حساب القيود على أجهزة الفروع مع تدقيق خادمي فقط. | زيادة معالجة Triggers في قاعدة البيانات. |
| **المخاطرة الأمنية والتحقق الخادمي** | **توازن القيد (`Debit = Credit`) شرط ضروري لكنه غير كافٍ وحده** لمنع التلاعب؛ يجب على خادم Supabase التحقق الصارم من 5 شروط حاكمة: | السيرفر يتحكم بالكود بالكامل، لكنه يضحي بقراءة القيود الفورية أوفلاين. |

### الشروط الخادمية الخمسة للتحقق من الحزمة (Server-Side Bundle Verification Invariants):
1. **مطابقة مجموع القيد لقيمة الفاتورة:** التأكد من أن إجمالي الطرف المدين والدائن للقيد يطابق القيم المعتمدة في المستند (`documents.total` ومكوناته الضريبية والخصم).
2. **ارتباط المصدر (`source_id`):** التأكد من أن `journal_entries.source_id = documents.id` و`source_type = 'document'`.
3. **تطابق الفرع (`branch_id`):** التأكد من تطابق `branch_id` بين الفاتورة والقيد وعزله وفق `user_branches`.
4. **انفتاح الفترة المالية لجميع الحركات:** التأكد من وقوع `doc_date` و`entry_date` ضمن فترة مالية مفتوحة وغير متداخلة (`require_open_period`).
5. **الانضباط لمصفوفة التوجيه عبر `account_mappings`:** التأكد من أن الحسابات المستخدمة في بنود القيد تطابق الحسابات المعرّفة في جدول `account_mappings` لهذا النوع من المستندات (أو حساب الخزينة/المصروف المصرح به).

---

## 2. مواصفة استيعاب الحزمة الذرية في `sync_push_document` (تحديث المرحلة 3ب)

في الهجرات الحالية [`007_sync_engine_rpcs.sql`](file:///e:/cash/supabase/migrations/007_sync_engine_rpcs.sql) و[`008_sync_push_document_hardening.sql`](file:///e:/cash/supabase/migrations/008_sync_push_document_hardening.sql)، تستقبل `sync_push_document` الفاتورة وبنودها فقط (`p_op_id`, `p_header`, `p_lines`, `p_post_now`, `p_client_ts`). في المرحلة 3ب سيتم توسيعها في هجرة جديدة (دون تعديل `001`–`008`) لتستقبل حزمة المستند والقيد معاً:

### أ. التوقيع والـ JSON Payload المقترح:
```sql
create or replace function public.sync_push_document(
  p_op_id uuid,
  p_header jsonb,
  p_lines jsonb,
  p_post_now boolean default false,
  p_client_ts timestamptz default null,
  p_journal_entry jsonb default null,
  p_journal_lines jsonb default null
) returns jsonb ...
```
- `p_journal_entry`: كائن JSON يحمل معرف رأس القيد المولد بالعميل وأعمدته (`id`, `series_code`, `seq_no`, `entry_no`, `entry_date`, `branch_id`, `description`, `source_type`, `source_id`, `status`).
- `p_journal_lines`: مصفوفة JSON لبنود القيد المولدة بالعميل (`id`, `line_no`, `account_id`, `party_id`, `cost_center_id`, `debit`, `credit`, `currency_code`, `fx_amount`, `memo`).

### ب. الترتيب الداخلي لتجنب استثناء `check_entry_balanced`:
محفز `trg_balance_je` ([`001` سطر 401](file:///e:/cash/supabase/migrations/001_core_schema.sql#L401)) يستدعي [`check_entry_balanced()`](file:///e:/cash/supabase/migrations/001_core_schema.sql#L366-L377) (المحدّث بصلاحية `security definer` في [`005` سطر 70-89](file:///e:/cash/supabase/migrations/005_v1_rls_and_security_triggers.sql#L70-L89)) كمحفز `BEFORE INSERT OR UPDATE` على `journal_entries` عندما تكون `new.status = 'posted'`.  
إذا أُدخل رأس القيد مباشرة بحالة `'posted'` قبل إدخال البنود في `journal_lines`، فسيجد المحفز `0` سطور ويرفض العملية بالاستثناء:
```
journal entry % not balanced (debit %, credit %, lines %)
```
لذا يجب أن تتبع المعاملة الذرية الترتيب الإلزامي التالي:
1. إدخال رأس المستند بحالة `'draft'` ثم بنوده في `documents` و`document_lines` (وترحيله إذا طُلب `p_post_now`).
2. إدخال رأس القيد في `journal_entries` بحالة `'draft'`.
3. إدخال بنود القيد في `journal_lines`.
4. تنفيذ الفحوصات الخادمية الخمسة لمطابقة الحزمة ومفاتيح `account_mappings`.
5. تحديث رأس القيد إلى `'posted'` مع `posted_at = clock_timestamp()` لتشغيل `check_entry_balanced` و`require_open_period`.

### ج. معالجة التكرار (Idempotency) والوضع الحالي لـ `sync_push_op`:
- في العقود الحالية لـ `sync_push_document` و`sync_push_op`، تُرجع المحاولات المكررة لعملية سبق تطبيقها بنجاح استجابة:
  `{ "success": true, "status": "duplicate", "is_duplicate": true, "original_result": "applied", "code": "ok", "server_row": ... }`.  
  في المرحلة 3ب يجب توسيع استجابة التكرار لترجع بيانات القيد المربوط بالمعاملة عند الحاجة.
- **حالة الدفع الفردي الحالية في `007` (متحقق منها):** حالياً في [`007` سطر 230 و239](file:///e:/cash/supabase/migrations/007_sync_engine_rpcs.sql#L230-L247)، يسمح `sync_push_op` بدفع `journal_entries` (`insert`, `update`, `post`, `reverse` مع رفض `reverse` في السطر 315-327) و`journal_lines` (`insert`, `update`, `delete`) بشكل منفصل لكل صف؛ والعمود `entry_id` في `journal_lines` مسموح بتحديثه في السطر 367.  
  في المرحلة 3ب يجب: (1) إبقاء القيود المرتبطة بالمستندات محصورة ضمن حزمة `sync_push_document` الذرية أو فرض إتمام القيود اليدوية عبر دالة حزمة قيد متكاملة حتى لا تفشل عملية `post` منفردة قبل وصول البنود، و(2) إزالة `entry_id` و`document_id` من قائمة الأعمدة القابلة للتعديل في `UPDATE` بجانب تصليب `009`.

---

## 3. نموذج الجداول والبيانات (Data Model & Schema)

جداول القيود منشأة في [`001_core_schema.sql`](file:///e:/cash/supabase/migrations/001_core_schema.sql#L104-L126) وممتدة في [`002_extended_schema.sql`](file:///e:/cash/supabase/migrations/002_extended_schema.sql#L40):

### أ. جدول ترويسة القيد (`journal_entries`):
- `id`: `uuid` (مفتاح رئيسي، يولده العميل حصراً).
- `series_code`: `text` (سلسلة الترقيم).
- `seq_no`: `int`، `entry_no`: `text`، بقيد تفرد `unique (series_code, seq_no)`.
- `entry_date`: `date` (تاريخ القيد).
- `description`: `text` (البيان).
- `source_type`: `text` (`manual`, `document`, `payment`, `stock_adjustment`, `opening`, `closing`, `reversal`).
- `source_id`: `uuid` (معرف المصدر المرتبط).
- `status`: `text` (`draft`, `posted`, `reversed`).
- `posted_at`: `timestamptz`، `reverses_entry_id`: `uuid references journal_entries(id)`.
- `branch_id`: `uuid references branches(id)` (أضيف في [`002` سطر 40](file:///e:/cash/supabase/migrations/002_extended_schema.sql#L40)).

### ب. جدول بنود القيد (`journal_lines`):
- `id`: `uuid`، `entry_id`: `uuid not null references journal_entries(id) on delete cascade`.
- `line_no`: `int` (بقيد `unique (entry_id, line_no)`).
- `account_id`: `uuid not null references accounts(id)`.
- `party_id`: `uuid references parties(id)`، `cost_center_id`: `uuid references cost_centers(id)`.
- `debit`: `numeric(18,4)`، `credit`: `numeric(18,4)` مع القيد `check ((debit = 0) <> (credit = 0))` (طرف واحد فقط لكل سطر).
- `currency_code`: `char(3)`، `fx_amount`: `numeric(18,4)`، `memo`: `text`.

---

## 4. سلوك الفترات (متحقق منه) وإغلاق الفترات المالية

> ⚠️ **تنبيه سياسة مفتوحة (افتراض عمل بانتظار المحاسب):**  
> جميع القرارات الخاصة بسياسة الفترات المقفولة (الخيارات 1/2/3 عند المزامنة أوفلاين، وسياسة عكس قيود الفترات المقفولة) ما زالت **مفتوحة** في [`docs/decisions_needed.md`](file:///e:/cash/docs/decisions_needed.md).  
> هذا القسم يوثق **السلوك الفعلي المتحقق منه حالياً في الكود** باعتباره **افتراض عمل بانتظار المحاسب** ولا يُعد اعتماداً لأي خيار.

### المعضلة التشغيلية والخيارات المفتوحة:
إذا أنشأ كاشير فاتورة أوفلاين بتاريخ `2026-01-31` ثم أغلق المحاسب فترة يناير (`status = 'closed'`) قبل اتصال الكاشير بالإنترنت:
1. **الخيار 1:** رفض الترحيل عبر `require_open_period` وإتاحة معالجة النزاع يدوياً للمحاسب.
2. **الخيار 2:** الترحيل التلقائي لأول فترة مفتوحة لاحقة.
3. **الخيار 3:** إعادة الفتح الاستثنائية بصلاحية المدير.

### 4.1 سلوك الفترات الفعلي على الخادم والعميل (متحقق منه):
1. **نطاق تفعيل `require_open_period()` ([`001` سطر 353-363](file:///e:/cash/supabase/migrations/001_core_schema.sql#L353-L363)، [`005` سطر 51-67](file:///e:/cash/supabase/migrations/005_v1_rls_and_security_triggers.sql#L51-L67)):**
   - يفحص المحفز وجود فترة `status = 'open' and deleted_at is null` تشمل التاريخ **فقط** عندما تتحقق:
     `if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted')`
   - يترتب على ذلك واقعياً:
     - **حالة `'draft'` لا تُفحص:** يمكن إنشاء وتعديل مسودات بتواريخ فترات مقفولة، ولا يُمنع إلا لحظة الترحيل إلى `'posted'`.
     - **الانتقال `posted -> reversed` لا يفعّل `require_open_period()`** لأن `new.status = 'reversed'` وليس `'posted'`.
     - **القيد العكسي الجديد** عند ترحيله (`status = 'posted'`) يُفحص تاريخه (`p_reversal_date`) ضد `fiscal_periods`. هل يُسمح محاسبياً بعكس قيد قديم من فترة مقفولة داخل فترة مفتوحة لاحقة أم يجب منع ذلك؟ **قرار مفتوح ينتظر المحاسب القانوني.**
2. **خط مسار رفض الفترة المقفولة في المزامنة الحالية (`007`/`008` + `syncEngine.ts`) — نقطة جوهرية:**
   - عندما يرمي `require_open_period()` استثناء `'no open fiscal period for date %'`، يحمل `SQLSTATE 'P0001'`.
   - دالتا [`sync_push_op`](file:///e:/cash/supabase/migrations/007_sync_engine_rpcs.sql#L540-L556) و[`sync_push_document`](file:///e:/cash/supabase/migrations/008_sync_push_document_hardening.sql#L306-L322) تلتقطان `P0001` وتعيدانه كـ JSON:
     `{ "success": false, "status": "rejected", "code": "validation", "sqlstate": "P0001", "error": "no open fiscal period for date ..." }` (وترجعه `sync-push` بحالة HTTP `200`).
   - على العميل في [`classifyError()`](file:///e:/cash/src/services/sync/syncEngine.ts#L86-L131): أي رد يحمل `status === 'rejected'` يُصنف `{ isPermanent: true, isConflict: false }` (`isConflict` لا يتحقق إلا مع `status === 'conflict'`).
   - لذلك في [`pushAll()`](file:///e:/cash/src/services/sync/syncEngine.ts#L662-L695): تدخل العملية في **`outbox` بحالة `'failed'`** (ولا تُضاف تلقائياً إلى جدول **`sync_conflicts`** ولا تظهر في شاشة النزاعات!).
   - **إصلاح المرحلة 3ب المطلوب:** عند حسم السياسة في `decisions_needed.md`، يجب أن تعيد دوال السيرفر رمزاً مميزاً (مثل `code: 'period_closed'` أو `status: 'conflict'` إذا اعتمد الخيار 1) مع مسار واضح في `syncEngine.ts` بدلاً من معاملته كـ `validation` عام.
3. **تواجد `fiscal_periods` في العميل والنسخ الاحتياطي وتداخل التواريخ:**
   - **Dexie:** الجدول معرّف في [`src/db/index.ts`](file:///e:/cash/src/db/index.ts#L82) ومفهرس في السطر `163` (`id, fiscal_year_id, status, start_date, end_date, server_seq`).
   - **المزامنة:** الجدول مدرج في `SYNCABLE_V1_TABLES` ([`src/services/sync/syncEngine.ts`](file:///e:/cash/src/services/sync/syncEngine.ts#L63)) ومقيد كـ `pull-only` على السيرفر ([`007` سطر 223](file:///e:/cash/supabase/migrations/007_sync_engine_rpcs.sql#L223)).
   - **النسخ الاحتياطي (نقص حالي):** `fiscal_periods` غير موجود في `CORE_BACKUP_TABLES` ([`src/services/backup/types.ts`](file:///e:/cash/src/services/backup/types.ts#L8-L22)) ولا في `SafetySnapshotDatabase` ([`src/services/backup/restoreService.ts`](file:///e:/cash/src/services/backup/restoreService.ts#L26-L48)). يجب ضمه في المرحلة 3أ كي لا يفقد الجهاز المستعاد حالة الفترات أوفلاين. *(وكذلك مراجعة ضم `account_mappings` و`number_series` إلى المزامنة/النسخ الاحتياطي).*
   - **منع تداخل الفترات:** جدول `fiscal_periods` في [`001` سطر 65-69](file:///e:/cash/supabase/migrations/001_core_schema.sql#L65-L69) لا يمنع تداخل التواريخ؛ وقد أُضيف الحل في مسودة [`009_posted_children_and_period_hardening_draft.sql`](file:///e:/cash/supabase/migrations_draft/009_posted_children_and_period_hardening_draft.sql) بقيد `excl_fiscal_periods_no_overlap` (`EXCLUDE USING gist` على `daterange(start_date, end_date, '[]') WHERE (deleted_at IS NULL)`).

---

## 5. مصفوفة الترحيل الافتراضية المعتمدة على مفاتيح `account_mappings`

> ⚠️ **تنبيه حوكمة المحاسبة:**  
> هذه المصفوفة **مسودة بانتظار اعتماد المحاسب القانوني**.  
> يعتمد المحرك المحاسبي في المرحلة 3 **حصراً على المفاتيح الدلالية في جدول `account_mappings`** (المعرفة في [`001` سطر 97-101](file:///e:/cash/supabase/migrations/001_core_schema.sql#L97-L101) والمبذورة في [`006` سطر 244-264](file:///e:/cash/supabase/migrations/006_v1_seed_roles_permissions_and_coa.sql#L244-L264)) وليس على أكواد حسابات صلبة في الكود.  
> **ملحوظة COGS:** قيد تكلفة البضاعة المباعة (`cogs` مدين / `inventory` دائن) لفواتير المبيعات **مؤجل بالكامل إلى المرحلة 6 (المخزون والتكاليف)**.

### أ. مصفوفة الترحيل بالمفاتيح الدلالية:
| نوع المستند / الحركة | الطرف المدين (Dr) — عبر `account_mappings.key` | الطرف الدائن (Cr) — عبر `account_mappings.key` | البعد / المرجع | ملاحظات |
| :--- | :--- | :--- | :---: | :--- |
| **فاتورة مبيعات نقدية** | `cash_default` *(أو `gl_account_id` لحساب الخزينة/البنك المختار)* | 1. `sales_revenue`<br>2. `vat_output` | `branch_id` | قيد الإيراد والضريبة فقط (COGS مؤجل للمرحلة 6). الخصم التجاري الممنوح إن فُصل محاسبياً يستخدم `discount_allowed` مديناً [يحتاج تحقق محاسبي]. |
| **فاتورة مبيعات آجلة** | `receivables` *(مع تحديد العميل في `party_id`)* | 1. `sales_revenue`<br>2. `vat_output` | `branch_id` | يثبت مديونية العميل في حساب المراقبة الفرعي. |
| **مردود مبيعات (إشعار دائن)** | 1. `sales_returns`<br>2. `vat_output` | `receivables` *(للآجل مع `party_id`)* أو `cash_default` *(للنقدي)* | `branch_id` | يعكس الإيراد وضريبة المخرجات للفاتورة الأصلية. |
| **فاتورة مشتريات بضاعة** | 1. `inventory` *(أو حسب سياسة المخزون المعتمدة)*<br>2. `vat_input` | `payables` *(مع تحديد المورد في `party_id`)* | `branch_id` | يثبت التزام المورد وضريبة المدخلات القابلة للخصم. |
| **مردود مشتريات (إشعار مدين)** | `payables` *(مع تحديد المورد في `party_id`)* | 1. `inventory` *(تخفيض المخزون؛ وتطبيق أي حساب دوري بديل مؤجل لسياسة المخزون عند الاعتماد)*<br>2. `vat_input` | `branch_id` | تخفيض التزام المورد وتخفيض المخزون وضريبة المدخلات. |
| **تسوية / فروقات جرد** *(مرحلة 6)* | `inventory_adjustment` *(في العجز)* أو `inventory` *(في الزيادة)* | `inventory` *(في العجز)* أو `inventory_adjustment` *(في الزيادة)* | `branch_id` | مؤجل تنفيذ حركته للمرحلة 6، ومفتاحه معرف مسبقاً في `001`/`006`. |
| **سند قبض نقدي/بنكي** | `cash_default` أو `bank_default` *(أو `treasury_accounts.gl_account_id`)* | `receivables` *(مع `party_id`)* | `branch_id` | سداد مستحقات العملاء. |
| **سند صرف لمورد** | `payables` *(مع `party_id`)* | `cash_default` أو `bank_default` *(أو `treasury_accounts.gl_account_id`)* | `branch_id` | سداد التزامات الموردين؛ وإذا وُجد خصم مكتسب يُقيد إلى `discount_received` دائن. |
| **سند صرف مصروف عمومي** | الحساب المختار من `accounts` (`type = 'expense'` و`is_postable = true`) | `cash_default` أو `bank_default` *(أو `treasury_accounts.gl_account_id`)* | `branch_id` / `cost_center_id` | لا يوجد مفتاح عام موحد للمصروفات في `account_mappings`، فيختار المستخدم حساب المصروف. |
| **إقفال السنة المالية** *(مرحلة لاحقة)* | ملخص الإيرادات/المصروفات | `retained_earnings` *(عند الربح، والعكس عند الخسارة)* | - | مؤجل لآلية إقفال السنة المالية. |

### ب. جدول المقارنة: `account_mappings.key` مقابل بذور `006` ومقترح الدليل (`chart_of_accounts_proposal.md`):
يوضح الجدول التالي المفاتيح الـ 14 المحددة في [`001` سطر 98-100](file:///e:/cash/supabase/migrations/001_core_schema.sql#L98-L100) ومطابقتها بين [`006_v1_seed_roles_permissions_and_coa.sql`](file:///e:/cash/supabase/migrations/006_v1_seed_roles_permissions_and_coa.sql#L244-L264) و[`docs/chart_of_accounts_proposal.md`](file:///e:/cash/docs/chart_of_accounts_proposal.md#L35-L132):

| `account_mappings.key` | كود `006_v1_seed` واسمه | كود `chart_of_accounts_proposal.md` واسمه | الملاحظة والتطابق |
| :--- | :--- | :--- | :--- |
| `sales_revenue` | `4101` — إيرادات المبيعات التجارية | `410101` — إيرادات مبيعات بضائع محلية (ضريبة 14%) | مرتبط في الملفين (متاحان). |
| `sales_returns` | `4102` — مردودات ومسموحات المبيعات | `420101` — مردودات ومسموحات المبيعات | متاح في الملفين باختلاف رقم التبويب. |
| `cogs` | `5101` — تكلفة البضاعة المباعة (COGS) | `510101` — تكلفة البضاعة المباعة محلياً | متاح في الملفين (مؤجل تنفيذه للمرحلة 6). |
| `inventory` | `1104` — مخزون البضائع بالمستودعات | `110401` — مخزون بضاعة تامة الصنع (المستودع الرئيسي) | متاح في الملفين. |
| `vat_output` | `2102` — ضريبة القيمة المضافة المحصلة (مخرجات) | `210301` — مصلحة الضرائب - ضريبة القيمة المضافة مخرجات | متاح في الملفين. |
| `vat_input` | `1105` — ضريبة القيمة المضافة المدفوعة (مدخلات) | `110501` — مصلحة الضرائب - ضريبة القيمة المضافة مدخلات | متاح في الملفين. |
| `receivables` | `1103` — العملاء (حسابات المدينين التجارية) | `110201` — حساب العملاء المحليين (تجاري B2B) | متاح في الملفين. |
| `payables` | `2101` — الموردون (حسابات الدائنين التجارية) | `210101` — حساب الموردين المحليين (تجاري) | متاح في الملفين. |
| `discount_allowed` | `5202` — خصم مسموح به (مصروف) | `420102` — الخصم المسموح به (تخفيض إيراد / مدين) | اختلاف تصنيف (`expense` مقابل contra-revenue)؛ يحسمه المحاسب. |
| `discount_received` | `4201` — خصم مكتسب (إيراد) | `510201` — الخصم المكتسب من الموردين (تخفيض تكلفة / دائن) | اختلاف تصنيف (`revenue` مقابل contra-cogs)؛ يحسمه المحاسب. |
| `inventory_adjustment` | `5203` — فروقات وتسويات جرد المخزون | *غير مدرج في مقترح الشجرة ولا في قسم `account_mappings` السطر 119-131* | يلزم إضافته إن اعتُمد الدليل السداسي. |
| `retained_earnings` | `3102` — الأرباح والخسائر المرحلة (المحتجزة) | `310301` — الأرباح المحتجزة / المدورة من سنوات سابقة | متاح في الملفين. |
| `cash_default` | `1101` — الخزينة الرئيسية (نقدية بالصندوق) | `110101` — صندوق الخزينة الرئيسي (المركز الرئيسي) | متاح في الملفين. |
| `bank_default` | `1102` — بنك مصر - حساب جاري | *غير مدرج في قسم `account_mappings` السطر 119-131* (يوجد في الجدول `110103` و`110104`) | يلزم ربط `bank_default` بحساب بنك فعلي عند اعتماد السداسي. |

> **قرار لا يعطّل التنفيذ البرمجي:**  
> اختيار المالك والمحاسب بين إبقاء الدليل الرباعي المبذور في `006` أو الترحيل للدليل السداسي في `chart_of_accounts_proposal.md` أو استيراد دليل مخصص ما زال **قراراً مفتوحاً**، لكنه **لا يعطّل بناء كود المرحلة 3**؛ لأن كل دوال التوليد والترحيل في المرحلة 3 تعتمد **حصراً على قراءة `account_id` ديناميكياً من جدول `account_mappings` عبر `key`** دون أي أرقام حسابات صلبة في الكود.

---

## 6. ميزان المراجعة والأداء الحسابي (Trial Balance & Performance)

### الحساب في جانب السيرفر:
- مقترح عبر دالة `get_trial_balance(p_branch_id, p_start_date, p_end_date)` في مسودة [`010_core_ledger_helpers_draft.sql`](file:///e:/cash/supabase/migrations_draft/010_core_ledger_helpers_draft.sql) بالاستفادة من الفهارس المقترحة (`idx_journal_lines_account_entry` و`idx_journal_entries_branch_status_date`).  
- **ملاحظة أداء:** هدف استجابة "أجزاء من الثانية لآلاف القيود" المذكور سابقاً في التصميم هو **هدف تقديري — يحتاج تحقق** عبر قياس فعلي (`EXPLAIN ANALYZE`) على بيانات اختبار كبيرة بعد تطبيق الفهارس.

### الحساب في جانب العميل (Dexie أوفلاين):
- في قاعدة Dexie المحلية ([`src/db/index.ts`](file:///e:/cash/src/db/index.ts#L170))، `journal_lines` مفهرسة بـ `account_id`:
  ```ts
  const lines = await db.journal_lines.where('account_id').anyOf(accountIds).toArray();
  ```
- **كاش الأرصدة التراكمية المستقبلي (`account_period_balances`):**  
  عند نمو البيانات إلى عشرات الآلاف، يمكن تصميم جدول محلي مشتق للأرصدة الشهرية.  
  > **طبيعة الجدول المقترح:** هو **كاش محلي مشتق (Local Derived Cache)** غير متزامن: لا يدخل في جدول `outbox` (الجدول المحلي الفعلي في [`src/db/index.ts`](file:///e:/cash/src/db/index.ts#L144))، ولا يُرفع إلى Supabase، ولا يُدرج في النسخ الاحتياطي، إذ يُعاد بناؤه بالكامل من `journal_lines`.

---

## 7. الترقيم المتسلسل والعمليات العكسية وحصانة البنود

- **ترقيم القيود:** يعتمد مبدأ `series_code` + `seq_no` المتزايد محلياً مع منع تراجع العدادات عند الاستعادة: `new_seq = max(local_current, restored_max)` (ويجب ضم قيود اليومية `journal_entries` إلى حساب العدادات في `restoreService.ts` أو توحيده في المرحلة 3أ — **يحتاج تحقق تفصيلي عند التنفيذ** لأن [`restoreService.ts`](file:///e:/cash/src/services/backup/restoreService.ts#L242-L249) يفحص `documents` حالياً لا `journal_entries`!).
- **تصحيح القيود المعتمدة (Reversals):**
  - محفز `block_posted_changes` ([`001` سطر 323-335](file:///e:/cash/supabase/migrations/001_core_schema.sql#L323-L335)، [`005` سطر 15-30](file:///e:/cash/supabase/migrations/005_v1_rls_and_security_triggers.sql#L15-L30)) يمنع تعديل أو حذف `posted`/`reversed` ويسمح فقط بانتقال `old.status = 'posted' and new.status = 'reversed'`.
  - مسودة [`010_core_ledger_helpers_draft.sql`](file:///e:/cash/supabase/migrations_draft/010_core_ledger_helpers_draft.sql) توفّر دالة `create_journal_reversal_entry` التي تقبل معرفات العميل (`p_reversal_id`, `p_series_code`, `p_seq_no`, `p_entry_no`, `p_line_ids jsonb`) دون أي توليد معرفات أو أرقام عشوائية في الخادم.

### 7.1 حصانة بنود القيود (`journal_lines`) والمستندات (`document_lines`):
1. **ثغرة إعادة ربط `entry_id` / `document_id` في `001`/`005` (مثبتة بـ `draft_hardening_posted_children_test.sql`):**
   - في `001`/`005` تفحص `block_posted_children()` سجل `OLD` فقط في `DELETE` وسجل `NEW` فقط في `INSERT`/`UPDATE`. وبما أن [`007` سطر 363 و367](file:///e:/cash/supabase/migrations/007_sync_engine_rpcs.sql#L363-L367) يسمحان بعمودي `document_id` و`entry_id` في التحديث، يمكن نقل بند قيد مرحل إلى قيد `draft` وتجاوز المحفز، مما يخل بتوازن القيد المرحل!
   - **المعالجة المعتمدة في المسودة:** مسودة [`009_posted_children_and_period_hardening_draft.sql`](file:///e:/cash/supabase/migrations_draft/009_posted_children_and_period_hardening_draft.sql) تصلح `block_posted_children()` لفحص `OLD` في `UPDATE`/`DELETE` و`NEW` في `INSERT`/`UPDATE` معاً مع الإبقاء على نص الرسالة `'cannot change lines of a posted record'`، ويُغلق معها أيضاً في المرحلة 3ب حذف `entry_id` و`document_id` من الأعمدة القابلة للتحديث في `sync_push_op`.
2. **نطاق `check_entry_balanced`:**
   - يرتبط المحفز في [`001` سطر 401](file:///e:/cash/supabase/migrations/001_core_schema.sql#L401) بجدول `journal_entries` فقط. عند إغلاق ثغرة `block_posted_children()` ومنع تعديل أو حذف أو إدراج سطور على أي قيد مرحل، تبقى بنود القيد المرحل محمية بعد ترحيله؛ ويمكن إضافة `CONSTRAINT TRIGGER DEFERRABLE` على `journal_lines` كطبقة دفاع إضافية إذا قرر المراجع المحاسبي ذلك (**يحتاج تحقق عند مراجعة هجرة المرحلة 3ب**).

---

## 8. خطة التنفيذ المقسمة (3أ / 3ب / 3ج)

### المرحلة 3أ — عميل فقط (Client-Side):
1. بناء خدمة توليد القيود الآلية المزدوجة (`decimal.js` + `crypto.randomUUID()`) بالاعتماد حصراً على مفاتيح `account_mappings` في Dexie دون أي أرقام حسابات صلبة.
2. إضافة فحص محلي استرشادي لحالة `fiscal_periods` في Dexie قبل إنشاء/ترحيل القيود والمستندات (دون حسم سياسة تعارض الأوفلاين المفتوحة).
3. توسيع `CORE_BACKUP_TABLES` و`SafetySnapshotDatabase` لتشمل `fiscal_periods` (ودراسة ضم `account_mappings` و`number_series`) مع التأكد من حفظ عدادات `journal_entries` عند الاستعادة.
4. إضافة `account_mappings` و`number_series` لقائمة السحب (`Pull-Only`) في `SYNCABLE_V1_TABLES` عند الحاجة.
5. حساب ميزان المراجعة وكشوف الحساب محلياً من Dexie مع خيار كاش محلي غير متزامن `account_period_balances` عند تضخم البيانات (**يحتاج تحقق للأداء**).

### المرحلة 3ب — سيرفر (Server-Side Migrations & RPCs):
1. اعتماد وتطبيق التصليب الأمني [`009_posted_children_and_period_hardening_draft.sql`](file:///e:/cash/supabase/migrations_draft/009_posted_children_and_period_hardening_draft.sql) بعد تشغيل استعلام الفحص المسبق لتداخل `fiscal_periods`.
2. اعتماد وتطبيق مساعدات [`010_core_ledger_helpers_draft.sql`](file:///e:/cash/supabase/migrations_draft/010_core_ledger_helpers_draft.sql) (`chk_jl_positive_values`, فهارس الأداء، `get_trial_balance`, `create_journal_reversal_entry`).
3. توسيع `sync_push_document` (في هجرة جديدة بعد `008`) لاستقبال `p_journal_entry` و`p_journal_lines` ذرياً، وإدراج المستند والقيد معاً والتحقق من الشروط الخمسة.
4. معالجة دفع `journal_entries` و`journal_lines` في `sync_push_op`: منع تحديث `entry_id`/`document_id` وتأمين تدفق القيود اليدوية أو تقييد قيود المستندات بالحزمة الذرية.
5. تمييز رمز رفض الفترة المقفولة (`code: 'period_closed'` أو وفق قرار `decisions_needed.md`)، وإضافة مسار عكس القيود عبر المزامنة (`sync_push_reversal` أو تفعيل `reverse` بضوابط العدادات ومعرفات العميل) بدل الرفض الثابت في `007`.

### المرحلة 3ج — واجهات المستخدم (UI):
1. شاشة دليل الحسابات وإعداد ربط `account_mappings` وفق الصلاحيات.
2. شاشة القيود اليومية اليدوية والآلية مع عرض القيد المرتبط بكل فاتورة وإجراء العكس المعتمد بالسبب والتاريخ.
3. شاشات التقارير المالية الأساسية: ميزان المراجعة، دفتر الأستاذ العام، وكشف حساب عميل/مورد، وواجهة إدارة الفترات المالية والإقفال وفق قرار المحاسب.
4. تحسين عرض حالات فشل المزامنة في الواجهة (تمييز فشل الفترة المقفولة بوضوح في `outbox` أو شاشة النزاعات بحسب السياسة المعتمدة).

---

## 9. مسودات الهجرات واختبارات المرحلة 3 و4 (Drafts & SQL Suites)

1. [`supabase/migrations_draft/009_posted_children_and_period_hardening_draft.sql`](file:///e:/cash/supabase/migrations_draft/009_posted_children_and_period_hardening_draft.sql) *(المرحلة 3ب — تصليب أمني)*: إصلاح `block_posted_children()` لفحص `OLD` و`NEW` معاً + منع تداخل `fiscal_periods` بقيد `GiST`.
2. [`supabase/migrations_draft/010_core_ledger_helpers_draft.sql`](file:///e:/cash/supabase/migrations_draft/010_core_ledger_helpers_draft.sql) *(المرحلة 3ب — النواة المحاسبية)*: قيد عدم السلبية، فهارس الأداء، دالة `get_trial_balance`، ودالة `create_journal_reversal_entry` بمعرفات العميل.
3. [`supabase/migrations_draft/011_eta_readiness.sql`](file:///e:/cash/supabase/migrations_draft/011_eta_readiness.sql) *(المرحلة 4 — الفاتورة الإلكترونية)*.
4. [`supabase/migrations_draft/012_seed_tax_defaults_draft.sql`](file:///e:/cash/supabase/migrations_draft/012_seed_tax_defaults_draft.sql) *(المرحلة 4 — البذور الضريبية)*.
5. **اختبارات SQL ذاتية الاحتواء (لا تطبق تغييراً دائماً وتنتهي بـ `ROLLBACK;`):**
   - [`supabase/tests/draft_hardening_posted_children_test.sql`](file:///e:/cash/supabase/tests/draft_hardening_posted_children_test.sql): إثبات ثغرة إعادة ربط البنود على المخطط الحالي `001`–`008` مقابل عمل قفل الحذف، وكسر توازن القيد المرحل.
   - [`supabase/tests/draft_hardening_apply_and_test.sql`](file:///e:/cash/supabase/tests/draft_hardening_apply_and_test.sql): تطبيق تصليب `009` داخل المعاملة وإثبات مرور جميع الاختبارات (بما فيها رفض نقل السطر إلى قيد مرحل ورفض تداخل الفترات بـ `23P01`).
   - [`supabase/tests/draft_010_ledger_validation_test.sql`](file:///e:/cash/supabase/tests/draft_010_ledger_validation_test.sql): اختبار 7 سيناريوهات للنواة المحاسبية والقيد المزدوج والفترات والعكس.

---

## 10. بنود من المراجعة السابقة موسومة بـ «يحتاج تحقق»

- أداء دالة `get_trial_balance` على آلاف القيود الفعلية (`EXPLAIN ANALYZE` على `cash-dev`): **يحتاج تحقق**.
- آلية حساب ورفع عداد `journal_entries` في [`restoreService.ts`](file:///e:/cash/src/services/backup/restoreService.ts#L242-L273) أسوة بـ `documents`: **يحتاج تحقق عند بدء 3أ**.
- فصل خصم المبيعات والمشتريات في قيد منفصل عبر `discount_allowed` / `discount_received` أم إثبات الصافي: **يحتاج تحقق وقرار محاسبي في `decisions_needed.md`**.
- الحاجة لإضافة `CONSTRAINT TRIGGER DEFERRABLE` على `journal_lines` بجانب تصليب `009` في `block_posted_children()`: **يحتاج تحقق عند مراجعة هجرة 3ب**.
- أي تفاصيل واجهات أو نقاط عكس قديمة وردت في تقييمات F5 ولم تُفحص في ملفاتها الفعلية (مثل تصميم شاشات Phase 3c غير المكتوبة بعد): **يحتاج تحقق عند بدء 3ج**.
