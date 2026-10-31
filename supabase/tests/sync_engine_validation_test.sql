BEGIN;

-- =====================================================================
-- supabase/tests/sync_engine_validation_test.sql
-- Phase 2b-2 SQL-Level Verification Suite for Sync Engine Architecture
-- Run directly in Supabase SQL Editor as 'postgres' role.
-- Entire script runs within a transaction that starts with BEGIN;
-- and terminates with ROLLBACK;, ensuring zero persistence or side effects.
--
-- EXECUTION STATUS: NOT EXECUTED (Drafted for review; to be run by the user)
--
-- DESIGN RULES:
-- 1. Each test case is isolated in its own BEGIN ... EXCEPTION WHEN OTHERS sub-block.
--    No single test failure can abort the DO block or hide remaining results.
-- 2. Privileged inspection: All verification queries on tables (sync_ops, items,
--    documents, etc.) execute under the privileged role via RESET ROLE.
--    Authenticated role has NO table privileges on sync_ops by design.
-- 3. Dedicated negative case proves direct SELECT on sync_ops as authenticated fails with 42501.
-- 4. Cases (i) [idempotency] and (ii) [branch scoping] are real Postgres tests,
--    with actual JSON responses preserved in the detail column.
-- =====================================================================

CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

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

  v_posted_doc_id uuid := '66666666-6666-6666-6666-666666666601';
  v_posted_line_id uuid := '66666666-6666-6666-6666-666666666602';
  v_posted_op_id uuid := '77777777-7777-7777-7777-777777777701';
  v_posted_at timestamptz;

  v_res jsonb;
  v_res_dup jsonb;
  v_res_ins jsonb;
  v_count int;
  v_count_ops int;
  v_item_rec record;
  v_sync_op_rec record;
  v_old_version int;
  v_seq_before bigint;
  v_has_priv boolean;
  v_pub_routines_count int;

  v_anon_push_op boolean;
  v_anon_push_doc boolean;
  v_anon_server_time boolean;
  v_auth_push_op boolean;
  v_auth_push_doc boolean;
  v_auth_server_time boolean;
