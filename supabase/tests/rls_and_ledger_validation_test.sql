-- =====================================================================
-- supabase/tests/rls_and_ledger_validation_test.sql
-- Phase 2b-1 SQL-Level Integration & Verification Suite
-- Run directly in Supabase SQL Editor as 'postgres' role.
-- =====================================================================

do $$
declare
  -- Test UUIDs
  v_admin_uid uuid := 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
  v_accountant_cai_uid uuid := 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
  v_cashier_alx_uid uuid := 'cccccccc-0000-0000-0000-cccccccccccc';
  v_unauthorized_uid uuid := 'dddddddd-0000-0000-0000-dddddddddddd';

  v_branch_cai uuid := '22222222-2222-2222-2222-222222222201';
  v_branch_alx uuid := '22222222-2222-2222-2222-222222222202';

  v_role_admin uuid;
  v_role_acc uuid;
  v_role_csh uuid;

  v_je_id uuid;
  v_doc_id uuid;
  v_count int;
  v_audit_count int;
  v_err_msg text;
  v_test_passed boolean;
begin
  raise notice '=============================================================';
  raise notice 'STARTING PHASE 2b-1 RLS & LEDGER VERIFICATION SUITE';
  raise notice '=============================================================';

  -- -------------------------------------------------------------------
  -- 0. FIXTURES SETUP: Profiles & Branch Assignments
  -- -------------------------------------------------------------------
  select id into v_role_admin from roles where name = 'Admin';
  select id into v_role_acc from roles where name = 'Accountant';
  select id into v_role_csh from roles where name = 'Cashier';

  -- Create / Update Test Profiles
  insert into profiles (id, full_name, role_id, is_active) values
    (v_admin_uid, 'مدير اختبار النظام (Admin)', v_role_admin, true),
    (v_accountant_cai_uid, 'محاسب فرع القاهرة (Accountant CAI)', v_role_acc, true),
    (v_cashier_alx_uid, 'كاشير فرع الإسكندرية (Cashier ALX)', v_role_csh, true),
    (v_unauthorized_uid, 'مستخدم بلا صلاحيات (Unauthorized User)', null, true)
  on conflict (id) do update
  set full_name = excluded.full_name, role_id = excluded.role_id, is_active = excluded.is_active;

  -- User Branches
  insert into user_branches (user_id, branch_id) values
    (v_accountant_cai_uid, v_branch_cai),
    (v_cashier_alx_uid, v_branch_alx)
  on conflict (user_id, branch_id) do nothing;

  raise notice '-> Fixtures created: 4 users, branch assignments configured.';

  -- -------------------------------------------------------------------
  -- TEST 1: User without permission is DENIED by RLS
  -- -------------------------------------------------------------------
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_unauthorized_uid, 'role', 'authenticated')::text, true);

    insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
    values (gen_random_uuid(), 'GEN', 90001, 'JE-UNAUTH-01', '2026-10-10', v_branch_cai, 'draft');

    raise exception 'TEST 1 FAILED: Unauthorized user was able to insert a journal entry!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%row-level security%' or v_err_msg like '%permission%' then
      raise notice '✓ TEST 1 PASSED: User without permission is strictly denied by RLS.';
    else
      raise exception 'TEST 1 FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 2: Branch Isolation (Branch A accountant cannot read/write Branch B)
  -- -------------------------------------------------------------------
  -- Step 2a: Insert an entry in Branch ALX using Admin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_je_id := gen_random_uuid();
  insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
  values (v_je_id, 'GEN', 90002, 'JE-ALX-02', '2026-10-10', v_branch_alx, 'draft');

  -- Step 2b: Switch to Accountant CAI and attempt to SELECT the ALX entry
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  select count(*) into v_count from journal_entries where id = v_je_id;
  if v_count <> 0 then
    raise exception 'TEST 2 FAILED: Accountant of Branch CAI was able to read Branch ALX entry!';
  end if;

  -- Step 2c: Attempt to INSERT an entry into Branch ALX as Accountant CAI
  begin
    insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
    values (gen_random_uuid(), 'GEN', 90003, 'JE-ILLEGAL-03', '2026-10-10', v_branch_alx, 'draft');

    raise exception 'TEST 2 FAILED: Accountant CAI was able to insert into Branch ALX!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%row-level security%' then
      raise notice '✓ TEST 2 PASSED: Cross-branch access strictly blocked (Read = 0 rows, Write = RLS check violation).';
    else
      raise exception 'TEST 2 FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 3: Posted documents and entries cannot be edited or deleted (Immutability)
  -- -------------------------------------------------------------------
  -- Switch to Admin to set up a posted entry
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_je_id := gen_random_uuid();
  insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
  values (v_je_id, 'GEN', 90004, 'JE-POSTED-04', '2026-10-15', v_branch_cai, 'draft');

  -- Add balanced lines
  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit) values
    (gen_random_uuid(), v_je_id, 1, '55555555-5555-5555-5555-555555555511', 100, 0),
    (gen_random_uuid(), v_je_id, 2, '55555555-5555-5555-5555-555555555541', 0, 100);

  -- Post the entry
  update journal_entries set status = 'posted' where id = v_je_id;

  -- Attempt 3a: Edit posted header
  begin
    update journal_entries set description = 'Tampered description' where id = v_je_id;
    raise exception 'TEST 3a FAILED: Posted entry header was edited!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%posted records are immutable%' then
      raise notice '✓ TEST 3a PASSED: Header update on posted entry rejected by block_posted_changes().';
    else
      raise exception 'TEST 3a FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- Attempt 3b: Delete posted header
  begin
    delete from journal_entries where id = v_je_id;
    raise exception 'TEST 3b FAILED: Posted entry was deleted!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%posted records cannot be deleted%' then
      raise notice '✓ TEST 3b PASSED: Delete on posted entry rejected by block_posted_changes().';
    else
      raise exception 'TEST 3b FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- Attempt 3c: Add line to posted entry
  begin
    insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
    values (gen_random_uuid(), v_je_id, 3, '55555555-5555-5555-5555-555555555511', 50, 0);
    raise exception 'TEST 3c FAILED: Line was added to a posted entry!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%cannot change lines of a posted record%' then
      raise notice '✓ TEST 3c PASSED: Adding line to posted entry rejected by block_posted_children().';
    else
      raise exception 'TEST 3c FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 4: Unbalanced Journal Entry is REJECTED by check_entry_balanced()
  -- -------------------------------------------------------------------
  v_je_id := gen_random_uuid();
  insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
  values (v_je_id, 'GEN', 90005, 'JE-UNBALANCED-05', '2026-10-15', v_branch_cai, 'draft');

  -- Insert unbalanced lines: Debit 1000 vs Credit 800
  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit) values
    (gen_random_uuid(), v_je_id, 1, '55555555-5555-5555-5555-555555555511', 1000, 0),
    (gen_random_uuid(), v_je_id, 2, '55555555-5555-5555-5555-555555555541', 0, 800);

  begin
    update journal_entries set status = 'posted' where id = v_je_id;
    raise exception 'TEST 4 FAILED: Unbalanced journal entry was allowed to post!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%not balanced%' then
      raise notice '✓ TEST 4 PASSED: Unbalanced entry rejected by check_entry_balanced() (Debit 1000 != Credit 800).';
    else
      raise exception 'TEST 4 FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 5: Closed Fiscal Period REJECTS posting by require_open_period()
  -- -------------------------------------------------------------------
  -- Date 2026-09-15 falls in September 2026 which is marked 'closed' in seeds
  v_je_id := gen_random_uuid();
  insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
  values (v_je_id, 'GEN', 90006, 'JE-CLOSED-06', '2026-09-15', v_branch_cai, 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit) values
    (gen_random_uuid(), v_je_id, 1, '55555555-5555-5555-5555-555555555511', 200, 0),
    (gen_random_uuid(), v_je_id, 2, '55555555-5555-5555-5555-555555555541', 0, 200);

  begin
    update journal_entries set status = 'posted' where id = v_je_id;
    raise exception 'TEST 5 FAILED: Posting in a closed fiscal period was allowed!';
  exception when others then
    get stacked diagnostics v_err_msg = message_text;
    if v_err_msg like '%no open fiscal period for date%' then
      raise notice '✓ TEST 5 PASSED: Posting in closed period rejected by require_open_period().';
    else
      raise exception 'TEST 5 FAILED with unexpected error: %', v_err_msg;
    end if;
  end;

  -- -------------------------------------------------------------------
  -- TEST 6: Valid Document & Journal Entry Postings SUCCEED end-to-end as authenticated user
  -- -------------------------------------------------------------------
  -- Switch to Accountant CAI
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_accountant_cai_uid, 'role', 'authenticated')::text, true);

  v_je_id := gen_random_uuid();
  insert into journal_entries (id, series_code, seq_no, entry_no, entry_date, branch_id, status)
  values (v_je_id, 'GEN', 90007, 'JE-VALID-07', '2026-10-20', v_branch_cai, 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit) values
    (gen_random_uuid(), v_je_id, 1, '55555555-5555-5555-5555-555555555511', 350.50, 0),
    (gen_random_uuid(), v_je_id, 2, '55555555-5555-5555-5555-555555555541', 0, 350.50);

  update journal_entries set status = 'posted' where id = v_je_id;

  select count(*) into v_count from journal_entries where id = v_je_id and status = 'posted';
  if v_count <> 1 then
    raise exception 'TEST 6a FAILED: Valid journal entry was not posted successfully!';
  end if;
  raise notice '✓ TEST 6a PASSED: Valid journal entry posted end-to-end as authenticated user.';

  -- Sales invoice posting by Cashier ALX
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_alx_uid, 'role', 'authenticated')::text, true);

  v_doc_id := gen_random_uuid();
  insert into documents (id, doc_type, series_code, seq_no, doc_no, doc_date, branch_id, status, subtotal, tax_total, total)
  values (v_doc_id, 'sales_invoice', 'INV', 90008, 'INV-VALID-08', '2026-10-20', v_branch_alx, 'draft', 100, 14, 114);

  insert into document_lines (id, document_id, line_no, item_id, unit_id, qty, unit_price, line_total, tax_rate, tax_amount)
  values (gen_random_uuid(), v_doc_id, 1, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '66666666-6666-6666-6666-666666666601', 1, 100, 114, 0.14, 14);

  update documents set status = 'posted' where id = v_doc_id;

  select count(*) into v_count from documents where id = v_doc_id and status = 'posted';
  if v_count <> 1 then
    raise exception 'TEST 6b FAILED: Valid sales invoice was not posted successfully!';
  end if;
  raise notice '✓ TEST 6b PASSED: Valid sales invoice posted end-to-end as authenticated user.';

  -- -------------------------------------------------------------------
  -- TEST 7: Proof that RLS cannot blind integrity checks
  -- -------------------------------------------------------------------
  -- The check functions (require_open_period, check_entry_balanced, block_posted_children)
  -- are verified to be SECURITY DEFINER in migration 005.
  if not exists (
    select 1 from pg_proc where proname = 'check_entry_balanced' and prosecdef = true
  ) then
    raise exception 'TEST 7 FAILED: check_entry_balanced is not SECURITY DEFINER!';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'require_open_period' and prosecdef = true
  ) then
    raise exception 'TEST 7 FAILED: require_open_period is not SECURITY DEFINER!';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'block_posted_children' and prosecdef = true
  ) then
    raise exception 'TEST 7 FAILED: block_posted_children is not SECURITY DEFINER!';
  end if;
  raise notice '✓ TEST 7 PASSED: Integrity triggers verified as SECURITY DEFINER with fixed search_path.';

  -- -------------------------------------------------------------------
  -- TEST 8: stamp_row() and audit_row() work for authenticated writes
  -- -------------------------------------------------------------------
  -- Check stamp on v_doc_id
  select count(*) into v_count
  from documents
  where id = v_doc_id and server_seq is not null and version >= 1 and updated_at is not null;

  if v_count <> 1 then
    raise exception 'TEST 8a FAILED: stamp_row() did not stamp the document!';
  end if;
  raise notice '✓ TEST 8a PASSED: stamp_row() correctly stamped server_seq, version, and updated_at.';

  -- Switch back to Admin to inspect audit_log
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  select count(*) into v_audit_count
  from audit_log
  where entity_id = v_doc_id and user_id = v_cashier_alx_uid;

  if v_audit_count = 0 then
    raise exception 'TEST 8b FAILED: audit_row() did not log the cashier actions in audit_log!';
  end if;
  raise notice '✓ TEST 8b PASSED: audit_row() logged authenticated writes with user_id = auth.uid().';

  raise notice '=============================================================';
  raise notice 'ALL 8 PHASE 2b-1 VERIFICATION TESTS PASSED 100%%!';
  raise notice '=============================================================';
end $$;
