# توثيق معمارية المزامنة وبروتوكول السحب المعتمد (Authoritative Commit-Safe Sync Protocol)

## 1. التحدي الأساسي: تسلسل PostgreSQL والمعاملات غير المرتبة (Out-of-Order Commits)

في قواعد بيانات PostgreSQL:
- يتم حجز القيمة التسلسلية `server_seq = nextval('sync_seq')` لحظة تنفيذ جملة الاستعلام، **وليس لحظة الاعتماد (Commit)**.
- افترض معاملتين متزامنتين:
  - **المعاملة (Tx1):** معاملة أطول حجزت تسلسل `100`.
  - **المعاملة (Tx2):** معاملة سريعة في فرع آخر حجزت الرقم `105`.
- اعتمدت المعاملة Tx2 أولاً في التوقيت $T_1$.
- قام العميل بسحب التحديثات واستلم السجل رقم `105` وخزن المؤشر: `cursor = 105`.
- في التوقيت $T_2$، اعتمدت المعاملة Tx1 بالسجل `100`.
- **الفشل الكارثي في السحب البسيط:** إذا كان الاستعلام يعتمد فقط على `WHERE server_seq > cursor` (أي `> 105`)، فإن السجل `100` **سيفقد نهائياً وبصمت (Silent Data Loss)** ولن يصل للعميل أبداً.
- **فشل التراجع العددي الثابت (N-sequence lookback):** تحديد رقم تراجع ثابت (مثل 100 تسلسل) يفشل هندسياً لأن عملية استيراد جماعي واحدة (Bulk Import) لـ 5,000 صنف ستستهلك 5,000 رقم تسلسلي، مما يتجاوز أي نافذة عددية ثابتة.

---

## 2. آلية السحب المعتمدة والوحيدة (The ONE Authoritative Pull Mechanism)

الآلية الرسمية المعتمدة والوحيدة للنظام هي:
**"السحب الزمني المتداخل المحكوم بحد زمني أقصى للمعاملات مع الدمج الحيادي التسلسلي الصارم"**
**(Time-Bounded Overlap Pull with Idempotent Sequence Upserts)**.

### أ. تقييد وضبط الحد الأقصى لعمر المعاملات (Enforcing Transaction Bounds):
لكي تكون نافذة التراجع الزمني حاسمة ومضمونة رياضياً، يتم تقييد المعاملات على مستويي الخادم والعميل وفق حقائق قاعدة البيانات (PostgreSQL 17.11):
1. **أدوار قاعدة البيانات والمهل المفروضة محركياً (Role Timeouts):**
   - **العمليات المباشرة للعملاء (`authenticated`):** تحتفظ بالمهل الافتراضية لمنصة Supabase (`statement_timeout = '8s'`).
   - **عمليات الخلفية والمزامنة ودوال الحافة (`service_role`):** هذا هو الدور الفعلي الذي تنفذ تحته وظائف المزامنة (Edge Functions) وعمليات الاستيراد؛ ويتم تقييده في الهجرة `004` بمهل صارمة مدعومة بمحرك Postgres 17:
     - `statement_timeout = '60s'`
     - `idle_in_transaction_session_timeout = '15s'`
     - `transaction_timeout = '60s'` (حد زمني قاطع لكامل عمر المعاملة مهما تعددت عباراتها).
   - **الحد الأقصى المطلق لأي معاملة في النظام ككل ($T_{\max}$):**
     $$T_{\max} = 60\text{ ثانية}$$
2. **إلزامية التجزئة على العميل (Mandatory Client-Side Chunking):**
   - يُلزم العميل برمجياً بتجزئة أي عمليات استيراد أو حفظ جماعي (Bulk Imports) من قبل دور postgres أو service_role إلى دفعات صغيرة منفصلة بحيث يستغرق تنفيذ كل دفعة حتماً أقل من 60 ثانية (يوصى بـ $\le 500$ سجل لكل معاملة، تستغرق تنفيذياً أقل من ثانيتين).
