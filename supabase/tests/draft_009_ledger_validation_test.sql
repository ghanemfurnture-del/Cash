BEGIN;

-- =====================================================================
-- supabase/tests/draft_009_ledger_validation_test.sql
-- Phase 3 Draft Verification Suite: Ledger Invariants & Double-Entry Rules
-- Tested behaviors:
--   1. Balanced journal entry (Debit = Credit) posts successfully.
--   2. Unbalanced journal entry (Debit != Credit) is rejected on posting.
--   3. Modifying a posted journal entry or its lines is blocked (immutability).
--   4. Posting a journal entry in a closed period is blocked.
-- Transaction ends strictly with ROLLBACK; ensuring zero side effects.
-- =====================================================================

CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

DO $$
DECLARE
  v_branch_id uuid;
  v_acc_cash uuid;
  v_acc_revenue uuid;
  v_fy_id uuid;
  v_open_period_id uuid;
  v_closed_period_id uuid;

  v_je_bal_id uuid := '99999999-9999-4999-8999-999999999911';
  v_je_unbal_id uuid := '99999999-9999-4999-8999-999999999912';
  v_je_closed_id uuid := '99999999-9999-4999-8999-999999999913';

  v_err_caught boolean;
  v_res_status text;
BEGIN
  -- Setup Fixtures
  select id into v_branch_id from branches where deleted_at is null limit 1;
  select id into v_acc_cash from accounts where code = '1111' or is_postable = true limit 1;
  select id into v_acc_revenue from accounts where id <> v_acc_cash and is_postable = true limit 1;

  -- Setup Fiscal Year & Periods
  select id into v_fy_id from fiscal_years where deleted_at is null limit 1;
  if v_fy_id is null then
    v_fy_id := gen_random_uuid();
    insert into fiscal_years (id, code, name_ar, start_date, end_date, is_closed)
    values (v_fy_id, 'FY-TEST', 'سنة تجريبية', '2026-01-01', '2026-12-31', false);
  end if;

  -- Ensure one open period and one closed period exist
  select id into v_open_period_id from fiscal_periods where fiscal_year_id = v_fy_id and is_closed = false limit 1;
  if v_open_period_id is null then
    v_open_period_id := gen_random_uuid();
    insert into fiscal_periods (id, fiscal_year_id, period_no, name_ar, start_date, end_date, is_closed)
    values (v_open_period_id, v_fy_id, 1, 'فترة مفتوحة', '2026-01-01', '2026-01-31', false);
  end if;

  select id into v_closed_period_id from fiscal_periods where fiscal_year_id = v_fy_id and is_closed = true limit 1;
  if v_closed_period_id is null then
    v_closed_period_id := gen_random_uuid();
    insert into fiscal_periods (id, fiscal_year_id, period_no, name_ar, start_date, end_date, is_closed)
    values (v_closed_period_id, v_fy_id, 2, 'فترة مقفلة', '2026-02-01', '2026-02-28', true);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 1: Balanced Journal Entry (Debit = Credit) Posts Successfully
  -- -------------------------------------------------------------------
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_je_bal_id, v_branch_id, 'JE-TEST', 101, 'JE-TEST-000101', '2026-01-15', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    (gen_random_uuid(), v_je_bal_id, 1, v_acc_cash, 5000.0000, 0),
    (gen_random_uuid(), v_je_bal_id, 2, v_acc_revenue, 0, 5000.0000);

  update journal_entries set status = 'posted' where id = v_je_bal_id;

  select status into v_res_status from journal_entries where id = v_je_bal_id;
  if v_res_status = 'posted' then
    insert into test_results values (1, 'Balanced Journal Entry Posts', 'PASS', 'Balanced entry (5000 debit = 5000 credit) posted successfully');
  else
    insert into test_results values (1, 'Balanced Journal Entry Posts', 'FAIL', 'Entry status is ' || coalesce(v_res_status, 'null'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 2: Unbalanced Journal Entry (Debit != Credit) is Rejected
  -- -------------------------------------------------------------------
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_je_unbal_id, v_branch_id, 'JE-TEST', 102, 'JE-TEST-000102', '2026-01-16', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    (gen_random_uuid(), v_je_unbal_id, 1, v_acc_cash, 5000.0000, 0),
    (gen_random_uuid(), v_je_unbal_id, 2, v_acc_revenue, 0, 3000.0000); -- Unbalanced!

  v_err_caught := false;
  begin
    update journal_entries set status = 'posted' where id = v_je_unbal_id;
  exception when others then
    v_err_caught := true;
  end;

  if v_err_caught then
    insert into test_results values (2, 'Unbalanced Entry Rejected', 'PASS', 'check_entry_balanced trigger correctly blocked posting unbalanced entry');
  else
    insert into test_results values (2, 'Unbalanced Entry Rejected', 'FAIL', 'Unbalanced entry was allowed to be posted');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 3: Posted Journal Entry Immutability (Cannot Update Lines)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  begin
    update journal_lines set debit = 6000.0000 where entry_id = v_je_bal_id;
  exception when others then
    v_err_caught := true;
  end;

  if v_err_caught then
    insert into test_results values (3, 'Posted Entry Immutability', 'PASS', 'block_posted_changes trigger prevented modifying posted journal lines');
  else
    insert into test_results values (3, 'Posted Entry Immutability', 'FAIL', 'Lines of posted entry were modified');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: Journal Entry in Closed Fiscal Period is Blocked
  -- -------------------------------------------------------------------
  v_err_caught := false;
  begin
    insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
    values (v_je_closed_id, v_branch_id, 'JE-TEST', 103, 'JE-TEST-000103', '2026-02-15', 'posted'); -- In closed period!
  exception when others then
    v_err_caught := true;
  end;

  if v_err_caught then
    insert into test_results values (4, 'Closed Period Posting Blocked', 'PASS', 'require_open_period trigger correctly blocked entry in closed period');
  else
    insert into test_results values (4, 'Closed Period Posting Blocked', 'FAIL', 'Entry in closed period was accepted');
  end if;

END $$;

SELECT * FROM test_results ORDER BY test_no;

ROLLBACK;
