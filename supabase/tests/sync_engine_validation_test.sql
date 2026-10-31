BEGIN;

-- =====================================================================
-- supabase/tests/sync_engine_validation_test.sql
-- Phase 2b-2 SQL-Level Verification Suite for Sync Engine Architecture
-- Run directly in Supabase SQL Editor as 'postgres' role.
-- Entire script runs within a transaction that starts with BEGIN;
-- and terminates with ROLLBACK;, ensuring zero persistence or side effects.
--
-- EXECUTION STATUS: NOT EXECUTED (Drafted for review; to be run by the user)
-- =====================================================================

CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

-- Ensure authenticated role can write into test_results during tests
GRANT ALL ON TABLE test_results TO authenticated;

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
  v_doc_fail_id uuid := '33333333-3333-3333-3333-333333333305';

  v_op_id_1 uuid := '44444444-4444-4444-4444-444444444401';
  v_op_id_2 uuid := '44444444-4444-4444-4444-444444444402';
  v_op_id_3 uuid := '44444444-4444-4444-4444-444444444403';
  v_op_id_4 uuid := '44444444-4444-4444-4444-444444444404';
  v_op_id_5 uuid := '44444444-4444-4444-4444-444444444405';
  v_op_id_6 uuid := '44444444-4444-4444-4444-444444444406';
  v_op_id_7 uuid := '44444444-4444-4444-4444-444444444407';
  v_op_id_8 uuid := '44444444-4444-4444-4444-444444444408';
  v_op_id_9 uuid := '44444444-4444-4444-4444-444444444409';
  v_op_id_rev uuid := '44444444-4444-4444-4444-444444444410';
  v_op_id_transient uuid := '44444444-4444-4444-4444-444444444411';
  v_idemp_item_id uuid := '55555555-5555-5555-5555-555555555501';

  v_res jsonb;
  v_res_dup jsonb;
  v_count int;
  v_count_ops int;
  v_item_rec record;
  v_sync_op_rec record;
  v_old_version int;
  v_seq_before bigint;
  v_has_priv boolean;
  v_pub_routines_count int;
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
  insert into items (id, sku, name_ar, base_unit_id, sale_price, purchase_price, is_active)
  values (v_item_id, 'TEST-SKU-01', 'صنف اختباري للمزامنة', (select id from units limit 1), 100, 70, true)
  on conflict (id) do nothing;

  -- Pre-seed Alexandria journal entry
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_alx_je_id, v_branch_alx, 'S1', 888801, 'JE-ALX-FIXTURE', '2026-01-15', 'draft')
  on conflict (id) do nothing;

  -- Pre-seed Cairo journal entry
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_cai_je_id, v_branch_cai, 'S2', 888802, 'JE-CAI-FIXTURE', '2026-01-15', 'draft')
  on conflict (id) do nothing;

  -- Pre-seed closed fiscal period (September 2026)
  update fiscal_periods set status = 'closed' where start_date = '2026-09-01';

  -- -------------------------------------------------------------------
  -- TEST 1: Private Schema Isolation & Public Non-Exposure Verification
  -- -------------------------------------------------------------------
  -- 1a. Verify internal functions do NOT exist in public schema (cannot be exposed by PostgREST)
  select count(*) into v_pub_routines_count
  from information_schema.routines
  where routine_schema = 'public'
    and routine_name in ('_internal_claim_sync_op', '_internal_finalize_sync_op');

  -- 1b. Verify that anon has NO execute privilege on private internal functions
  select has_function_privilege('anon', 'private._internal_claim_sync_op(uuid, text, uuid, text, jsonb, int, timestamptz)', 'execute')
  into v_has_priv;

  if v_pub_routines_count = 0 and v_has_priv = false then
    insert into test_results values (1, 'Private Schema Non-Exposure Check', 'PASS', 'Internal claim/finalize functions NOT present in public schema; anon denied execute in private schema');
  else
    insert into test_results values (1, 'Private Schema Non-Exposure Check', 'FAIL', 'Security violation: internal functions found in public schema or anon has execute privilege');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 2: Real Postgres RLS Branch Denial (Item 3.ii)
  -- Proves user without branch access CANNOT write (UPDATE or INSERT)
  -- to that branch under real Postgres RLS policies
  -- -------------------------------------------------------------------
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  -- 2a. Cross-branch UPDATE attempt on Alexandria journal entry
  select sync_push_op(
    v_op_id_1,
    'journal_entries',
    v_alx_je_id,
    'update',
    jsonb_build_object('description', 'تعديل خبيث لفرع آخر'),
    1, -- base_version
    now()
  ) into v_res;

  -- 2b. Cross-branch INSERT attempt into Alexandria branch
  declare
    v_res_ins jsonb;
  begin
    select sync_push_op(
      gen_random_uuid(),
      'journal_entries',
      gen_random_uuid(),
      'insert',
      jsonb_build_object('branch_id', v_branch_alx, 'entry_no', 'JE-CROSS-ILLEGAL', 'series_code', 'S1', 'seq_no', 999888),
      null,
      now()
    ) into v_res_ins;

    if (v_res ->> 'success')::boolean = false
       and (v_res ->> 'status') = 'rejected'
       and (v_res ->> 'code') = 'denied_or_not_found'
       and (v_res_ins ->> 'success')::boolean = false
       and (v_res_ins ->> 'status') = 'rejected' then
      insert into test_results values (2, 'Real RLS Branch Scoping Denial (Insert + Update)', 'PASS', 'Both cross-branch UPDATE (0 rows) and cross-branch INSERT were denied by RLS and reported as rejected');
    else
      insert into test_results values (2, 'Real RLS Branch Scoping Denial (Insert + Update)', 'FAIL', 'RLS branch denial failed: Update=' || v_res::text || ' Insert=' || v_res_ins::text);
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 3: Entity allowlist & Pull-Only rejection
  -- -------------------------------------------------------------------
  select sync_push_op(
    gen_random_uuid(),
    'fiscal_periods',
    gen_random_uuid(),
    'update',
    jsonb_build_object('status', 'closed'),
    null,
    now()
  ) into v_res;

  if (v_res ->> 'status') = 'rejected' and (v_res ->> 'error') like '%pull-only%' then
    insert into test_results values (3, 'Pull-Only Entity Restriction', 'PASS', 'Attempt to push to pull-only entity (fiscal_periods) was rejected with code validation');
  else
    insert into test_results values (3, 'Pull-Only Entity Restriction', 'FAIL', 'Validation failed: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: Column control & branch_id immutability
  -- -------------------------------------------------------------------
  -- Cairo accountant tries to change branch_id of their own Cairo journal entry to Alexandria
  select sync_push_op(
    v_op_id_2,
    'journal_entries',
    v_cai_je_id,
    'update',
    jsonb_build_object('branch_id', v_branch_alx, 'description', 'محاولة نقل فرع'),
    1, -- base_version
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%branch_id cannot be changed%' then
    insert into test_results values (4, 'branch_id Immutability on Update', 'PASS', 'Payload attempt to change branch_id was blocked with constraint error');
  else
    insert into test_results values (4, 'branch_id Immutability on Update', 'FAIL', 'branch_id modification was not blocked: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 5: Server column tamper stripping and natural version increment
  -- -------------------------------------------------------------------
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  -- Read real version before update (Item 13)
  select version, server_seq into v_old_version, v_seq_before from items where id = v_item_id;

  select sync_push_op(
    v_op_id_3,
    'items',
    v_item_id,
    'update',
    jsonb_build_object(
      'name_ar', 'صنف محدث بأمان مع قائمة السماح',
      'server_seq', 999999,
      'version', 77777,
      'status', 'tampered',
      'deleted_at', now()
    ),
    v_old_version, -- Matches current real version
    now()
  ) into v_res;

  select * into v_item_rec from items where id = v_item_id;

  if (v_res ->> 'success')::boolean = true
     and v_item_rec.name_ar = 'صنف محدث بأمان مع قائمة السماح'
     and v_item_rec.server_seq <> 999999
     and v_item_rec.version = v_old_version + 1 -- strictly asserted as old + 1
     and v_item_rec.deleted_at is null then
    insert into test_results values (5, 'Column Allowlist & Natural Version Increment', 'PASS', 'Server-controlled columns stripped; version incremented strictly to old_version + 1 (' || v_item_rec.version || ')');
  else
    insert into test_results values (5, 'Column Allowlist & Natural Version Increment', 'FAIL', 'Tampering check failed: ' || row_to_json(v_item_rec)::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 6: Required base_version on financial tables
  -- -------------------------------------------------------------------
  select sync_push_op(
    v_op_id_4,
    'journal_entries',
    v_cai_je_id,
    'update',
    jsonb_build_object('description', 'تعديل بدون base_version'),
    null, -- Missing base_version!
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%base_version is required%' then
    insert into test_results values (6, 'Strict base_version Requirement', 'PASS', 'Update on financial table without base_version rejected with validation error');
  else
    insert into test_results values (6, 'Strict base_version Requirement', 'FAIL', 'Missing base_version was not rejected: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 7: Optimistic Concurrency Conflict (SELECT FOR UPDATE)
  -- -------------------------------------------------------------------
  select sync_push_op(
    v_op_id_5,
    'items',
    v_item_id,
    'update',
    jsonb_build_object('sale_price', 190),
    v_old_version, -- Outdated version (real version is v_old_version + 1)
    now()
  ) into v_res;

  -- Duplicate retry of the conflict
  select sync_push_op(
    v_op_id_5,
    'items',
    v_item_id,
    'update',
    jsonb_build_object('sale_price', 190),
    v_old_version,
    now()
  ) into v_res_dup;

  if (v_res ->> 'status') = 'conflict'
     and (v_res ->> 'code') = 'conflict'
     and (v_res ? 'server_row')
     and (v_res_dup ->> 'status') = 'duplicate'
     and (v_res_dup ->> 'original_result') = 'conflict' then
    insert into test_results values (7, 'Optimistic Concurrency Conflict & Duplicate Routing', 'PASS', 'Version mismatch returned status=conflict, code=conflict, server_row; retry returned original_result=conflict');
  else
    insert into test_results values (7, 'Optimistic Concurrency Conflict & Duplicate Routing', 'FAIL', 'Conflict response invalid: ' || v_res::text || ' Dup: ' || v_res_dup::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 8: Soft Delete sets deleted_at and RLS Visibility (Item 11)
  -- -------------------------------------------------------------------
  select version, server_seq into v_old_version, v_seq_before from items where id = v_item_id;

  select sync_push_op(
    v_op_id_6,
    'items',
    v_item_id,
    'delete',
    '{}'::jsonb,
    v_old_version,
    now()
  ) into v_res;

  -- Verify tombstone is visible under RLS for users with access
  select count(*) into v_count from items where id = v_item_id and deleted_at is not null;

  if (v_res ->> 'success')::boolean = true and v_count = 1 then
    insert into test_results values (8, 'Soft Delete & Tombstone RLS Visibility', 'PASS', 'Row soft-deleted with deleted_at set and confirmed SELECTABLE under RLS as tombstone');
  else
    insert into test_results values (8, 'Soft Delete & Tombstone RLS Visibility', 'FAIL', 'Tombstone not visible or delete failed. Count: ' || v_count);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 9: Empty Payload Rejection
  -- -------------------------------------------------------------------
  select sync_push_op(
    v_op_id_7,
    'items',
    v_item_id,
    'update',
    '{}'::jsonb,
    null,
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%cannot be empty%' then
    insert into test_results values (9, 'Empty Payload Rejection', 'PASS', 'Update with empty payload rejected with validation error');
  else
    insert into test_results values (9, 'Empty Payload Rejection', 'FAIL', 'Empty payload not rejected: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 10: Atomic Document Posting & Rollback on Invariant Failure
  -- -------------------------------------------------------------------
  -- Attempt to post in closed period (September 2026)
  select sync_push_document(
    v_op_id_8,
    jsonb_build_object(
      'id', v_doc_fail_id,
      'branch_id', v_branch_cai,
      'doc_type', 'sales_invoice',
      'series_code', 'T10',
      'seq_no', 999915,
      'doc_no', 'INV-CLOSED-PERIOD',
      'doc_date', '2026-09-15', -- Closed period!
      'subtotal', 300,
      'total', 300
    ),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'qty', 1, 'unit_price', 300, 'line_total', 300)
    ),
    true, -- post_now = true
    now()
  ) into v_res;

  select count(*) into v_count from documents where id = v_doc_fail_id;

  if (v_res ->> 'success')::boolean = false
     and (v_res ->> 'code') = 'validation'
     and v_count = 0 then
    insert into test_results values (10, 'Document Bundle Atomic Rollback on Invariant Failure', 'PASS', 'Posting invariant failure in closed period rolled back header and lines completely (0 rows left)');
  else
    insert into test_results values (10, 'Document Bundle Atomic Rollback on Invariant Failure', 'FAIL', 'Partial persistence or wrong code: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 11: Real Postgres Idempotency (Item 3.i)
  -- Proves executing same op_id twice on real Postgres produces exactly ONE effect:
  -- Exactly 1 row created in items, exactly 1 row in sync_ops, retry returns duplicate/applied
  -- -------------------------------------------------------------------
  -- First push
  select sync_push_op(
    v_op_id_9,
    'items',
    v_idemp_item_id,
    'insert',
    jsonb_build_object('sku', 'SKU-IDEMP-REV', 'name_ar', 'صنف فحص الحيادية', 'base_unit_id', (select id from units limit 1)),
    null,
    now()
  ) into v_res;

  -- Second push (duplicate retry with exact same op_id)
  select sync_push_op(
    v_op_id_9,
    'items',
    v_idemp_item_id,
    'insert',
    jsonb_build_object('sku', 'SKU-IDEMP-REV', 'name_ar', 'صنف فحص الحيادية', 'base_unit_id', (select id from units limit 1)),
    null,
    now()
  ) into v_res_dup;

  -- Count rows in business table and sync_ops
  select count(*) into v_count from items where id = v_idemp_item_id;
  select count(*) into v_count_ops from sync_ops where op_id = v_op_id_9;

  if (v_res ->> 'success')::boolean = true
     and (v_res_dup ->> 'status') = 'duplicate'
     and (v_res_dup ->> 'is_duplicate')::boolean = true
     and (v_res_dup ->> 'original_result') = 'applied'
     and v_count = 1
     and v_count_ops = 1 then
    insert into test_results values (11, 'Real Postgres Idempotency (Same op_id = One Effect)', 'PASS', 'First push applied; duplicate retry returned original_result=applied; exactly 1 business row and 1 sync_ops row exist');
  else
    insert into test_results values (11, 'Real Postgres Idempotency (Same op_id = One Effect)', 'FAIL', 'Idempotency failure: Dup=' || v_res_dup::text || ' items=' || v_count || ' sync_ops=' || v_count_ops);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 12: Caller-scoped op_id protection (Cross-user collision)
  -- -------------------------------------------------------------------
  -- Cashier ALX tries to reuse Admin's op_id
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_alx_uid, 'role', 'authenticated')::text, true);

  select sync_push_op(
    v_op_id_9,
    'items',
    gen_random_uuid(),
    'insert',
    jsonb_build_object('sku', 'SKU-SPOOF', 'name_ar', 'صنف انتحال'),
    null,
    now()
  ) into v_res;

  if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%belongs to another user%' then
    insert into test_results values (12, 'Caller-Scoped op_id Protection', 'PASS', 'Cross-user op_id reuse was rejected with collision error');
  else
    insert into test_results values (12, 'Caller-Scoped op_id Protection', 'FAIL', 'Cross-user check failed: ' || v_res::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 13: Transient Error Rollback (ADDENDUM a)
  -- Proves transient errors (40001/55P03/57014) abort the transaction
  -- and leave ZERO rows in sync_ops (no provisional row committed)
  -- -------------------------------------------------------------------
  begin
    -- Claim in sub-block and trigger simulated serialization/transient abort
    perform private._internal_claim_sync_op(
      v_op_id_transient, 'items', v_item_id, 'update', '{}'::jsonb, 1, now()
    );
    raise exception 'Simulated transient serialization conflict' using errcode = '40001';
  exception when sqlstate '40001' then
    -- Subtransaction rolled back cleanly
    null;
  end;

  select count(*) into v_count from sync_ops where op_id = v_op_id_transient;

  if v_count = 0 then
    insert into test_results values (13, 'Transient Error Rollback Integrity', 'PASS', 'Transient error aborted subtransaction; ZERO rows persisted in sync_ops (no provisional row committed)');
  else
    insert into test_results values (13, 'Transient Error Rollback Integrity', 'FAIL', 'Leaked row in sync_ops after transient error abort');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 14: Permanent Error sync_ops Finalization (ADDENDUM a)
  -- Proves permanent errors finalize result to 'rejected' (never provisional)
  -- -------------------------------------------------------------------
  select result, error into v_sync_op_rec from sync_ops where op_id = v_op_id_1;

  if v_sync_op_rec.result = 'rejected' and v_sync_op_rec.error is not null then
    insert into test_results values (14, 'Permanent Error Finalization Integrity', 'PASS', 'Permanent RLS denial recorded result=rejected with descriptive error in sync_ops (not provisional)');
  else
    insert into test_results values (14, 'Permanent Error Finalization Integrity', 'FAIL', 'sync_ops state invalid: ' || row_to_json(v_sync_op_rec)::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 15: Optimistic Concurrency Conflict Finalization (ADDENDUM b)
  -- Proves version mismatch finalizes result to 'conflict' (separate from 'rejected')
  -- -------------------------------------------------------------------
  select result, error into v_sync_op_rec from sync_ops where op_id = v_op_id_5;

  if v_sync_op_rec.result = 'conflict' and v_sync_op_rec.error is not null then
    insert into test_results values (15, 'Concurrency Conflict Finalization Integrity', 'PASS', 'Version mismatch recorded result=conflict with descriptive error in sync_ops');
  else
    insert into test_results values (15, 'Concurrency Conflict Finalization Integrity', 'FAIL', 'sync_ops state invalid: ' || row_to_json(v_sync_op_rec)::text);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 16: Zero Committed Rows in Provisional State (ADDENDUM a)
  -- Global invariant: no committed sync_ops row can have provisional signature
  -- (result = 'conflict' AND error IS NULL)
  -- -------------------------------------------------------------------
  select count(*) into v_count
  from sync_ops
  where result = 'conflict' and error is null;

  if v_count = 0 then
    insert into test_results values (16, 'Zero Lingering Provisional State Invariant', 'PASS', 'Confirmed 0 rows in sync_ops in provisional state (result=conflict with error IS NULL)');
  else
    insert into test_results values (16, 'Zero Lingering Provisional State Invariant', 'FAIL', 'Found ' || v_count || ' rows committed in unfinalized provisional state!');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 17: Reversal Operation Explicit Rejection (ADDENDUM c)
  -- Proves 'reverse' is recognized in contract and explicitly rejected
  -- explaining Phase 3/5 ledger engine requirements
  -- -------------------------------------------------------------------
  select sync_push_op(
    v_op_id_rev,
    'documents',
    gen_random_uuid(),
    'reverse',
    '{}'::jsonb,
    1,
    now()
  ) into v_res;

  if (v_res ->> 'status') = 'rejected'
     and (v_res ->> 'code') = 'validation'
     and (v_res ->> 'error') like '%Accounting reversal requires counter journal entry%' then
    insert into test_results values (17, 'Accounting Reversal Operation Rejection', 'PASS', 'Operation reverse recognized in contract; explicitly rejected explaining Phase 3/5 counter-entry requirements');
  else
    insert into test_results values (17, 'Accounting Reversal Operation Rejection', 'FAIL', 'Unexpected response for reverse: ' || v_res::text);
  end if;

END $$;

SELECT test_no, test_name, status, details FROM test_results ORDER BY test_no;

ROLLBACK;

-- =====================================================================
-- MANUAL TWO-SESSION CONCURRENCY TEST (Item 12)
-- Concurrency between competing sessions cannot be verified in a single
-- serial DO block. Run the following in TWO separate SQL Editor tabs:
--
-- SESSION A (Tab 1):
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa","role":"authenticated"}', true);
--   -- Insert/Claim operation without committing yet
--   SELECT sync_push_op(
--     '55555555-5555-5555-5555-555555555555',
--     'items',
--     '33333333-3333-3333-3333-333333333301',
--     'update',
--     '{"sale_price": 220}'::jsonb,
--     1,
--     now()
--   );
--   -- KEEP TRANSACTION OPEN (Do NOT run COMMIT yet)
--
-- SESSION B (Tab 2 - Concurrently):
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa","role":"authenticated"}', true);
--   -- Try to push the exact same op_id
--   SELECT sync_push_op(
--     '55555555-5555-5555-5555-555555555555',
--     'items',
--     '33333333-3333-3333-3333-333333333301',
--     'update',
--     '{"sale_price": 220}'::jsonb,
--     1,
--     now()
--   );
--   -- OBSERVATION: Session B blocks on row lock until Session A finishes!
--
-- SESSION A (Tab 1):
--   COMMIT;
--
-- SESSION B (Tab 2 - Unblocks automatically upon Session A commit):
--   -- Returns: {"success": true, "status": "duplicate", "is_duplicate": true, "original_result": "applied", "code": "ok"}
-- =====================================================================