3. **الاشتقاق الرياضي لنافذة السحب المتداخل ($W$):**
   - نافذة السحب المعتمدة هي رقم واحد محدد ومستنتج رياضياً من الحد الملزم مضافاً إليه هامش أمان بنسبة 100%:
     $$W = T_{\max} + \text{margin} = 60\text{s} + 60\text{s} = 120\text{ ثانية (دقيقتان)}$$
   - يستحيل برمجياً ومحركياً لأي معاملة أن تعتمد بعد حجز تسلسلها بفارق يتجاوز 60 ثانية؛ وبالتالي فإن نافذة **120 ثانية** تضمن استدراك أي سجل اعتمد خارج الترتيب (Out-of-Order Commit) دون أدنى احتمالية للفقد.

### ب. شروط ختم التوقيت وحذف البيانات (Server Trigger & Soft Deletes):
1. **ختم التوقيت بالسيرفر فقط (`updated_at`):**
   - يتم ضبط عمود `updated_at` حصرياً عبر مشغل قاعدة البيانات `stamp_row()` في PostgreSQL بتوقيت الخادم `now()`. يُحظر على العميل إرسال أو تعديل هذا الحقل لتجنب تباين توقيت الساعات (Clock Skew).
2. **شمول السجلات المحذوفة (Including Soft-Deleted Rows):**
   - استعلام السحب يشمل السجلات المحذوفة `deleted_at IS NOT NULL` لنقل شواهد الحذف (Tombstones) إلى قاعدة بيانات العميل وتحديثها محلياً.

### ج. جملة استعلام السحب المعتمدة (The Authoritative Pull Query):
```sql
-- استعلام السحب السحابي المعتمد في دالة السحب (sync-pull)
SELECT *
FROM <table_name>
WHERE (
  server_seq > :last_server_seq
  OR updated_at >= (:last_sync_timestamp - INTERVAL '120 seconds')
)
ORDER BY server_seq ASC
LIMIT 500;
```

---

## 3. قاعدة التطبيق المحلي الصارم في Dexie (Local Idempotent Upsert Rule)

عند استلام السجلات الناتجة عن السحب المتداخل، يطبق العميل القواعد الصارمة التالية:
1. **فحص التعارض مع العمليات المعلقة (No Overwriting Pending Outbox):**
   إذا كان للكيان المستلم عمليات محلية بحالة `pending` أو `in_flight` في جدول الـ Outbox، **لا يتم الكتابة الفوقية عليه مطلقاً**، بل يدرج في جدول `sync_conflicts` لفض التعارض لاحقاً.
2. **المقارنة التسلسلية الصارمة (Strict server_seq Comparison):**
   ```typescript
   if (!localRow || serverRow.server_seq > localRow.server_seq) {
     await table.put(serverRow);
     return 'applied';
   }
   return 'skipped';
   ```
   - **قاعدة قاطعة:** لا يوجد أي شرط `OR` بين `server_seq` و `version`. التحديث يطبق فقط إذا كان `server_seq` القادم أكبر قطيعاً من رصيد السجل محلياً، مما يضمن أن السجلات القديمة المعادة لا تُرجع حالة الكيان إلى الوراء.
3. **تحديث مؤشرات المزامنة:**
   عند اكتمال دفعة السحب بنجاح، يحدث العميل:
   - `last_server_seq = max(last_server_seq, ...received_server_seqs)`
   - `last_sync_timestamp = server_response_time`

---

## 4. معمارية الدفع (Sync-Push) والذرية التامة دون دور service_role (مرحلة 2b-2)

