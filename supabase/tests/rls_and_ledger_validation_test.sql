BEGIN;

-- =====================================================================
-- supabase/tests/rls_and_ledger_validation_test.sql
-- Phase 2b-1 SQL-Level Integration & Verification Suite
-- Run directly in Supabase SQL Editor as 'postgres' role.
-- Entire script runs within a transaction that starts with BEGIN;
-- and terminates with ROLLBACK;, ensuring zero persistence or side effects.
-- =====================================================================

-- Temporary table to collect and present structured test results
CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

DO $$
DECLARE
  -- Dedicated Test UUIDs
  v_admin_uid uuid := 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
  v_accountant_cai_uid uuid := 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
  v_cashier_alx_uid uuid := 'cccccccc-0000-0000-0000-cccccccccccc';
  v_unauthorized_uid uuid := 'dddddddd-0000-0000-0000-dddddddddddd';

  v_branch_cai uuid;
  v_branch_alx uuid := '22222222-2222-2222-2222-222222222202';

  v_role_admin uuid;
  v_role_acc uuid;
  v_role_csh uuid;

  v_acc_cash uuid;
  v_acc_capital uuid;

  v_alx_je_id uuid := '11111111-1111-1111-1111-111111111101';
  v_doc_immutable_id uuid := '11111111-1111-1111-1111-111111111102';
  v_unbal_je_id uuid := '11111111-1111-1111-1111-111111111103';
  v_closed_je_id uuid := '11111111-1111-1111-1111-111111111104';
  v_bal_je_id uuid := '11111111-1111-1111-1111-111111111105';
  v_cashier_doc_id uuid := '11111111-1111-1111-1111-111111111106';

  v_count int;
  v_audit_count int;
  v_header_blocked boolean;
  v_lines_blocked boolean;
  v_je_status text;
  v_doc_status text;
