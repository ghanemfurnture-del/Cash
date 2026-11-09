# دليل تطبيق هجرة قاعدة البيانات 008 (Migration 008 Guide)

> **تنبيه أمان صارم:** لا تُطبّق هذه الهجرة تلقائياً ولا تتصل بالخادم السحابي من بيئة التطوير. يتم تطبيق هذا الملف يدوياً بواسطة مدير المشروع عبر لوحة تحكم Supabase SQL Editor.

---

## 1. أمان وإمكانية إعادة التشغيل على البيئة التطويرية (cash-dev)
إذا كانت الهجرة 008 قد طُبقت مسبقاً على بيئة التطوير `cash-dev`، فإن **إعادة تشغيل النسخة المعدلة آمنة تماماً** للأسباب التالية:
1. **استبدال الدوال في مكانها (`CREATE OR REPLACE FUNCTION`):** الهجرة لا تُعدل ولا تُنشئ أي جداول، بل تستبدل دالة `public.sync_push_document` مع دالة مساعدة معزولة `private._internal_get_sync_op_entity`.
2. **عدم المساس بالبيانات المخزنة:** لا يتم تعديل أي بيانات في جداول `documents` أو `document_lines` أو `sync_ops`.
3. **أحجام الملفات مهيأة للصق المباشر (أقل من 18 ألف حرف):**
   - ملف الهجرة [`008_sync_push_document_hardening.sql`](file:///e:/cash/supabase/migrations/008_sync_push_document_hardening.sql) حجمه **12,570 حرفاً** (أقل من 18k).
   - ملف الاختبار [`migration_008_validation_test.sql`](file:///e:/cash/supabase/tests/migration_008_validation_test.sql) حجمه **15,310 حرفاً** (أقل من 18k).
   كلا الملفين يُنسخ ويُلصق مباشرة دفعة واحدة في نافذة Supabase SQL Editor دون انقطاع أو بتر.

---

## 2. أهداف وتعديلات الهجرة 008 (`008_sync_push_document_hardening.sql`)
تُعالج هذه الهجرة جوانب المتانة والموثوقية في دالة `sync_push_document`:
1. **التحقق الصارم من معرف مستند الترويسة (`header.id`):**
   - التحقق من وجود المعرف ومطابقته لمعيار RFC 4122 (الإصدارات من 1 إلى 5، غير حساسة لحالة الأحرف):
     `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
   - في حال غياب المعرف أو تلف صيغته، تُرجع الدالة مباشرة كائناً برمجياً بحالة `status: 'rejected'` ورمز `code: 'validation'` و `sqlstate: '22000'`، مما يمنع إعادة المحاولة اللانهائية في العميل.
2. **استرجاع المعرف الموثوق في المحاولات المكررة عبر دالة معزولة الصلاحيات:**
   - جدول `sync_ops` معزول ومحمي، ولا يملك الدور `authenticated` صلاحية `SELECT` مباشرة عليه.
   - لقراءة `entity_id` في حالات المحاولات المكررة دون كسر أمان `SECURITY INVOKER` للدالة الرئيسية ودون فتح صلاحيات على الجدول، أُضيفت دالة مساعدة:
     `private._internal_get_sync_op_entity(p_op_id uuid) RETURNS uuid`
     بصلاحية `SECURITY DEFINER` و `SET search_path = private, public`، ومحصورة بدقة بشرط `user_id = auth.uid()`، مع حظر استدعائها من `anon` و `public` ومنح التنفيذ حصرياً لـ `authenticated`.
3. **التطابق الصارم مع هيكل الجداول الفعلي (001-007):**
   - إدخال البنود في `document_lines` بالأعمدة الفعلية:
     `description, qty, unit_factor (NOT NULL default 1), unit_price, discount_amount, tax_code_id, tax_rate, tax_amount, line_total, cost_center_id`
   - إدخال المستند بحالة مسودة أولاً (`status = 'draft'`) ثم التحديث إلى معتمد (`status = 'posted'`) عند طلب الاعتماد الفوري، احتراماً لمحفزات قاعدة البيانات ومنعاً لانتهاك محفز `block_posted_children`.

---

## 3. خطوات التطبيق اليدوي في Supabase SQL Editor

### الخطوة 1: فتح لوحة تحكم المشروع
1. ادخل إلى لوحة تحكم Supabase لمشروعك السحابي (`cash-dev`).
2. توجّه إلى قسم **SQL Editor** من القائمة الجانبية.
3. أنشئ استعلاماً جديداً (New Query).

### الخطوة 2: تطبيق الهجرة 008
1. انسخ محتويات الملف:
   [`supabase/migrations/008_sync_push_document_hardening.sql`](file:///e:/cash/supabase/migrations/008_sync_push_document_hardening.sql)
2. الصق المحتويات في نافذة SQL Editor (الملف 12.5k حرف ويلصق كاملاً).
3. اضغط **Run**.
4. تأكد من ظهور رسالة النجاح: `Success. No rows returned`.

---

## 4. خطوات التحقق والاختبار (Verification Drill)

1. افتح استعلاماً جديداً في SQL Editor.
2. انسخ محتويات ملف التحقق:
   [`supabase/tests/migration_008_validation_test.sql`](file:///e:/cash/supabase/tests/migration_008_validation_test.sql)
3. الصق المحتويات (الملف 15.3k حرف ويلصق كاملاً) واضغط **Run**.
4. الاستعلام سيعيد جدول الاختبارات السبعة مع حالتها وتفاصيلها.

> **ملاحظة:** ملف الاختبار محاط بمعاملة تبدأ بـ `BEGIN;` وتنتهي بأمر `ROLLBACK;`، لذلك لن يترك أي أثر أو بيانات تجريبية في قاعدة بياناتكم.

---

## 5. خطة التراجع (Rollback Procedure)

في حال الرغبة في التراجع والعودة إلى تعريف الهجرة 007 لدالة `sync_push_document`:

```sql
DROP FUNCTION IF EXISTS public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz);
DROP FUNCTION IF EXISTS private._internal_get_sync_op_entity(uuid);

-- إعادة تعريف الدالة كما كانت تماماً في 007
CREATE OR REPLACE FUNCTION public.sync_push_document(
  p_op_id uuid,
  p_header jsonb,
  p_lines jsonb,
  p_post_now boolean default false,
  p_client_ts timestamptz default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, private
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_claim record;
  v_doc_id uuid := (p_header ->> 'id')::uuid;
  v_allowed_header_cols text[] := array[
    'doc_type', 'series_code', 'seq_no', 'doc_no', 'doc_date', 'due_date',
    'party_id', 'warehouse_id', 'currency_code', 'exchange_rate', 'payment_method',
    'subtotal', 'discount_total', 'tax_total', 'total', 'notes', 'branch_id',
    'source', 'pos_shift_id'
  ];
  v_clean_header jsonb := '{}'::jsonb;
  v_line jsonb;
  v_line_no int;
  v_key text;
  v_col_list text;
  v_val_list text;
  v_code text;
  v_doc_row record;
  v_lines_data jsonb;
BEGIN
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated' using errcode = '42501';
  end if;

  if v_doc_id is null then
    v_doc_id := gen_random_uuid();
  end if;

  -- 1. Atomic Claim of op_id
  select * into v_claim from private._internal_claim_sync_op(
    p_op_id, 'documents', v_doc_id, case when p_post_now then 'post' else 'insert' end,
    p_header, null, p_client_ts
  );

  if v_claim.is_other_user then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Operation ID collision with another user'
    );
  end if;

  if not v_claim.is_claimed then
    if v_claim.existing_result = 'applied' then
      execute 'select * from documents where id = $1' into v_doc_row using v_doc_id;
      select coalesce(jsonb_agg(to_jsonb(l) order by l.line_no), '[]'::jsonb)
      into v_lines_data
      from document_lines l
      where l.document_id = v_doc_id;

      return jsonb_build_object(
        'success', true,
        'status', 'duplicate',
        'is_duplicate', true,
        'original_result', 'applied',
        'code', 'ok',
        'op_id', p_op_id,
        'document_id', v_doc_id,
        'server_row', to_jsonb(v_doc_row),
        'lines', v_lines_data
      );
    else
      return jsonb_build_object(
        'success', false,
        'status', 'duplicate',
        'is_duplicate', true,
        'original_result', v_claim.existing_result,
        'code', case
          when v_claim.existing_result = 'conflict' then 'conflict'
          else 'constraint'
        end,
        'op_id', p_op_id,
        'error', v_claim.existing_error
      );
    end if;
  end if;

  -- 2. Build clean header strictly from allowlist
  if p_header is not null then
    for v_key in select * from jsonb_object_keys(p_header) loop
      if v_key = any(v_allowed_header_cols) then
        v_clean_header := v_clean_header || jsonb_build_object(v_key, p_header -> v_key);
      end if;
    end loop;
  end if;

  begin
    -- 3. Insert Header strictly as draft
    select
      string_agg(quote_ident(key), ', '),
      string_agg(quote_nullable(value #>> '{}'), ', ')
    into v_col_list, v_val_list
    from jsonb_each(v_clean_header);

    if v_col_list is not null then
      execute format('insert into documents (id, status, %s) values ($1, ''draft'', %s)', v_col_list, v_val_list)
      using v_doc_id;
    else
      insert into documents (id, status) values (v_doc_id, 'draft');
    end if;

    -- 4. Insert Lines
    if p_lines is not null and jsonb_array_length(p_lines) > 0 then
      for v_line in select * from jsonb_array_elements(p_lines) loop
        v_line_no := coalesce((v_line ->> 'line_no')::int, 1);

        insert into document_lines (
          id, document_id, line_no, item_id, description, unit_id,
          qty, unit_factor, unit_price, discount_amount, tax_code_id,
          tax_rate, tax_amount, line_total, cost_center_id
        ) values (
          coalesce((v_line ->> 'id')::uuid, gen_random_uuid()),
          v_doc_id,
          v_line_no,
          (v_line ->> 'item_id')::uuid,
          v_line ->> 'description',
          (v_line ->> 'unit_id')::uuid,
          coalesce((v_line ->> 'qty')::numeric, 1),
          coalesce((v_line ->> 'unit_factor')::numeric, 1),
          coalesce((v_line ->> 'unit_price')::numeric, 0),
          coalesce((v_line ->> 'discount_amount')::numeric, 0),
          (v_line ->> 'tax_code_id')::uuid,
          coalesce((v_line ->> 'tax_rate')::numeric, 0),
          coalesce((v_line ->> 'tax_amount')::numeric, 0),
          coalesce((v_line ->> 'line_total')::numeric, 0),
          (v_line ->> 'cost_center_id')::uuid
        );
      end loop;
    end if;

    -- 5. Post Document (if requested)
    if p_post_now then
      update documents
      set status = 'posted',
          posted_at = now()
      where id = v_doc_id;
    end if;

    execute 'select * from documents where id = $1' into v_doc_row using v_doc_id;
    select coalesce(jsonb_agg(to_jsonb(l) order by l.line_no), '[]'::jsonb)
    into v_lines_data
    from document_lines l
    where l.document_id = v_doc_id;

    perform private._internal_finalize_sync_op(p_op_id, 'applied', null);

    return jsonb_build_object(
      'success', true,
      'status', 'applied',
      'code', 'ok',
      'op_id', p_op_id,
      'document_id', v_doc_id,
      'server_row', to_jsonb(v_doc_row),
      'lines', v_lines_data
    );

  exception when others then
    if sqlstate like '23%' or sqlstate like '22%' or sqlstate = '42501' or sqlstate = 'P0001' then
      v_code := case
        when sqlstate = '42501' then 'denied_or_not_found'
        when sqlstate like '23%' then 'constraint'
        else 'validation'
      end;

      perform private._internal_finalize_sync_op(p_op_id, 'rejected', sqlerrm);

      return jsonb_build_object(
        'success', false,
        'status', 'rejected',
        'code', v_code,
        'op_id', p_op_id,
        'error', sqlerrm,
        'sqlstate', sqlstate
      );
    else
      raise;
    end if;
  end;
END;
$$;

revoke all on function public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz) from public, anon;
grant execute on function public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz) to authenticated;
```
