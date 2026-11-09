BEGIN;

-- =====================================================================
-- supabase/tests/draft_009_ledger_validation_test.sql
-- Phase 3 Draft Verification Suite: Ledger Invariants & Double-Entry Rules
-- Tested behaviors:
--   1. Balanced journal entry (Debit = Credit) posts successfully.
--   2. Unbalanced journal entry (Debit != Credit) is rejected with exact error.
--   3. Modifying a posted journal entry or its lines is blocked (immutability).
--   4. Entry in a closed period is blocked by require_open_period (with balanced lines).
--   5. create_journal_reversal_entry creates inverted posted entry and marks original reversed.
--   6. Single-transaction draft-insert-lines-post workflow succeeds.
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
  v_je_rev_id uuid := '99999999-9999-4999-8999-999999999914';
  v_je_atomic_id uuid := '99999999-9999-4999-8999-999999999915';

  v_err_caught boolean;
  v_err_msg text;
  v_sqlstate text;
  v_res_status text;
  v_rev_count int;
  v_rev_debit numeric;
  v_rev_credit numeric;
BEGIN
  -- Setup Fixtures
  select id into v_branch_id from branches where deleted_at is null limit 1;
  select id into v_acc_cash from accounts where code = '1111' or is_postable = true limit 1;
  select id into v_acc_revenue from accounts where id <> v_acc_cash and is_postable = true limit 1;

  -- Setup Fiscal Year & Periods
  select id into v_fy_id from fiscal_years where deleted_at is null limit 1;
  if v_fy_id is null then
    v_fy_id := '99999999-9999-4999-8999-999999999901';
    insert into fiscal_years (id, code, name_ar, start_date, end_date, is_closed)
    values (v_fy_id, 'FY-TEST', 'سنة تجريبية', '2026-01-01', '2026-12-31', false);
  end if;

  -- Ensure one open period (Jan 2026) and one closed period (Feb 2026) exist
  select id into v_open_period_id from fiscal_periods where fiscal_year_id = v_fy_id and is_closed = false limit 1;
  if v_open_period_id is null then
    v_open_period_id := '99999999-9999-4999-8999-999999999902';
    insert into fiscal_periods (id, fiscal_year_id, period_no, name_ar, start_date, end_date, is_closed)
    values (v_open_period_id, v_fy_id, 1, 'فترة مفتوحة', '2026-01-01', '2026-01-31', false);
  end if;

  select id into v_closed_period_id from fiscal_periods where fiscal_year_id = v_fy_id and is_closed = true limit 1;
  if v_closed_period_id is null then
    v_closed_period_id := '99999999-9999-4999-8999-999999999903';
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
    ('99999999-9999-4999-8999-999999999921', v_je_bal_id, 1, v_acc_cash, 5000.0000, 0),
    ('99999999-9999-4999-8999-999999999922', v_je_bal_id, 2, v_acc_revenue, 0, 5000.0000);

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
    ('99999999-9999-4999-8999-999999999923', v_je_unbal_id, 1, v_acc_cash, 5000.0000, 0),
    ('99999999-9999-4999-8999-999999999924', v_je_unbal_id, 2, v_acc_revenue, 0, 3000.0000); -- Unbalanced!

  v_err_caught := false;
  v_err_msg := null;
  begin
    update journal_entries set status = 'posted' where id = v_je_unbal_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_err_msg like 'journal entry % not balanced%' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (2, 'Unbalanced Entry Rejected', 'PASS', 'check_entry_balanced trigger rejected with: ' || v_err_msg);
  else
    insert into test_results values (2, 'Unbalanced Entry Rejected', 'FAIL', 'Expected balanced check error, got msg: ' || coalesce(v_err_msg, 'none'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 3: Posted Journal Entry Immutability (Cannot Update Lines)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  begin
    update journal_lines set debit = 6000.0000 where entry_id = v_je_bal_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_err_msg like 'cannot modify posted %' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (3, 'Posted Entry Immutability', 'PASS', 'block_posted_changes trigger blocked line modification: ' || v_err_msg);
  else
    insert into test_results values (3, 'Posted Entry Immutability', 'FAIL', 'Expected block_posted_changes error, got msg: ' || coalesce(v_err_msg, 'none'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: Journal Entry in Closed Fiscal Period is Blocked (with balanced lines)
  -- -------------------------------------------------------------------
  -- Invariant check for trg_period_je:
  -- Date 2026-02-15 falls in Period 2 which has is_closed = true.
  -- trg_period_je fires BEFORE INSERT on journal_entries.
  v_err_caught := false;
  v_err_msg := null;
  begin
    insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
    values (v_je_closed_id, v_branch_id, 'JE-TEST', 103, 'JE-TEST-000103', '2026-02-15', 'draft');
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_err_msg like 'no open fiscal period for date%' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (4, 'Closed Period Posting Blocked', 'PASS', 'require_open_period trigger blocked closed period entry: ' || v_err_msg);
  else
    insert into test_results values (4, 'Closed Period Posting Blocked', 'FAIL', 'Expected closed period error, got: ' || coalesce(v_err_msg, 'none'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 5: Journal Reversal Helper (create_journal_reversal_entry)
  -- -------------------------------------------------------------------
  -- Tests that reversal creates inverted lines, posts reversal, and marks original as reversed.
  perform public.create_journal_reversal_entry(
    v_je_bal_id,
    v_je_rev_id,
    'JE-TEST',
    104,
    'JE-TEST-000104',
    '2026-01-20',
    'تصحيح خطأ محاسبي'
  );

  -- Check original entry status changed to 'reversed'
  select status into v_res_status from journal_entries where id = v_je_bal_id;
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_rev_count, v_rev_debit, v_rev_credit
    from journal_lines
    where entry_id = v_je_rev_id;

  if v_res_status = 'reversed' and v_rev_count = 2 and v_rev_debit = 5000.0000 and v_rev_credit = 5000.0000 then
    insert into test_results values (5, 'Journal Reversal Helper', 'PASS', 'Original marked reversed and reversing entry created balanced (5000 Dr = 5000 Cr)');
  else
    insert into test_results values (5, 'Journal Reversal Helper', 'FAIL', 'Original status: ' || coalesce(v_res_status, 'null') || ', rev lines: ' || v_rev_count);
  end if;

  -- -------------------------------------------------------------------
  -- TEST 6: Single-Transaction Atomic Draft->Lines->Post Workflow
  -- -------------------------------------------------------------------
  -- Simulates sync_push_document internal ordering:
  -- Step a: Insert header as 'draft'
  -- Step b: Insert balanced lines
  -- Step c: Update header to 'posted' (triggers check_entry_balanced without premature error)
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_je_atomic_id, v_branch_id, 'JE-TEST', 105, 'JE-TEST-000105', '2026-01-25', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    ('99999999-9999-4999-8999-999999999931', v_je_atomic_id, 1, v_acc_cash, 1200.0000, 0),
    ('99999999-9999-4999-8999-999999999932', v_je_atomic_id, 2, v_acc_revenue, 0, 1200.0000);

  update journal_entries set status = 'posted' where id = v_je_atomic_id;

  select status into v_res_status from journal_entries where id = v_je_atomic_id;
  if v_res_status = 'posted' then
    insert into test_results values (6, 'Atomic Header+Lines Posting', 'PASS', 'Single transaction draft->lines->posted sequence succeeded');
  else
    insert into test_results values (6, 'Atomic Header+Lines Posting', 'FAIL', 'Atomic posting failed with status: ' || coalesce(v_res_status, 'null'));
  end if;

END $$;

SELECT * FROM test_results ORDER BY test_no;

ROLLBACK;
