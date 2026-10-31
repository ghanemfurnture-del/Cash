BEGIN;

-- =====================================================================
-- supabase/tests/sync_engine_validation_test.sql
-- Phase 2b-2 SQL-Level Verification Suite for Sync Engine Architecture
-- Run directly in Supabase SQL Editor as 'postgres' role.
-- Entire script runs within a transaction that starts with BEGIN;
-- and terminates with ROLLBACK;, ensuring zero persistence or side effects.
-- =====================================================================

CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

DO $$
DECLARE
  v_admin_uid uuid := 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
  v_accountant_cai_uid uuid := 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
  v_cashier_alx_uid uuid := 'cccccccc-0000-0000-0000-cccccccccccc';

  v_branch_cai uuid;
  v_branch_alx uuid := '22222222-2222-2222-2222-222222222202';

  v_role_admin uuid;
  v_role_acc uuid;
  v_role_csh uuid;

  v_item_id uuid := '33333333-3333-3333-3333-333333333301';
  v_alx_je_id uuid := '33333333-3333-3333-3333-333333333302';
  v_cai_je_id uuid := '33333333-3333-3333-3333-333333333303';
  v_doc_atomic_id uuid := '33333333-3333-3333-3333-333333333304';
  v_doc_fail_id uuid := '33333333-3333-3333-3333-333333333305';

  v_op_id_1 uuid := '44444444-4444-4444-4444-444444444401';
  v_op_id_2 uuid := '44444444-4444-4444-4444-444444444402';
  v_op_id_3 uuid := '44444444-4444-4444-4444-444444444403';
  v_op_id_4 uuid := '44444444-4444-4444-4444-444444444404';
  v_op_id_5 uuid := '44444444-4444-4444-4444-444444444405';
  v_op_id_6 uuid := '44444444-4444-4444-4444-444444444406';
  v_op_id_7 uuid := '44444444-4444-4444-4444-444444444407';
  v_op_id_8 uuid := '44444444-4444-4444-4444-444444444408';

  v_res jsonb;
  v_res_dup jsonb;
  v_count int;
  v_item_rec record;
  v_deleted_at timestamptz;
  v_seq_before bigint;
  v_seq_after bigint;