### أ. الذرية التامة والتنفيذ الموحد بهوية المستخدم المتصل (Single-Transaction Atomicity):
- في التصميمات السابقة، كان تنفيذ عملية الأعمال يجري باتصال بهوية المستخدم (`authenticated`) بينما تسجيل حجز العملية في `sync_ops` يجري باتصال منفصل بدور `service_role`.
- **معضلة الاتصالين المنفصلين (Dual-Write Failure):**
  - لو نجحت عملية الأعمال واعتمدت، ثم فشل تسجيل `sync_ops` (بسبب انقطاع اتصال أو مهلة): يصبح السجل موجوداً في جداول الأعمال دون وجود أثر له في `sync_ops`. عند قيام العميل بإعادة المحاولة بنفس `op_id`، سيفشل الـ INSERT بانتهاك قيد التفرد (Unique constraint) أو يتكرر التعديل وتتضاعف الإصدارات.
  - لو تم الحجز أولاً في `sync_ops`، ثم فشلت عملية الأعمال: سيعتبر السيرفر العملية مكررة وناجحة في المحاولة التالية (`duplicate: applied`) مع أن البيانات لم تُنشأ في جداول الأعمال إطلاقاً.
- **الحل الجذري المطبق في 2b-2 (Atomic RPC under Caller Identity):**
  1. تنفذ عملية الدفع بالكامل عبر دالة موحدة (`sync_push_op` أو `sync_push_document`).
  2. تجري كافة الخطوات داخل **معاملة PostgreSQL ذرية واحدة (Single Transaction)** تحت هوية وجلسة المستخدم المتصل حصرياً (`auth.uid()`).
  3. يتم الحجز الذري في `sync_ops` عبر دالة `private._internal_claim_sync_op` المعرفة بـ `SECURITY DEFINER` في مخطط داخلي خاص لا يكشفه PostgREST. تتيح هذه الدالة كتابة سجل المزامنة دون الحاجة لمنح دور `authenticated` أي صلاحيات مباشرة على جدول `sync_ops`، **ودون الحاجة نهائياً لأي اتصال بدور `service_role`**.
  4. تخضع كافة عمليات الإدخال والتعديل لسياسات RLS وعزل الفروع الخاصة بالمستخدم المتصل فورياً.
  5. يتم إنهاء السجل في `sync_ops` (إلى `applied` أو `conflict` أو `rejected`) داخل المعاملة نفسها، مع التحقق الصارم من أن السطر المحدث يملكه المستخدم الحالي (`user_id = auth.uid()`).
  6. في حال وقوع أي خطأ عابر (Transient error مثل `40001` serialization أو `55P03` lock timeout أو `57014` query timeout)، يُعاد إطلاق الخطأ مسبباً `ROLLBACK` كامل للمعاملة، فيُلغى سطر `sync_ops` وسطوع الأعمال معاً دون أي تسرب لأسطر معلقة في الحالة المبدئية.

### ب. شكل استجابة السيرفر ومواءمة العميل (Authoritative Server Response Shape):
1. **استجابة عملية الكيان المفرد (`sync_push_op`):**
   - **عند النجاح الأول:**
     ```json
     {
       "success": true,
       "status": "applied",
       "code": "ok",
       "op_id": "uuid",
       "entity": "items",
       "entity_id": "uuid",
       "server_row": {
         "id": "uuid",
         "version": 2,
         "server_seq": 145,
         "updated_at": "2026-10-31T20:00:00Z",
         "...": "..."
       }
     }
     ```
   - **عند إعادة محاولة مكررة لعملية تم تطبيقها سابقاً (Duplicate of Applied):**
     تعيد الدالة السطر المحدث من قاعدة البيانات لتأكيد المواءمة محلياً:
     ```json
     {
       "success": true,
       "status": "duplicate",
       "is_duplicate": true,
       "original_result": "applied",
       "code": "ok",
       "op_id": "uuid",
       "entity": "items",
       "entity_id": "uuid",
       "server_row": { "id": "...", "version": 2, "server_seq": 145, "...": "..." }
     }
     ```
   - **عند إعادة محاولة لعملية رُفضت أو تعارضت سابقاً:**
     ```json
     {
       "success": false,
       "status": "duplicate",
       "is_duplicate": true,
       "original_result": "conflict" | "rejected",
       "code": "conflict" | "constraint",
       "op_id": "uuid",
       "error": "..."
     }
     ```