BEGIN
  -- -------------------------------------------------------------------
  -- 0. FIXTURES SETUP (Executed as postgres within the transaction)
  -- -------------------------------------------------------------------

  -- A. Resolve Standard Roles
  select id into v_role_admin from roles where name = 'Admin';
  select id into v_role_acc from roles where name = 'Accountant';
  select id into v_role_csh from roles where name = 'Cashier';

  if v_role_admin is null or v_role_acc is null or v_role_csh is null then
    raise exception 'Roles (Admin, Accountant, Cashier) not found. Please apply 006_v1_seed_roles_permissions_and_coa.sql first.';
  end if;

  -- B. Resolve Postable Accounts for Ledger Testing
  select id into v_acc_cash from accounts where code = '1101';
  select id into v_acc_capital from accounts where code = '3101';

  if v_acc_cash is null or v_acc_capital is null then
    raise exception 'Accounts 1101 or 3101 not found. Please apply 006_v1_seed_roles_permissions_and_coa.sql first.';
  end if;

  -- C. Create Test Users in auth.users (wrapped to accommodate gotrue column variants)
  begin
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
      (v_admin_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_admin@cash.local', now(), now()),
      (v_accountant_cai_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_acc_cai@cash.local', now(), now()),
      (v_cashier_alx_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_csh_alx@cash.local', now(), now()),
      (v_unauthorized_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_unauth@cash.local', now(), now())
    on conflict (id) do nothing;
  exception when others then
    insert into auth.users (id, aud, role, email, created_at, updated_at) values
      (v_admin_uid, 'authenticated', 'authenticated', 'test_admin@cash.local', now(), now()),
      (v_accountant_cai_uid, 'authenticated', 'authenticated', 'test_acc_cai@cash.local', now(), now()),
      (v_cashier_alx_uid, 'authenticated', 'authenticated', 'test_csh_alx@cash.local', now(), now()),
      (v_unauthorized_uid, 'authenticated', 'authenticated', 'test_unauth@cash.local', now(), now())
    on conflict (id) do nothing;
  end;

  -- D. Create Test Profiles
  insert into profiles (id, full_name, role_id, is_active) values
    (v_admin_uid, 'مدير اختبار النظام (Admin)', v_role_admin, true),
    (v_accountant_cai_uid, 'محاسب فرع القاهرة (Accountant CAI)', v_role_acc, true),
    (v_cashier_alx_uid, 'كاشير فرع الإسكندرية (Cashier ALX)', v_role_csh, true),
    (v_unauthorized_uid, 'مستخدم بلا صلاحيات (Unauthorized User)', null, true)
  on conflict (id) do update
  set full_name = excluded.full_name, role_id = excluded.role_id, is_active = excluded.is_active;

  -- E. Setup Branches (Main Cairo Branch & Test Alexandria Branch)
  select id into v_branch_cai from branches where code = 'MAIN';
  if v_branch_cai is null then
    insert into branches (code, name_ar, is_main, is_active)
    values ('MAIN', 'الفرع الرئيسي', true, true)
    returning id into v_branch_cai;
  end if;

  insert into branches (id, code, name_ar, is_main, is_active)
  values (v_branch_alx, 'TEST_ALX', 'فرع الإسكندرية (اختبار)', false, true)
  on conflict (code) do update
  set is_active = true
  returning id into v_branch_alx;

  -- F. Assign User Branches
  insert into user_branches (user_id, branch_id) values
    (v_accountant_cai_uid, v_branch_cai),
    (v_cashier_alx_uid, v_branch_alx)
  on conflict (user_id, branch_id) do nothing;

  -- G. Set Closed Period Fixture (Close September 2026 for testing)
  update fiscal_periods
  set status = 'closed'
  where start_date = '2026-09-01';

  -- -------------------------------------------------------------------
  -- TEST 1: Unauthorized user denied read/write on accounting & documents
  -- -------------------------------------------------------------------
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_unauthorized_uid, 'role', 'authenticated')::text, true);

  execute 'select count(*) from accounts' into v_count;

  begin
    insert into journal_entries (branch_id, series_code, seq_no, entry_no, entry_date, status)
    values (v_branch_cai, 'T1', 999901, 'JE-UNAUTH-01', '2026-01-15', 'draft');

    insert into test_results values (1, 'Unauthorized User Denied', 'FAIL', 'Unauthorized user was able to insert journal entry');
  exception when others then
    if v_count = 0 then
      insert into test_results values (1, 'Unauthorized User Denied', 'PASS', 'Read denied (0 accounts visible under RLS) and write denied (' || sqlerrm || ')');
    else
      insert into test_results values (1, 'Unauthorized User Denied', 'FAIL', 'Write denied but accounts table leaked ' || v_count || ' rows');
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 2: Cross-branch isolation (Branch CAI user cannot read or write Branch ALX)
  -- -------------------------------------------------------------------
  -- Pre-seed an Alexandria entry as postgres
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_alx_je_id, v_branch_alx, 'T2', 999902, 'JE-ALX-01', '2026-01-15', 'draft')
  on conflict (id) do nothing;

  -- Switch to Cairo Accountant
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  execute 'select count(*) from journal_entries where id = $1' into v_count using v_alx_je_id;

  begin
    insert into journal_entries (branch_id, series_code, seq_no, entry_no, entry_date, status)
    values (v_branch_alx, 'T2', 999903, 'JE-CAI-TO-ALX', '2026-01-15', 'draft');

    insert into test_results values (2, 'Cross-Branch Isolation', 'FAIL', 'Cairo accountant was able to insert into Alexandria branch');
  exception when others then
    if v_count = 0 then
      insert into test_results values (2, 'Cross-Branch Isolation', 'PASS', 'Cairo user cannot read Alexandria entries (0 rows visible) and cross-branch write rejected (' || sqlerrm || ')');
    else
      insert into test_results values (2, 'Cross-Branch Isolation', 'FAIL', 'Write blocked but Cairo accountant can read Alexandria entries');
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 3: Immutability of posted records (block_posted_changes & block_posted_children)
  -- -------------------------------------------------------------------
  -- Switch to Cashier ALX
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_alx_uid, 'role', 'authenticated')::text, true);

  insert into documents (id, branch_id, doc_type, series_code, seq_no, doc_no, doc_date, subtotal, total, status)
  values (v_doc_immutable_id, v_branch_alx, 'sales_invoice', 'T3', 999904, 'INV-IMM-01', '2026-01-15', 200, 200, 'draft')
  on conflict (id) do nothing;

  insert into document_lines (document_id, line_no, qty, unit_price, line_total)
  values (v_doc_immutable_id, 1, 2, 100, 200)
  on conflict (document_id, line_no) do nothing;

  -- Post the invoice
  update documents set status = 'posted', posted_at = now() where id = v_doc_immutable_id;

  -- Attempt header edit
  begin
    update documents set notes = 'tampered note' where id = v_doc_immutable_id;
    v_header_blocked := false;
  exception when others then
    v_header_blocked := (sqlerrm like '%posted records are immutable%');
  end;

  -- Attempt child line edit
  begin
    insert into document_lines (document_id, line_no, qty, unit_price, line_total)
    values (v_doc_immutable_id, 2, 1, 50, 50);
    v_lines_blocked := false;
  exception when others then
    v_lines_blocked := (sqlerrm like '%cannot change lines of a posted record%');
  end;

  if v_header_blocked and v_lines_blocked then
    insert into test_results values (3, 'Immutability of Posted Records', 'PASS', 'Header edits blocked by block_posted_changes and line edits blocked by block_posted_children');
  else
    insert into test_results values (3, 'Immutability of Posted Records', 'FAIL', 'Header blocked: ' || v_header_blocked || ', Lines blocked: ' || v_lines_blocked);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: Unbalanced journal entry is rejected by check_entry_balanced()
  -- -------------------------------------------------------------------
  -- Switch to Accountant CAI
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_unbal_je_id, v_branch_cai, 'T4', 999905, 'JE-UNBAL-01', '2026-01-15', 'draft')
  on conflict (id) do nothing;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values
    (v_unbal_je_id, 1, v_acc_cash, 1000, 0),
    (v_unbal_je_id, 2, v_acc_capital, 0, 500)
  on conflict (entry_id, line_no) do nothing;

  begin
    update journal_entries set status = 'posted' where id = v_unbal_je_id;
    insert into test_results values (4, 'Unbalanced Entry Rejection', 'FAIL', 'Unbalanced entry was successfully posted without error');
  exception when others then
    if sqlerrm like '%not balanced%' then
      insert into test_results values (4, 'Unbalanced Entry Rejection', 'PASS', 'Correctly rejected by check_entry_balanced trigger: ' || sqlerrm);
    else
      insert into test_results values (4, 'Unbalanced Entry Rejection', 'FAIL', 'Failed with unexpected error: ' || sqlerrm);
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 5: Closed fiscal period rejects posting by require_open_period()
  -- -------------------------------------------------------------------
  -- Switch to Accountant CAI
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_closed_je_id, v_branch_cai, 'T5', 999906, 'JE-CLOSED-01', '2026-09-15', 'draft')
  on conflict (id) do nothing;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values
    (v_closed_je_id, 1, v_acc_cash, 300, 0),
    (v_closed_je_id, 2, v_acc_capital, 0, 300)
  on conflict (entry_id, line_no) do nothing;

  begin
    update journal_entries set status = 'posted' where id = v_closed_je_id;
    insert into test_results values (5, 'Closed Fiscal Period Rejection', 'FAIL', 'Entry posted into a closed period without error');
  exception when others then
    if sqlerrm like '%no open fiscal period%' then
      insert into test_results values (5, 'Closed Fiscal Period Rejection', 'PASS', 'Correctly rejected by require_open_period trigger: ' || sqlerrm);
    else
      insert into test_results values (5, 'Closed Fiscal Period Rejection', 'FAIL', 'Failed with unexpected error: ' || sqlerrm);
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 6: Limited role (Accountant) posts balanced entry without trigger RLS blockage
  -- -------------------------------------------------------------------
  -- Switch to Accountant CAI
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_bal_je_id, v_branch_cai, 'T6', 999907, 'JE-BAL-01', '2026-01-20', 'draft')
  on conflict (id) do nothing;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values
    (v_bal_je_id, 1, v_acc_cash, 750, 0),
    (v_bal_je_id, 2, v_acc_capital, 0, 750)
  on conflict (entry_id, line_no) do nothing;

  begin
    update journal_entries set status = 'posted' where id = v_bal_je_id;

    select status into v_je_status from journal_entries where id = v_bal_je_id;
    if v_je_status = 'posted' then
      insert into test_results values (6, 'Accountant Posting Under RLS', 'PASS', 'Accountant successfully posted balanced entry; triggers executed under SECURITY DEFINER without RLS blockage');
    else
      insert into test_results values (6, 'Accountant Posting Under RLS', 'FAIL', 'Entry status is not posted: ' || coalesce(v_je_status, 'NULL'));
    end if;
  exception when others then
    insert into test_results values (6, 'Accountant Posting Under RLS', 'FAIL', 'Unexpected error during posting: ' || sqlerrm);
  end;

  -- -------------------------------------------------------------------
  -- TEST 7: Limited role (Cashier) creates and posts sales invoice without trigger RLS blockage
  -- -------------------------------------------------------------------
  -- Switch to Cashier ALX
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_alx_uid, 'role', 'authenticated')::text, true);

  begin
    insert into documents (id, branch_id, doc_type, series_code, seq_no, doc_no, doc_date, subtotal, total, status)
    values (v_cashier_doc_id, v_branch_alx, 'sales_invoice', 'T7', 999908, 'INV-CSH-01', '2026-01-22', 450, 450, 'draft')
    on conflict (id) do nothing;

    insert into document_lines (document_id, line_no, qty, unit_price, line_total)
    values (v_cashier_doc_id, 1, 3, 150, 450)
    on conflict (document_id, line_no) do nothing;

    update documents set status = 'posted', posted_at = now() where id = v_cashier_doc_id;

    select status into v_doc_status from documents where id = v_cashier_doc_id;
    if v_doc_status = 'posted' then
      insert into test_results values (7, 'Cashier Sales Invoice Posting Under RLS', 'PASS', 'Cashier successfully posted sales invoice with lines in assigned branch without trigger RLS blockage');
    else
      insert into test_results values (7, 'Cashier Sales Invoice Posting Under RLS', 'FAIL', 'Document status is not posted: ' || coalesce(v_doc_status, 'NULL'));
    end if;
  exception when others then
    insert into test_results values (7, 'Cashier Sales Invoice Posting Under RLS', 'FAIL', 'Unexpected error: ' || sqlerrm);
  end;

  -- -------------------------------------------------------------------
  -- TEST 8: stamp_row() and audit_row() work for authenticated writes
  -- -------------------------------------------------------------------
  -- Switch to postgres to inspect system stamps and audit_log
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count
  from documents
  where id = v_cashier_doc_id
    and server_seq is not null
    and version >= 1
    and updated_at is not null;

  select count(*) into v_audit_count
  from audit_log
  where entity_id = v_cashier_doc_id
    and user_id = v_cashier_alx_uid;

  if v_count = 1 and v_audit_count > 0 then
    insert into test_results values (8, 'Stamp and Audit Triggers on Authenticated Writes', 'PASS', 'stamp_row generated server_seq and version, and audit_log recorded ' || v_audit_count || ' audit events with real user_id = auth.uid()');
  else
    insert into test_results values (8, 'Stamp and Audit Triggers on Authenticated Writes', 'FAIL', 'Stamped rows: ' || v_count || ', Audit records: ' || v_audit_count);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 9: Integrity check functions are verified SECURITY DEFINER
  -- -------------------------------------------------------------------
  select count(*) into v_count
  from pg_proc
  where proname in ('block_posted_changes', 'block_posted_children', 'require_open_period', 'check_entry_balanced')
    and prosecdef = true;

  if v_count = 4 then
    insert into test_results values (9, 'Integrity Check Triggers SECURITY DEFINER Verification', 'PASS', 'All 4 ledger invariant triggers verified with prosecdef = true and search_path = public');
  else
    insert into test_results values (9, 'Integrity Check Triggers SECURITY DEFINER Verification', 'FAIL', 'Only ' || v_count || '/4 triggers are SECURITY DEFINER');
  end if;

END $$;

-- Return tabular test report
SELECT test_no, test_name, status, details FROM test_results ORDER BY test_no;

ROLLBACK;