BEGIN
  -- -------------------------------------------------------------------
  -- 0. FIXTURES SETUP
  -- -------------------------------------------------------------------
  select id into v_role_admin from roles where name = 'Admin';
  select id into v_role_acc from roles where name = 'Accountant';
  select id into v_role_csh from roles where name = 'Cashier';

  -- Create test users in auth.users
  begin
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
      (v_admin_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_admin@cash.local', now(), now()),
      (v_accountant_cai_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_acc@cash.local', now(), now()),
      (v_cashier_alx_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_csh@cash.local', now(), now())
    on conflict (id) do nothing;
  exception when others then
    insert into auth.users (id, aud, role, email, created_at, updated_at) values
      (v_admin_uid, 'authenticated', 'authenticated', 'test_admin@cash.local', now(), now()),
      (v_accountant_cai_uid, 'authenticated', 'authenticated', 'test_acc@cash.local', now(), now()),
      (v_cashier_alx_uid, 'authenticated', 'authenticated', 'test_csh@cash.local', now(), now())
    on conflict (id) do nothing;
  end;

  -- Create test profiles
  insert into profiles (id, full_name, role_id, is_active) values
    (v_admin_uid, 'مدير اختبار النظام (Admin)', v_role_admin, true),
    (v_accountant_cai_uid, 'محاسب فرع القاهرة (Accountant CAI)', v_role_acc, true),
    (v_cashier_alx_uid, 'كاشير فرع الإسكندرية (Cashier ALX)', v_role_csh, true)
  on conflict (id) do update
  set full_name = excluded.full_name, role_id = excluded.role_id, is_active = excluded.is_active;

  -- Branches
  select id into v_branch_cai from branches where code = 'MAIN';
  if v_branch_cai is null then
    insert into branches (code, name_ar, is_main, is_active)
    values ('MAIN', 'الفرع الرئيسي', true, true)
    returning id into v_branch_cai;
  end if;

  insert into branches (id, code, name_ar, is_main, is_active)
  values (v_branch_alx, 'TEST_ALX_SYNC', 'فرع الإسكندرية (اختبار مزامنة)', false, true)
  on conflict (code) do update set is_active = true
  returning id into v_branch_alx;

  -- User branch assignments
  insert into user_branches (user_id, branch_id) values
    (v_accountant_cai_uid, v_branch_cai),
    (v_cashier_alx_uid, v_branch_alx)
  on conflict (user_id, branch_id) do nothing;

  -- Pre-seed test item in items table
  insert into items (id, sku, name_ar, base_unit_id, sale_price, purchase_price, version)
  values (v_item_id, 'TEST-SKU-01', 'صنف اختباري للمزامنة', (select id from units limit 1), 100, 70, 2)
  on conflict (id) do nothing;

  -- Pre-seed Alexandria journal entry
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_alx_je_id, v_branch_alx, 'S1', 888801, 'JE-ALX-FIXTURE', '2026-01-15', 'draft')
  on conflict (id) do nothing;

  -- Pre-seed closed fiscal period (September 2026)
  update fiscal_periods set status = 'closed' where start_date = '2026-09-01';

  -- -------------------------------------------------------------------
  -- TEST 1: Silent RLS denial prevention (0 rows affected reported as rejected)
  -- -------------------------------------------------------------------
  -- Cairo accountant tries to update an Alexandria entry (hidden by RLS)
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  select sync_push_op(
    v_op_id_1,
    'journal_entries',
    v_alx_je_id,
    'update',
    jsonb_build_object('description', 'تعديل خبيث لفرع آخر'),
    null,
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'status') = 'rejected' and (v_res ->> 'error') like '%affected 0 rows%' then
    insert into test_results values (1, 'Non-Silent RLS Denial', 'PASS', 'Update affecting 0 rows due to RLS was correctly detected and reported as rejected: ' || (v_res ->> 'error'));
  else
    insert into test_results values (1, 'Non-Silent RLS Denial', 'FAIL', 'Expected rejection with 0 rows affected, received: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 2: Entity allowlist & Invalid operation rejection
  -- -------------------------------------------------------------------
  -- Attempt to mutate 'profiles' (forbidden entity)
  select sync_push_op(
    crypto.randomUUID(),
    'profiles',
    v_accountant_cai_uid,
    'update',
    jsonb_build_object('role_id', v_role_admin),
    null,
    now()
  ) into v_res;

  -- Attempt unknown operation 'hack'
  select sync_push_op(
    crypto.randomUUID(),
    'items',
    v_item_id,
    'hack',
    jsonb_build_object('sale_price', 999),
    null,
    now()
  ) into v_res_dup;

  if (v_res ->> 'status') = 'rejected' and (v_res_dup ->> 'status') = 'rejected' then
    insert into test_results values (2, 'Entity & Op Allowlist Enforcement', 'PASS', 'Non-allowlisted entity (profiles) and invalid op (hack) were immediately rejected');
  else
    insert into test_results values (2, 'Entity & Op Allowlist Enforcement', 'FAIL', 'Validation failed: ' || v_res::text || ' | ' || v_res_dup::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 3: Column control (Server-controlled columns stripped from payload)
  -- -------------------------------------------------------------------
  -- Switch to Admin to update item
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  select server_seq into v_seq_before from items where id = v_item_id;

  select sync_push_op(
    v_op_id_2,
    'items',
    v_item_id,
    'update',
    jsonb_build_object(
      'name_ar', 'صنف محدث بأمان',
      'server_seq', 999999,      -- Attempted server_seq tampering
      'version', 88888,          -- Attempted version tampering
      'status', 'tampered',      -- Attempted status tampering
      'deleted_at', now()        -- Attempted fake deletion
    ),
    2, -- Matches server version 2
    now()
  ) into v_res;

  select * into v_item_rec from items where id = v_item_id;

  if (v_res ->> 'success')::boolean = true
     and v_item_rec.name_ar = 'صنف محدث بأمان'
     and v_item_rec.server_seq <> 999999
     and v_item_rec.version = 3 -- naturally incremented by stamp_row(), not 88888
     and v_item_rec.deleted_at is null then
    insert into test_results values (3, 'Column Control & Tamper Stripping', 'PASS', 'Payload server_seq, version, status, and deleted_at were stripped; only business columns updated');
  else
    insert into test_results values (3, 'Column Control & Tamper Stripping', 'FAIL', 'Tampering succeeded! Item state: ' || row_to_json(v_item_rec)::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: Optimistic Concurrency Conflict on version mismatch
  -- -------------------------------------------------------------------
  -- Server item is now version 3. Client attempts update assuming base_version = 1.
  select sync_push_op(
    v_op_id_3,
    'items',
    v_item_id,
    'update',
    jsonb_build_object('sale_price', 150),
    1, -- Outdated base_version (current is 3)
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%Optimistic concurrency conflict%' then
    insert into test_results values (4, 'Optimistic Concurrency Control', 'PASS', 'Version mismatch was detected and rejected with concurrency conflict error');
  else
    insert into test_results values (4, 'Optimistic Concurrency Control', 'FAIL', 'Concurrency conflict was not detected: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 5: Soft Delete (deleted_at = now()) and Tombstone Stamping
  -- -------------------------------------------------------------------
  select server_seq into v_seq_before from items where id = v_item_id;

  select sync_push_op(
    v_op_id_4,
    'items',
    v_item_id,
    'delete',
    '{}'::jsonb,
    3, -- Current version 3
    now()
  ) into v_res;

  select deleted_at, server_seq into v_deleted_at, v_seq_after from items where id = v_item_id;

  if (v_res ->> 'success')::boolean = true
     and v_deleted_at is not null
     and v_seq_after > v_seq_before then
    insert into test_results values (5, 'Soft Delete & Tombstone Propagation', 'PASS', 'Row soft-deleted (deleted_at set) and stamped with new server_seq for client pull propagation');
  else
    insert into test_results values (5, 'Soft Delete & Tombstone Propagation', 'FAIL', 'Soft delete failed or sequence not updated. deleted_at: ' || coalesce(v_deleted_at::text, 'NULL'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 6: Same op_id twice = exactly ONE effect (Idempotency)
  -- -------------------------------------------------------------------
  -- First push with unique op_id v_op_id_5 (insert new item)
  select sync_push_op(
    v_op_id_5,
    'items',
    crypto.randomUUID(),
    'insert',
    jsonb_build_object('sku', 'SKU-IDEMP-01', 'name_ar', 'صنف اختبار الحيادية', 'base_unit_id', (select id from units limit 1)),
    null,
    now()
  ) into v_res;

  -- Second push with exact same op_id v_op_id_5
  select sync_push_op(
    v_op_id_5,
    'items',
    crypto.randomUUID(),
    'insert',
    jsonb_build_object('sku', 'SKU-IDEMP-01', 'name_ar', 'صنف اختبار الحيادية', 'base_unit_id', (select id from units limit 1)),
    null,
    now()
  ) into v_res_dup;

  select count(*) into v_count from items where sku = 'SKU-IDEMP-01';

  if (v_res ->> 'success')::boolean = true
     and (v_res_dup ->> 'status') = 'duplicate'
     and (v_res_dup ->> 'is_duplicate')::boolean = true
     and (v_res_dup ->> 'original_result') = 'applied'
     and v_count = 1 then
    insert into test_results values (6, 'Push Idempotency (Same op_id Twice)', 'PASS', 'Retry returned duplicate with original_result=applied, producing exactly one database row');
  else
    insert into test_results values (6, 'Push Idempotency (Same op_id Twice)', 'FAIL', 'Idempotency failure. Count: ' || v_count || ', res2: ' || v_res_dup::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 7: Caller-scoped op_id protection (Cross-user collision rejection)
  -- -------------------------------------------------------------------
  -- Cashier ALX attempts to push using Admin's op_id (v_op_id_5)
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_alx_uid, 'role', 'authenticated')::text, true);

  select sync_push_op(
    v_op_id_5,
    'items',
    crypto.randomUUID(),
    'insert',
    jsonb_build_object('sku', 'SKU-HIJACK', 'name_ar', 'محاولة انتحال عملية مستخدم آخر'),
    null,
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%Operation ID collision%' then
    insert into test_results values (7, 'Caller-Scoped op_id Protection', 'PASS', 'Cross-user op_id reuse was rejected with collision error; cannot hijack other user operations');
  else
    insert into test_results values (7, 'Caller-Scoped op_id Protection', 'FAIL', 'Cross-user collision check failed: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 8: Atomic Document Posting with lines in ONE transaction
  -- -------------------------------------------------------------------
  -- Cashier ALX creates and posts sales invoice in assigned branch ALX
  select sync_push_document(
    v_op_id_6,
    jsonb_build_object(
      'id', v_doc_atomic_id,
      'branch_id', v_branch_alx,
      'doc_type', 'sales_invoice',
      'series_code', 'T8',
      'seq_no', 999911,
      'doc_no', 'INV-ATOMIC-01',
      'doc_date', '2026-01-25',
      'subtotal', 500,
      'total', 500
    ),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'qty', 2, 'unit_price', 250, 'line_total', 500)
    ),
    true, -- post_now = true
    now()
  ) into v_res;

  select count(*) into v_count from document_lines where document_id = v_doc_atomic_id;

  if (v_res ->> 'success')::boolean = true
     and (select status from documents where id = v_doc_atomic_id) = 'posted'
     and v_count = 1 then
    insert into test_results values (8, 'Atomic Document Bundle Push', 'PASS', 'Header, lines, and posted status applied atomically in ONE transaction');
  else
    insert into test_results values (8, 'Atomic Document Bundle Push', 'FAIL', 'Document bundle failed: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 9: Atomic Document Posting Rollback on Invariant Failure
  -- -------------------------------------------------------------------
  -- Attempt to post in a closed period (September 2026) -> Trigger will reject
  select sync_push_document(
    v_op_id_7,
    jsonb_build_object(
      'id', v_doc_fail_id,
      'branch_id', v_branch_alx,
      'doc_type', 'sales_invoice',
      'series_code', 'T9',
      'seq_no', 999912,
      'doc_no', 'INV-FAIL-CLOSED',
      'doc_date', '2026-09-15', -- Closed period!
      'subtotal', 200,
      'total', 200
    ),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'qty', 1, 'unit_price', 200, 'line_total', 200)
    ),
    true, -- post_now = true
    now()
  ) into v_res;

  select count(*) into v_count from documents where id = v_doc_fail_id;

  if (v_res ->> 'success')::boolean = false
     and (v_res ->> 'error') like '%no open fiscal period%'
     and v_count = 0 then
    insert into test_results values (9, 'Document Bundle Full Rollback', 'PASS', 'Posting invariant failure rolled back header and lines completely (0 draft/partial rows left)');
  else
    insert into test_results values (9, 'Document Bundle Full Rollback', 'FAIL', 'Partial persistence occurred! Docs found: ' || v_count || ', res: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 10: Branch-denied delete rejected by RLS
  -- -------------------------------------------------------------------
  -- Cairo accountant tries to soft-delete Alexandria document
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  select sync_push_op(
    v_op_id_8,
    'documents',
    v_doc_atomic_id,
    'delete',
    '{}'::jsonb,
    null,
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%affected 0 rows%' then
    insert into test_results values (10, 'Branch-Denied Soft Delete', 'PASS', 'Cross-branch delete affected 0 rows and was rejected by RLS');
  else
    insert into test_results values (10, 'Branch-Denied Soft Delete', 'FAIL', 'Cross-branch delete check failed: ' || v_res::text);
  end if;

END $$;

-- Tabular output
SELECT test_no, test_name, status, details FROM test_results ORDER BY test_no;

ROLLBACK;