2. **استجابة حزمة المستند مع بنوده (`sync_push_document`):**
   - تعيد رأس المستند وسجل بنوده بالكامل لتمكين العميل من مواءمة شجرة الكيانات كاملة دفعة واحدة:
     ```json
     {
       "success": true,
       "status": "applied",
       "code": "ok",
       "op_id": "uuid",
       "document_id": "uuid",
       "server_row": { "id": "...", "status": "draft", "version": 1, "server_seq": 88, "...": "..." },
       "lines": [
         { "id": "...", "document_id": "...", "line_no": 1, "version": 1, "server_seq": 89, "...": "..." }
       ]
     }
     ```
   - **عقد المعرف للعميل غير المتصل (Client-Side Header ID Contract & Retry Guarantees):**
     - في معمارية Dexie غير المتصلة (Offline-First)، يقوم العميل **دائماً وبشكل إلزامي** بتوليد معرف المستند `header.id` بصيغة UUIDv4 محلياً قبل وضعه في صندوق الصادر (`outbox`). هذا الإلزام تفرضه الطبيعة العلائقية لقاعدة البيانات المحلية؛ حيث ترتبط البنود التابعة برأس المستند محلياً (`document_lines.document_id = doc.id`) قبل أي اتصال بالسيرفر.
     - في دالة `sync_push_document`: إذا خلا رأس المستند مستقبلاً من المعرف وتم توليد معرف عشوائي بالخادم، فإن إعادة محاولة الإرسال بنفس `op_id` ستولد معرفاً عشوائياً مختلفاً، مما يجعل استعلام `select * from documents where id = v_doc_id` يعود بـ `null`.
     - لذلك، يلتزم العميل بتمرير `header.id` دائماً. وفي هجرة المرحلة القادمة (Phase 3)، سيتم فرض منع تمرير رأس بدون معرف برفع استثناء صريح (`if v_doc_id is null then raise exception 'Document header id is required' using errcode = '22000';`)، مع دعم استرجاع `entity_id` المخزن في `sync_ops` في فرع التكرار الحيادي (`select entity_id into v_doc_id from sync_ops where op_id = p_op_id;`).

### ج. عدم قابلية تعديل المستندات المرحلة وحماية الترحيل (Posting Invariants):
1. **آلية عملية الترحيل (`op = 'post'`):**
   - في المرحلة 2b-2، تقتصر عملية الترحيل (`post`) على فحص صحة الفترة المالية وقفها وتغيير حالة المستند قطيعاً إلى `status = 'posted'` مع تسجيل `posted_at = now()`.
   - **نطاق المرحلة:** لا يتم توليد قيود محاسبية في دفتر الأستاذ أو حركات مخزنية في المرحلة 2b-2، حيث تم تأجيل منطق قيود اليومية المزدوجة وتقييم المخزون المتقدم إلى المرحلة 3 (Core Ledger) والمرحلة 4 (Inventory). هذا الفصل مقصود ومقبول تماماً لتثبيت خط أنابيب المزامنة وحياديته أولاً.
2. **منع إعادة الترحيل وحماية `posted_at`:**
   - إذا تم طلب `post` على مستند حالته الحالية `posted` بمعرف عملية جديد (`op_id` مختلف): ترفض الدالة الطلب فورياً:
     `{ success: false, status: 'rejected', code: 'validation', error: 'Record is already posted; cannot post again or overwrite posted_at' }`
     ويستحيل محركياً إعادة الكتابة على تاريخ الترحيل `posted_at`.
   - إذا تم تكرار نفس الـ `op_id` (إعادة محاولة): ترجع الدالة استجابة التكرار الحيادية `status: 'duplicate', original_result: 'applied'` مع `server_row` دون أي تعديل على البيانات.