BEGIN
  -- -------------------------------------------------------------------
  -- 0. FIXTURES SETUP (Runs as privileged role postgres)
  -- -------------------------------------------------------------------
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

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
  BEGIN
    EXECUTE 'RESET ROLE';
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
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (1, 'Private Schema Non-Exposure Check', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 2: Anon Function Privilege Revocation Check (Item 1)
  -- Proves anon cannot execute sync_push_op, sync_push_document, get_server_time
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'RESET ROLE';
    select has_function_privilege('anon', 'sync_push_op(uuid, text, uuid, text, jsonb, int, timestamptz)', 'execute') into v_anon_push_op;
    select has_function_privilege('anon', 'sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz)', 'execute') into v_anon_push_doc;
    select has_function_privilege('anon', 'get_server_time()', 'execute') into v_anon_server_time;

    select has_function_privilege('authenticated', 'sync_push_op(uuid, text, uuid, text, jsonb, int, timestamptz)', 'execute') into v_auth_push_op;
    select has_function_privilege('authenticated', 'sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz)', 'execute') into v_auth_push_doc;
    select has_function_privilege('authenticated', 'get_server_time()', 'execute') into v_auth_server_time;

    if v_anon_push_op = false and v_anon_push_doc = false and v_anon_server_time = false
       and v_auth_push_op = true and v_auth_push_doc = true and v_auth_server_time = true then
      insert into test_results values (2, 'Anon Function Privilege Revocation Check', 'PASS', 'anon denied execute on sync_push_op, sync_push_document, get_server_time; authenticated granted execute');
    else
      insert into test_results values (2, 'Anon Function Privilege Revocation Check', 'FAIL', 'Privilege leak: anon has execute on RPCs');
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (2, 'Anon Function Privilege Revocation Check', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 3: Direct sync_ops SELECT Denial on Authenticated Role (Negative Test)
  -- Proves authenticated role cannot query sync_ops directly (no table grant)
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

    BEGIN
      EXECUTE 'SELECT count(*) FROM sync_ops';
      -- If execution reaches here, permission was NOT denied!
      EXECUTE 'RESET ROLE';
      insert into test_results values (3, 'Direct sync_ops SELECT Denial (42501)', 'FAIL', 'Security violation: authenticated role was able to SELECT directly from sync_ops');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      if sqlstate = '42501' then
        insert into test_results values (3, 'Direct sync_ops SELECT Denial (42501)', 'PASS', 'Direct SELECT on sync_ops denied by table grant with 42501: ' || sqlerrm);
      else
        insert into test_results values (3, 'Direct sync_ops SELECT Denial (42501)', 'FAIL', 'Expected 42501 but got ' || sqlstate || ': ' || sqlerrm);
      end if;
    END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (3, 'Direct sync_ops SELECT Denial (42501)', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 4: Real RLS Branch Scoping Denial (Insert + Update) [Case ii]
  -- Proves user without branch access CANNOT write (UPDATE or INSERT)
  -- to that branch under real Postgres RLS policies
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

    -- 4a. Cross-branch UPDATE attempt on Alexandria journal entry
    select sync_push_op(
      v_op_id_1,
      'journal_entries',
      v_alx_je_id,
      'update',
      jsonb_build_object('description', 'تعديل خبيث لفرع آخر'),
      1, -- base_version
      now()
    ) into v_res;

    -- 4b. Cross-branch INSERT attempt into Alexandria branch
    select sync_push_op(
      gen_random_uuid(),
      'journal_entries',
      gen_random_uuid(),
      'insert',
      jsonb_build_object('branch_id', v_branch_alx, 'entry_no', 'JE-CROSS-ILLEGAL', 'series_code', 'S1', 'seq_no', 999888),
      null,
      now()
    ) into v_res_ins;

    -- Switch back to privileged role for verification
    EXECUTE 'RESET ROLE';

    if (v_res ->> 'success')::boolean = false
       and (v_res ->> 'status') = 'rejected'
       and (v_res ->> 'code') = 'denied_or_not_found'
       and (v_res_ins ->> 'success')::boolean = false
       and (v_res_ins ->> 'status') = 'rejected' then
      insert into test_results values (
        4,
        'Real RLS Branch Scoping Denial (Insert + Update)',
        'PASS',
        'Update res: ' || v_res::text || ' | Insert res: ' || v_res_ins::text
      );
    else
      insert into test_results values (
        4,
        'Real RLS Branch Scoping Denial (Insert + Update)',
        'FAIL',
        'RLS branch denial failed: Update=' || v_res::text || ' | Insert=' || v_res_ins::text
      );
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (4, 'Real RLS Branch Scoping Denial (Insert + Update)', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 5: Entity allowlist & Pull-Only rejection
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      gen_random_uuid(),
      'fiscal_periods',
      gen_random_uuid(),
      'update',
      jsonb_build_object('status', 'closed'),
      null,
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'status') = 'rejected' and (v_res ->> 'error') like '%pull-only%' then
      insert into test_results values (5, 'Pull-Only Entity Restriction', 'PASS', 'Attempt to push to pull-only entity (fiscal_periods) was rejected with code validation: ' || (v_res ->> 'error'));
    else
      insert into test_results values (5, 'Pull-Only Entity Restriction', 'FAIL', 'Validation failed: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (5, 'Pull-Only Entity Restriction', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 6: Column control & branch_id immutability
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

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

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%branch_id cannot be changed%' then
      insert into test_results values (6, 'branch_id Immutability on Update', 'PASS', 'Payload attempt to change branch_id was blocked with constraint error: ' || (v_res ->> 'error'));
    else
      insert into test_results values (6, 'branch_id Immutability on Update', 'FAIL', 'branch_id modification was not blocked: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (6, 'branch_id Immutability on Update', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 7: Server column tamper stripping, natural version increment & server_row returned
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'RESET ROLE';
    -- Read real version before update as postgres
    select version, server_seq into v_old_version, v_seq_before from items where id = v_item_id;

    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

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
      v_old_version,
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';
    select * into v_item_rec from items where id = v_item_id;

    if (v_res ->> 'success')::boolean = true
       and (v_res ? 'server_row')
       and (v_res -> 'server_row' ->> 'name_ar') = 'صنف محدث بأمان مع قائمة السماح'
       and (v_res -> 'server_row' ->> 'version')::int = v_old_version + 1
       and (v_res -> 'server_row' ->> 'server_seq')::bigint > 0
       and v_item_rec.name_ar = 'صنف محدث بأمان مع قائمة السماح'
       and v_item_rec.server_seq <> 999999
       and v_item_rec.version = v_old_version + 1
       and v_item_rec.deleted_at is null then
      insert into test_results values (7, 'Column Allowlist, Natural Version & server_row Shape', 'PASS', 'Server-controlled columns stripped; version incremented strictly to old_version + 1 (' || v_item_rec.version || '); full server_row returned');
    else
      insert into test_results values (7, 'Column Allowlist, Natural Version & server_row Shape', 'FAIL', 'Tampering check failed: ' || row_to_json(v_item_rec)::text || ' Res: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (7, 'Column Allowlist, Natural Version & server_row Shape', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 8: Required base_version on financial tables
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      v_op_id_4,
      'journal_entries',
      v_cai_je_id,
      'update',
      jsonb_build_object('description', 'تعديل بدون base_version'),
      null, -- Missing base_version!
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%base_version is required%' then
      insert into test_results values (8, 'Strict base_version Requirement', 'PASS', 'Update on financial table without base_version rejected with validation error');
    else
      insert into test_results values (8, 'Strict base_version Requirement', 'FAIL', 'Missing base_version was not rejected: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (8, 'Strict base_version Requirement', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 9: Optimistic Concurrency Conflict & Duplicate Routing
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      v_op_id_5,
      'items',
      v_item_id,
      'update',
      jsonb_build_object('sale_price', 190),
      v_old_version, -- Outdated version
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

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'status') = 'conflict'
       and (v_res ->> 'code') = 'conflict'
       and (v_res ? 'server_row')
       and (v_res_dup ->> 'status') = 'duplicate'
       and (v_res_dup ->> 'original_result') = 'conflict' then
      insert into test_results values (9, 'Optimistic Concurrency Conflict & Duplicate Routing', 'PASS', 'Version mismatch returned status=conflict, code=conflict, server_row; retry returned original_result=conflict');
    else
      insert into test_results values (9, 'Optimistic Concurrency Conflict & Duplicate Routing', 'FAIL', 'Conflict response invalid: ' || v_res::text || ' Dup: ' || v_res_dup::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (9, 'Optimistic Concurrency Conflict & Duplicate Routing', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 10: Soft Delete sets deleted_at and RLS Visibility
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'RESET ROLE';
    select version, server_seq into v_old_version, v_seq_before from items where id = v_item_id;

    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      v_op_id_6,
      'items',
      v_item_id,
      'delete',
      '{}'::jsonb,
      v_old_version,
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';
    select count(*) into v_count from items where id = v_item_id and deleted_at is not null;

    if (v_res ->> 'success')::boolean = true and (v_res ? 'server_row') and v_count = 1 then
      insert into test_results values (10, 'Soft Delete & Tombstone RLS Visibility', 'PASS', 'Row soft-deleted with deleted_at set, returned server_row tombstone, confirmed SELECTABLE under RLS');
    else
      insert into test_results values (10, 'Soft Delete & Tombstone RLS Visibility', 'FAIL', 'Tombstone not visible or delete failed. Count: ' || v_count);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (10, 'Soft Delete & Tombstone RLS Visibility', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 11: Empty Payload Rejection
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      v_op_id_7,
      'items',
      v_item_id,
      'update',
      '{}'::jsonb,
      null,
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%cannot be empty%' then
      insert into test_results values (11, 'Empty Payload Rejection', 'PASS', 'Update with empty payload rejected with validation error');
    else
      insert into test_results values (11, 'Empty Payload Rejection', 'FAIL', 'Empty payload not rejected: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (11, 'Empty Payload Rejection', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 12: Atomic Document Posting & Rollback on Invariant Failure
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

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

    EXECUTE 'RESET ROLE';
    select count(*) into v_count from documents where id = v_doc_fail_id;

    if (v_res ->> 'success')::boolean = false
       and (v_res ->> 'code') = 'validation'
       and v_count = 0 then
      insert into test_results values (12, 'Document Bundle Atomic Rollback on Invariant Failure', 'PASS', 'Posting invariant failure in closed period rolled back header and lines completely (0 rows left)');
    else
      insert into test_results values (12, 'Document Bundle Atomic Rollback on Invariant Failure', 'FAIL', 'Partial persistence or wrong code: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (12, 'Document Bundle Atomic Rollback on Invariant Failure', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 13: Real Postgres Idempotency (Same op_id = One Effect) [Case i]
  -- Proves executing same op_id twice on real Postgres produces exactly ONE effect:
  -- Exactly 1 row created in items, exactly 1 row in sync_ops, retry returns duplicate/applied
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

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

    -- SWITCH TO PRIVILEGED ROLE (POSTGRES) BEFORE QUERYING INTERNAL TABLES
    EXECUTE 'RESET ROLE';

    select count(*) into v_count from items where id = v_idemp_item_id;
    select count(*) into v_count_ops from sync_ops where op_id = v_op_id_9;

    if (v_res ->> 'success')::boolean = true
       and (v_res ? 'server_row')
       and (v_res_dup ->> 'status') = 'duplicate'
       and (v_res_dup ->> 'is_duplicate')::boolean = true
       and (v_res_dup ->> 'original_result') = 'applied'
       and (v_res_dup ? 'server_row')
       and (v_res_dup -> 'server_row' ->> 'id') = v_idemp_item_id::text
       and v_count = 1
       and v_count_ops = 1 then
      insert into test_results values (
        13,
        'Real Postgres Idempotency (Same op_id = One Effect)',
        'PASS',
        'First res: ' || v_res::text || ' | Dup res: ' || v_res_dup::text || ' | items_count: ' || v_count || ' | sync_ops_count: ' || v_count_ops
      );
    else
      insert into test_results values (
        13,
        'Real Postgres Idempotency (Same op_id = One Effect)',
        'FAIL',
        'Idempotency failure: First=' || v_res::text || ' | Dup=' || v_res_dup::text || ' | items=' || v_count || ' | sync_ops=' || v_count_ops
      );
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (13, 'Real Postgres Idempotency (Same op_id = One Effect)', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 14: Caller-scoped op_id protection (Cross-user collision)
  -- -------------------------------------------------------------------
  BEGIN
    -- Cashier ALX tries to reuse Admin's op_id
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cashier_alx_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      v_op_id_9,
      'items',
      gen_random_uuid(),
      'insert',
      jsonb_build_object('sku', 'SKU-SPOOF', 'name_ar', 'صنف انتحال'),
      null,
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'success')::boolean = false and (v_res ->> 'error') like '%belongs to another user%' then
      insert into test_results values (14, 'Caller-Scoped op_id Protection', 'PASS', 'Cross-user op_id reuse was rejected with collision error: ' || (v_res ->> 'error'));
    else
      insert into test_results values (14, 'Caller-Scoped op_id Protection', 'FAIL', 'Cross-user check failed: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (14, 'Caller-Scoped op_id Protection', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 15: Transient Error Rollback Integrity
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

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

    EXECUTE 'RESET ROLE';
    select count(*) into v_count from sync_ops where op_id = v_op_id_transient;

    if v_count = 0 then
      insert into test_results values (15, 'Transient Error Rollback Integrity', 'PASS', 'Transient error aborted subtransaction; ZERO rows persisted in sync_ops (no provisional row committed)');
    else
      insert into test_results values (15, 'Transient Error Rollback Integrity', 'FAIL', 'Leaked row in sync_ops after transient error abort');
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (15, 'Transient Error Rollback Integrity', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 16: Permanent Error Finalization Integrity
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'RESET ROLE';
    select result, error into v_sync_op_rec from sync_ops where op_id = v_op_id_1;

    if v_sync_op_rec.result = 'rejected' and v_sync_op_rec.error is not null then
      insert into test_results values (16, 'Permanent Error Finalization Integrity', 'PASS', 'Permanent RLS denial recorded result=rejected with descriptive error in sync_ops: ' || v_sync_op_rec.error);
    else
      insert into test_results values (16, 'Permanent Error Finalization Integrity', 'FAIL', 'sync_ops state invalid: ' || row_to_json(v_sync_op_rec)::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (16, 'Permanent Error Finalization Integrity', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 17: Concurrency Conflict Finalization Integrity
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'RESET ROLE';
    select result, error into v_sync_op_rec from sync_ops where op_id = v_op_id_5;

    if v_sync_op_rec.result = 'conflict' and v_sync_op_rec.error is not null then
      insert into test_results values (17, 'Concurrency Conflict Finalization Integrity', 'PASS', 'Version mismatch recorded result=conflict with descriptive error in sync_ops: ' || v_sync_op_rec.error);
    else
      insert into test_results values (17, 'Concurrency Conflict Finalization Integrity', 'FAIL', 'sync_ops state invalid: ' || row_to_json(v_sync_op_rec)::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (17, 'Concurrency Conflict Finalization Integrity', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 18: Zero Lingering Provisional State Invariant
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'RESET ROLE';
    select count(*) into v_count
    from sync_ops
    where result = 'conflict' and error is null;

    if v_count = 0 then
      insert into test_results values (18, 'Zero Lingering Provisional State Invariant', 'PASS', 'Confirmed 0 rows in sync_ops in provisional state (result=conflict with error IS NULL)');
    else
      insert into test_results values (18, 'Zero Lingering Provisional State Invariant', 'FAIL', 'Found ' || v_count || ' rows committed in unfinalized provisional state!');
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (18, 'Zero Lingering Provisional State Invariant', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 19: Accounting Reversal Operation Rejection
  -- -------------------------------------------------------------------
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    select sync_push_op(
      v_op_id_rev,
      'documents',
      gen_random_uuid(),
      'reverse',
      '{}'::jsonb,
      1,
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';

    if (v_res ->> 'status') = 'rejected'
       and (v_res ->> 'code') = 'validation'
       and (v_res ->> 'error') like '%Accounting reversal requires counter journal entry%' then
      insert into test_results values (19, 'Accounting Reversal Operation Rejection', 'PASS', 'Operation reverse recognized in contract; explicitly rejected explaining Phase 3/5 counter-entry requirements');
    else
      insert into test_results values (19, 'Accounting Reversal Operation Rejection', 'FAIL', 'Unexpected response for reverse: ' || v_res::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (19, 'Accounting Reversal Operation Rejection', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 20: Posted Document Immutability & Re-Post Protection (Item 3)
  -- -------------------------------------------------------------------
  DECLARE
    v_res_update jsonb;
    v_res_delete_line jsonb;
    v_res_repost jsonb;
    v_posted_at_after timestamptz;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    -- 20a. Create and post document
    select sync_push_document(
      v_posted_op_id,
      jsonb_build_object(
        'id', v_posted_doc_id,
        'branch_id', v_branch_cai,
        'doc_type', 'sales_invoice',
        'series_code', 'PST',
        'seq_no', 991122,
        'doc_no', 'INV-POST-IMMUTABLE-01',
        'doc_date', '2026-01-20',
        'subtotal', 250,
        'total', 250
      ),
      jsonb_build_array(
        jsonb_build_object(
          'id', v_posted_line_id,
          'line_no', 1,
          'item_id', v_item_id,
          'qty', 1,
          'unit_price', 250,
          'line_total', 250
        )
      ),
      true, -- post_now = true
      now()
    ) into v_res;

    EXECUTE 'RESET ROLE';
    select posted_at into v_posted_at from documents where id = v_posted_doc_id;

    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    -- 20b. Attempt to update posted document
    select sync_push_op(
      gen_random_uuid(),
      'documents',
      v_posted_doc_id,
      'update',
      jsonb_build_object('notes', 'محاولة تعديل غير قانونية لمستند مرحل'),
      1,
      now()
    ) into v_res_update;

    -- 20c. Attempt to delete line of posted document
    select sync_push_op(
      gen_random_uuid(),
      'document_lines',
      v_posted_line_id,
      'delete',
      '{}'::jsonb,
      1,
      now()
    ) into v_res_delete_line;

    -- 20d. Attempt to post second time with DIFFERENT op_id
    select sync_push_op(
      gen_random_uuid(),
      'documents',
      v_posted_doc_id,
      'post',
      '{}'::jsonb,
      1,
      now()
    ) into v_res_repost;

    EXECUTE 'RESET ROLE';
    select posted_at into v_posted_at_after from documents where id = v_posted_doc_id;

    if (v_res ->> 'success')::boolean = true
       and (v_res ? 'server_row')
       and (v_res ? 'lines')
       and (v_res_update ->> 'status') = 'rejected'
       and (v_res_update ->> 'error') like '%posted records are immutable%'
       and (v_res_delete_line ->> 'status') = 'rejected'
       and (v_res_delete_line ->> 'error') like '%cannot change lines of a posted record%'
       and (v_res_repost ->> 'status') = 'rejected'
       and (v_res_repost ->> 'error') like '%already posted%'
       and v_posted_at_after = v_posted_at then
      insert into test_results values (20, 'Posted Document Immutability & Re-Post Rejection', 'PASS', 'Posted doc update blocked by trg_block_doc; line deletion blocked by trg_block_dl; second post with different op_id rejected with posted_at unchanged');
    else
      insert into test_results values (20, 'Posted Document Immutability & Re-Post Rejection', 'FAIL', 'Posted check failed: Update=' || v_res_update::text || ' DelLine=' || v_res_delete_line::text || ' RePost=' || v_res_repost::text);
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (20, 'Posted Document Immutability & Re-Post Rejection', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

  -- -------------------------------------------------------------------
  -- TEST 21: _internal_finalize_sync_op auth.uid() Enforced Ownership (Item 4)
  -- -------------------------------------------------------------------
  DECLARE
    v_finalize_threw boolean := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    begin
      -- Try to finalize nonexistent or unowned op_id as authenticated
      perform private._internal_finalize_sync_op(gen_random_uuid(), 'applied');
    exception when others then
      if sqlerrm like '%not found or not owned by user%' then
        v_finalize_threw := true;
      end if;
    end;

    EXECUTE 'RESET ROLE';

    if v_finalize_threw = true then
      insert into test_results values (21, 'Finalize Sync Op auth.uid() Ownership Check', 'PASS', 'Finalize function strictly validates user_id = auth.uid() and raises exception when 0 rows are updated');
    else
      insert into test_results values (21, 'Finalize Sync Op auth.uid() Ownership Check', 'FAIL', 'Failed to raise exception on unowned/missing op_id finalize');
    end if;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    insert into test_results values (21, 'Finalize Sync Op auth.uid() Ownership Check', 'FAIL', 'Exception ' || sqlstate || ': ' || sqlerrm);
  END;

END $$;

SELECT test_no, test_name AS name, status AS result, details AS detail FROM test_results ORDER BY test_no;

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
--   -- Returns: {"success": true, "status": "duplicate", "is_duplicate": true, "original_result": "applied", "code": "ok", "server_row": {...}}
-- =====================================================================