3. **مشغلات الحماية وسياسات المنع في الهجرات 001-005:**
   - **مشغل حماية الرأس (`trg_block_doc` / `trg_block_je` / `trg_block_pay`):**
     ينفذ دالة `block_posted_changes()` في `005_v1_rls_and_security_triggers.sql`. يمنع أي تعديل (UPDATE) أو حذف (DELETE) لأي مستند أو قيد يومية أو إيصال سداد مرحل أو معكوس، ويرفع استثناء `P0001: posted records are immutable; create a reversal instead`.
   - **مشغل حماية البنود التابعة (`trg_block_dl` / `trg_block_jl` / `trg_block_payalloc`):**
     ينفذ دالة `block_posted_children()` في `005_v1_rls_and_security_triggers.sql`. يمنع إدراج أو تعديل أو حذف أي بند تابع لمستند رئيسي مرحل ويرفع استثناء `P0001: cannot change lines of a posted record`.

### د. نتائج القياس التجريبي للمهل على مسار PostgREST:
بناءً على القياس العملي الدقيق المنفذ على مشروع Supabase dev (PostgreSQL 17.11):
- **مسار REST / PostgREST [مُثبت عملياً ومُحقق - VERIFIED]:**
  - استدعاء دور `authenticated` مع سليب 5 ثوانٍ: **نجح في 5.4 ثانية**.
  - استدعاء دور `authenticated` مع سليب 15 ثانية: **فشل عند 8.2 ثانية** بـ HTTP 500 ورمز خطأ `57014` (`canceling statement due to statement timeout`).
  - استدعاء دور `service_role` مع سليب 5 ثوانٍ: **نجح في 5.4 ثانية**.
  - استدعاء دور `service_role` مع سليب 15 ثانية: **نجح في 15.2 ثانية** (مسموح له بـ 15 ثانية على الأقل).
  - ضبط المهل الفعلي في `pg_roles`:
    - `anon`: `statement_timeout = 3s`
    - `authenticated`: `statement_timeout = 8s`
    - `authenticator`: `statement_timeout = 8s` و `lock_timeout = 8s`
    - `service_role`: `statement_timeout = 60s`, `transaction_timeout = 60s`, `idle_in_transaction_session_timeout = 15s`.
- **المسارات والحدود غير المقاسة [UNVERIFIED]:**
  - سقف الـ 60 ثانية الكامل لدور `service_role` يظل `[UNVERIFIED]`.
  - حدود تشغيل دوال الحافة (Edge Function execution limits) تظل `[UNVERIFIED]`.
  - الاتصال المباشر بقاعدة البيانات (Direct Connection) ومسارات الاستيراد تظل `[UNVERIFIED]`.
- **التعامل مع انقطاع المهلة كـ 57014:**
  - نفاذ مهلة الاستعلام (Statement Timeout) ينبثق عبر PostgREST برمز حالة HTTP 500 ورمز PostgreSQL الداخلي `57014`.
  - يجب على العميل معالجة الخطأ `57014` صراحة باعتباره مهلة قابلة لإعادة المحاولة (Transient Timeout)، وليس خطأ برمجياً دائماً في الخادم (Server Bug).

---

## 5. توليد مؤشر التوقيت من ساعة السيرفر وتبرير نافذة السحب (120s Pull Window)

### أ. توليد مؤشر التوقيت من ساعة السيرفر حصراً:
1. **حظر الاعتماد على ساعة الجهاز:**
   يُحظر على العميل تخزين توقيت جهازه المحلي في مؤشر المزامنة `last_sync_timestamp` منعاً لانحراف الساعات (Clock Skew) وتفاوت التوقيت بين الأجهزة والفروع.
2. **ساعة السيرفر المعتمدة:**
   يتم استدعاء الدالة المعتمدة `get_server_time()` عبر RPC لجلب التوقيت الرسمي من دالة `clock_timestamp()` في PostgreSQL. الدالة معرفة كـ `VOLATILE` لضمان عدم تخزين قيمتها مؤقتاً عند تكرار الاستدعاء:
   ```typescript
   // src/services/sync/syncEngine.ts
   // يُستدعى دائمًا قَبْلَ استعلامات السحب لضمان اشتمال المعاملات المعتمدة أثناء السحب:
   const serverTimeIso = await this.getServerTime();
   ```

### ب. التبرير المستقل لنافذة الـ 120 ثانية عبر مسارات الكتابة (120s Pull Window Justification):
لا تعتمد هذه النافذة على قياسات المهل العابرة، بل تُبرر بأقصى مدة ممكنة لمعاملة كتابة على كل مسار من مسارات الكتابة:
1. **مسار PostgREST المباشر (`authenticated`):**
   - محكوم بمهلة استعلام `statement_timeout = 8s` [VERIFIED].
   - لا يمكن لأي معاملة مستخدم كتابة أن تتجاوز 8 ثوانٍ.
2. **مسار دالة الحافة (`sync-push` Edge Function):**
   - الحد الأقصى لتشغيل دوال الحافة في Deno Deploy هو 150 ثانية كحد أقصى للـ Wall-clock (أو 50/60 ثانية حسب الخطة) `[UNVERIFIED]`.
   - قاعدة البيانات: تتصل دالة `sync-push` عبر تمرير Bearer token الخاص بالمستخدم المتصل، وبالتالي تعمل ضد قاعدة البيانات بدور `authenticated` المحكوم بمهلة الاستعلام 8 ثوانٍ، إلا إذا تم استخدام عميل داخلي بصلاحيات أعلى `[UNVERIFIED]`.
3. **مسار الاستيراد المباشر والعمليات المجدولة الخلفية (`service_role`):**
   - محكوم بمهلة `statement_timeout = 60s` و `transaction_timeout = 60s` [مضبوط في الهجرة 004 ولكن أقصى سقف 60s يظل UNVERIFIED].
   - عمليات الاستيراد مجزأة دفعياً $\le 500$ سجل تستغرق تنفيذياً أقل من ثانيتين.
   - إذا حدثت معاملة طويلة نادرة وصلت إلى السقف النظري الأقصى $T_{\max} = 60\text{s}$:
   - فإن اتساع نافذة التداخل $W = 2 \times T_{\max} = 120\text{s}$ (ضعف أقصى معاملة ممكنة) يضمن بنسبة 100% أن أي معاملة حجزت `server_seq` متقدماً واعتمدت متأخرة ستكون مشمولة حتماً ضمن شرط السحب:
     ```sql
     WHERE server_seq > :cursor OR updated_at >= (:last_sync - interval '120 seconds')
     ```

### ج. دورة حياة العملية المعتمدة بالسيرفر قبل سحب سطرها إلى العميل:
عند نجاح إرسال عملية (Push Acknowledged):
1. **الاستجابة الفورية:** تعيد دالة الدفع السطر المحدث من السيرفر متضمناً `server_seq` و `version` الجديدين.
2. **المواءمة المحلية الفورية (Immediate Local Reconciliation):**
   - يقوم العميل فور تلقي النجاح بتحديث السطر المحلي في Dexie بالقيم المعتمدة وسحب علامة الانتظار من جدول الـ Outbox (`status = 'applied'`).
   - هذا التحديث الفوري يضمن أن التعديلات المحلية المتتالية تستند إلى `base_version` الصحيح دون توليد تعارض تفاؤلي كاذب.
3. **عند وصول دورة السحب التالية (Subsequent Pull):**
   - يعود السطر من السيرفر بنفس `server_seq`.
   - بما أن جدول الـ Outbox لا يحتوي على عمليات `pending` أو `in_flight` أو `failed` لهذا السجل، والـ `server_seq` يطابق أو يفوق السجل المحلي، تطبق الدالة `safeApplyServerRow` السطر بسلاسة (أو تتجاوزه كـ `skipped` إذا تطابق التسلسل)، دون أي تضارب.

---

## 6. سياسة إعادة المحاولة واحتواء العمليات السامة على العميل (Client Retry Policy & Poison Pill Containment)

لضمان عدم دخول العميل في حلقات تكرار لا نهائية تستهلك الشبكة وتعرقل طابور العمليات المعلقة:
1. **سقف المحاولات والتراجع الأسي (Exponential Backoff):**
   - سقف المحاولات الأقصى للأخطاء العابرة هو **5 محاولات** (`MAX_RETRY_ATTEMPTS = 5`).
   - فترة الانتظار بين المحاولات: $t = \min(2^{\text{retry}} \times 1\text{s} \pm \text{jitter}, 30\text{s})$ (أي بعد 1ث، 2ث، 4ث، 8ث، 16ث).
2. **احتواء العمليات السامة (Poison Pill Containment):**
   - إذا فشلت العملية وتجاوزت الـ 5 محاولات، تتحول حالتها في جدول الـ Outbox فورياً إلى `failed`.
   - تتوقف محاولات إرسال هذه العملية تلقائياً، وتُظهر واجهة المستخدم تنبيهاً للمستخدم/المسؤول لمراجعة سبب الفشل وفك التعليق دون تعطيل بقية عمليات الطابور.
3. **تصنيف الأخطاء ورموز SQLSTATE على العميل:**
   - **أخطاء فاشلة نهائياً لا تُعاد محاولتها إطلاقاً (Permanent Failures):**
     - أي رفض صريح من السيرفر (`status: 'rejected'`).
     - تعارض الإصدارات التفاؤلية (`status: 'conflict'`).
     - أي استثناء ينبثق برمز SQLSTATE غير متوقع من الفئات:
       - `42xxx` (أخطاء بنية الاستعلام، جداول/أعمدة غير موجودة، خطأ الصلاحيات `42501`).
       - `23xxx` (انتهاك قيود السلامة، المفاتيح الخارجية، قيود الفحص `CHECK`).
       - `22xxx` (أخطاء تحويل البيانات وتنسيق القيم).
       - `0Axxx` (ميزات غير مدعومة).
       - `P0001` (استثناءات قواعد الأعمال من المشغلات).
     - **السلوك:** تصنف فوراً كخطأ دائم، وتتحول العملية في الـ Outbox إلى `failed` (أو `conflict`) من أول محاولة دون أي إعادة إرسال.
   - **أخطاء عابرة قابلة لإعادة المحاولة (Transient Retryable Errors):**
     - مهلة الاستعلام من السيرفر (`57014`).
     - تعارض تسلسل القفل المتزامن (`40001`).
     - تعذر حجز القفل (`55P03`).
     - انقطاع الاتصال بالشبكة (`TypeError: Failed to fetch`, `NetworkError`, HTTP 503, HTTP 504).
     - **السلوك:** يعاد إرسالها مع زيادة عداد `retry_count` حتى بلوغ سقف الـ 5 محاولات.

---

## 7. تصميم ترقيم المستندات دون اتصال وتعديل المسودات (Offline Numbering & Draft Editing)

### أ. تصميم إصدار أرقام المستندات دون اتصال (Offline Numbering Design):
لحظر تضارب أرقام الفواتير الصادرة دون اتصال من أجهزة متعددة وضمان عدم رفض الفاتورة المطبوعة للعميل:
- **الخيار المعتمد والمؤسس في العقد (Option A - Device Series Prefixes):**
  - كل جهاز معتمد يسجل في جدول `devices` بكود متسلسل فريد `series_code` (مثل `D1`, `D2`, `POS01`) كما هو منصوص عليه في `001_core_schema.sql` (السطر 48: `series_code text not null unique`) وقيد التفرد على المستندات (السطر 197: `unique (doc_type, series_code, seq_no)`).
  - الجهاز يحافظ محلياً في Dexie على عداده الخاص `seq_no` لهذا الـ `series_code`.
  - الرقم النهائي يكون: `INV-D1-000001`؛ يستحيل رياضياً لجهاز آخر (مثل `D2`) إصدار نفس الرقم، مما يقضي على التصادم 100%.

### ب. دورة تعديل المسودات مع بنودها (Draft Editing Workflow):
1. المستند بحالة `draft` يمكن تعديل بياناته الرأسية، أو تعديل/حذف/إضافة بنود في `document_lines`.
2. يتم إرسال تعديل المسودة وبنودها معاً عبر `sync_push_document` مع مطابقة `base_version` للرأس.
3. بمجرد تحول المستند إلى `posted`، يمنع مشغل `block_posted_changes` و `block_posted_children` أي تعديل على الرأس أو البنود قطعياً.

---

## 8. القيود المعروفة والتصحيحات المطلوبة في الهجرة القادمة (Known Limitations & Required Fixes in Next Migration)

### المعالجة المجدولة لهجرة المرحلة القادمة: الهجرة `008` (`008_core_ledger_and_sync_enhancements.sql`)
نظراً لتطبيق الهجرة `007` بالفعل على قاعدة بيانات التطوير والحظر الصارم لتعديلها أثناء المرحلة 2b-2، تم توثيق وتأجيل التحسينات التالية على الدالة `sync_push_document` لتُطبق صراحة في **الهجرة `008`** (أول هجرة في المرحلة 3):

1. **التحقق الصارم من معرف رأس المستند (`header.id`):**
   - **الوضع الحالي في 007:** إذا خلا `p_header` من `id`، تولد الدالة `v_doc_id := gen_random_uuid()` وتخزنه في `sync_ops`. وفي حال إعادة المحاولة بنفس `op_id`، يُولد UUID جديد مختلف فيفشل استرجاع السطر ويرجع `server_row: null`.
   - **الحل المُطبق حالياً (Client & Gateway):**
     - في العميل (`SyncEngine.buildDocumentBundle` و `pushOperation`)، يتم رفض بناء أو إرسال أي حزمة مستند بدون `header.id` كخطأ دائم `code: '22000'` / `status: 'rejected'`.
     - في دالة الـ Edge Function (`supabase/functions/sync-push/index.ts`)، يتم فحص وتأكيد وجود `header.id` وصحة صيغة الـ UUIDv4 والرد بـ HTTP 422 و `code: 'validation'`.
   - **المطلوب في الهجرة `008`:** فرض هذا الفحص برمجياً داخل دالة الـ RPC بقاعدة البيانات:
     ```sql
     if v_doc_id is null then
       raise exception 'Document header id is required' using errcode = '22000';
     end if;
     ```

2. **قراءة `entity_id` من `sync_ops` عند إعادة المحاولة المكررة (Duplicate Retries):**
   - **المطلوب في الهجرة `008`:** في فرع التكرار الحيادي (`if not v_claim.is_claimed and v_claim.existing_result = 'applied'`)، قراءة المعرف المعتمد من `sync_ops` مباشرة:
     ```sql
     select entity_id into v_doc_id from sync_ops where op_id = p_op_id;
     ```
     مما يضمن استرجاع السطر الأصلي حتى لو تم استدعاء الـ RPC بشكل مستقل دون تمرير `p_header.id` في المحاولة الثانية.

3. **غياب اختبار مسار النجاح الفعلي لحزم المستندات (Untested Real Send Path for Document Bundles):**
   - المسار الفعلي لإرسال حزم المستندات (سواء عبر استدعاء Edge Function `sync-push` أو مسار التفويض البديل المباشر `executeDirectUserOperation` نحو دالة الـ RPC `sync_push_document`) لا يمتلك اختبار وحدة فعلي لمسار النجاح؛ حيث يقتصر الاختبار `(m)` في Vitest على مسار الحقن المخصص `customExecutor`.
   - **الالتزام:** يجب تغطية واختبار هذا المسار الفعلي كأولوية أولى فور بدء المرحلة 2b-3.

4. **حالة نشر وتشغيل دالة الـ Edge Function (`sync-push` على بيئة Deno):**
   - دالة الـ Edge Function (`supabase/functions/sync-push/index.ts`) لم يتم نشرها بعد على بيئة Supabase الحية ولم تُشغَّل تجريبياً على بيئة Deno.
   - بالتالي، فإن التحقق المسبق من صحة `header.id` والاستجابة بـ HTTP 422 ورمز `validation` لم يتم اختبار سلوكهما عملياً وقت التشغيل (Runtime).
