BEGIN;

-- =====================================================================
-- supabase/tests/draft_010_ledger_validation_test.sql
-- Phase 3 Draft Verification Suite: Ledger Invariants & Double-Entry Rules
-- Self-contained test suite using deterministic 2099 fixtures and inline
-- draft helper definition so it runs cleanly without applying migration 010.
-- Verified against real schemas 001-008:
--   - fiscal_years (id, name, start_date, end_date, status)
--   - fiscal_periods (id, fiscal_year_id, start_date, end_date, status)
--   - accounts (id, code, name_ar, type, normal_side, is_postable, is_system, is_active)
--   - branches (id, code, name_ar, is_main, is_active)
--   - journal_entries / journal_lines
-- Transaction ends strictly with ROLLBACK; ensuring zero side effects.
-- =====================================================================

-- Embed draft function inside transaction (rolled back cleanly at end)
drop function if exists public.create_journal_reversal_entry(uuid, uuid, text, int, text, date, text);
drop function if exists public.create_journal_reversal_entry(uuid, uuid, text, int, text, date, text, jsonb);

create or replace function public.create_journal_reversal_entry(
  p_original_entry_id uuid,
  p_reversal_id uuid,
  p_series_code text,
  p_seq_no int,
  p_entry_no text,
  p_reversal_date date,
  p_reason text,
  p_line_ids jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_orig record;
  v_orig_line_count int;
  v_mapped_line_count int;
  v_line record;
  v_new_line_id_text text;
  v_uuid_regex text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if p_reversal_id is null or p_series_code is null or p_seq_no is null or p_entry_no is null then
    raise exception 'All reversal header parameters (p_reversal_id, p_series_code, p_seq_no, p_entry_no) must be provided by client';
  end if;

  if p_line_ids is null or jsonb_typeof(p_line_ids) <> 'object' then
    raise exception 'p_line_ids must be a JSONB object mapping original line_no (as text) to client-generated UUID';
  end if;

  select * into v_orig
  from journal_entries
  where id = p_original_entry_id and deleted_at is null;

  if not found then
    raise exception 'Original journal entry % not found', p_original_entry_id;
  end if;

  if v_orig.status <> 'posted' then
    raise exception 'Cannot reverse non-posted journal entry (current status: %)', v_orig.status;
  end if;

  select count(*) into v_orig_line_count
  from journal_lines
  where entry_id = p_original_entry_id and deleted_at is null;

  if v_orig_line_count < 2 then
    raise exception 'Original journal entry % must have at least 2 active lines to reverse', p_original_entry_id;
  end if;

  v_mapped_line_count := 0;
  for v_line in
    select line_no from journal_lines where entry_id = p_original_entry_id and deleted_at is null
  loop
    v_new_line_id_text := p_line_ids ->> v_line.line_no::text;
    if v_new_line_id_text is null or not (v_new_line_id_text ~* v_uuid_regex) then
      raise exception 'Missing or invalid client UUID in p_line_ids for line_no %', v_line.line_no;
    end if;
    v_mapped_line_count := v_mapped_line_count + 1;
  end loop;

  if v_mapped_line_count <> v_orig_line_count then
    raise exception 'Client p_line_ids map count mismatch';
  end if;

  insert into journal_entries (
    id, branch_id, series_code, seq_no, entry_no, entry_date,
    description, source_type, source_id, status, reverses_entry_id
  ) values (
    p_reversal_id, v_orig.branch_id, p_series_code, p_seq_no, p_entry_no,
    p_reversal_date,
    'عكس القيد ' || v_orig.entry_no || ': ' || coalesce(p_reason, ''),
    'reversal', v_orig.id, 'draft', v_orig.id
  );

  insert into journal_lines (
    id, entry_id, line_no, account_id, party_id, cost_center_id,
    debit, credit, currency_code, fx_amount, memo
  )
  select
    (p_line_ids ->> line_no::text)::uuid,
    p_reversal_id,
    line_no,
    account_id,
    party_id,
    cost_center_id,
    credit as debit,
    debit as credit,
    currency_code,
    fx_amount,
    'عكس للبند: ' || coalesce(memo, '')
  from journal_lines
  where entry_id = p_original_entry_id and deleted_at is null;

  update journal_entries
  set status = 'posted', posted_at = clock_timestamp()
  where id = p_reversal_id;

  update journal_entries
  set status = 'reversed'
  where id = p_original_entry_id;

  return p_reversal_id;
end;
$$;

CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

DO $$
DECLARE
  -- Deterministic Fixture IDs (no select limit 1)
  v_branch_id uuid := '99999999-9999-4999-8999-999999999900';
  v_acc_cash uuid := '99999999-9999-4999-8999-9999999999a1';
  v_acc_revenue uuid := '99999999-9999-4999-8999-9999999999a2';
  v_fy_id uuid := '99999999-9999-4999-8999-9999999999b0';
  v_open_period_id uuid := '99999999-9999-4999-8999-9999999999b1';
  v_closed_period_id uuid := '99999999-9999-4999-8999-9999999999b2';
  v_period_to_close_id uuid := '99999999-9999-4999-8999-9999999999b3';

  -- Deterministic Entry IDs
  v_je_bal_id uuid := '99999999-9999-4999-8999-999999999911';
  v_je_unbal_id uuid := '99999999-9999-4999-8999-999999999912';
  v_je_closed_id uuid := '99999999-9999-4999-8999-999999999913';
  v_je_rev_id uuid := '99999999-9999-4999-8999-999999999914';
  v_je_mar_id uuid := '99999999-9999-4999-8999-999999999915';
  v_je_mar_rev_open_id uuid := '99999999-9999-4999-8999-999999999916';
  v_je_atomic_id uuid := '99999999-9999-4999-8999-999999999917';
  v_je_rev_closed_fail_id uuid := '99999999-9999-4999-8999-999999999918';

  v_err_caught boolean;
  v_err_msg text;
  v_sqlstate text;
  v_res_status text;
  v_rev_status text;
  v_rev_line1_credit numeric;
  v_rev_line2_debit numeric;
  v_has_period_trigger boolean;
BEGIN
  -- -------------------------------------------------------------------
  -- 0. Deterministic Isolated Fixtures (Year 2099)
  -- -------------------------------------------------------------------
  insert into branches (id, code, name_ar, is_main, is_active)
  values (v_branch_id, 'BR-T99', 'فرع اختبار 2099', false, true)
  on conflict (id) do nothing;

  insert into accounts (id, code, name_ar, type, normal_side, is_postable, is_system, is_active)
  values
    (v_acc_cash, 'T99-1101', 'صندوق اختبار 2099', 'asset', 'debit', true, false, true),
    (v_acc_revenue, 'T99-4101', 'مبيعات اختبار 2099', 'revenue', 'credit', true, false, true)
  on conflict (id) do nothing;

  insert into fiscal_years (id, name, start_date, end_date, status)
  values (v_fy_id, 'FY-2099-TEST', '2099-01-01', '2099-12-31', 'open')
  on conflict (id) do nothing;

  insert into fiscal_periods (id, fiscal_year_id, start_date, end_date, status)
  values
    (v_open_period_id, v_fy_id, '2099-01-01', '2099-01-31', 'open'),
    (v_closed_period_id, v_fy_id, '2099-02-01', '2099-02-28', 'closed'),
    (v_period_to_close_id, v_fy_id, '2099-03-01', '2099-03-31', 'open')
  on conflict (id) do nothing;

  -- -------------------------------------------------------------------
  -- TEST 1: Balanced Journal Entry (Debit = Credit) Posts Successfully
  -- -------------------------------------------------------------------
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_je_bal_id, v_branch_id, 'JE-T99', 101, 'JE-T99-000101', '2099-01-15', 'draft');

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
  values (v_je_unbal_id, v_branch_id, 'JE-T99', 102, 'JE-T99-000102', '2099-01-16', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    ('99999999-9999-4999-8999-999999999923', v_je_unbal_id, 1, v_acc_cash, 5000.0000, 0),
    ('99999999-9999-4999-8999-999999999924', v_je_unbal_id, 2, v_acc_revenue, 0, 3000.0000);

  v_err_caught := false;
  v_err_msg := null;
  begin
    update journal_entries set status = 'posted' where id = v_je_unbal_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg like 'journal entry % not balanced%' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (2, 'Unbalanced Entry Rejected', 'PASS', 'check_entry_balanced rejected with exact P0001: ' || v_err_msg);
  else
    insert into test_results values (2, 'Unbalanced Entry Rejected', 'FAIL', 'Expected check_entry_balanced error, got: ' || coalesce(v_err_msg, 'none'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 3: Posted Entry Line Update AND New Line INSERT Blocked (G4-c)
  -- -------------------------------------------------------------------
  -- 3a: Update existing line on posted entry
  v_err_caught := false;
  v_err_msg := null;
  begin
    update journal_lines set debit = 6000.0000 where entry_id = v_je_bal_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (3, 'Posted Lines UPDATE Blocked', 'PASS', 'trg_block_jl blocked line UPDATE: ' || v_err_msg);
  else
    insert into test_results values (3, 'Posted Lines UPDATE Blocked', 'FAIL', 'Expected cannot change lines error, got: ' || coalesce(v_err_msg, 'none'));
  end if;

  -- 3b: Insert brand new line onto already posted entry
  v_err_caught := false;
  v_err_msg := null;
  begin
    insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
    values ('99999999-9999-4999-8999-999999999929', v_je_bal_id, 3, v_acc_cash, 100.0000, 0);
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (4, 'Posted Lines INSERT Blocked (G4-c)', 'PASS', 'trg_block_jl blocked INSERT into posted entry: ' || v_err_msg);
  else
    insert into test_results values (4, 'Posted Lines INSERT Blocked (G4-c)', 'FAIL', 'Expected cannot change lines error on INSERT, got: ' || coalesce(v_err_msg, 'none'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 5: Closed Fiscal Period Posting Blocked (with BALANCED lines)
  -- -------------------------------------------------------------------
  select exists (
    select 1 from pg_trigger
    where tgname = 'trg_period_je' and tgrelid = 'public.journal_entries'::regclass
  ) into v_has_period_trigger;

  if not v_has_period_trigger then
    insert into test_results values (5, 'Closed Period Posting Blocked', 'FAIL', 'Trigger trg_period_je not found on journal_entries');
  else
    -- Insert draft + balanced lines first so check_entry_balanced passes; rejection is strictly due to closed period on UPDATE to posted
    insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
    values (v_je_closed_id, v_branch_id, 'JE-T99', 103, 'JE-T99-000103', '2099-02-15', 'draft');

    insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
    values
      ('99999999-9999-4999-8999-999999999925', v_je_closed_id, 1, v_acc_cash, 4000.0000, 0),
      ('99999999-9999-4999-8999-999999999926', v_je_closed_id, 2, v_acc_revenue, 0, 4000.0000);

    v_err_caught := false;
    v_err_msg := null;
    begin
      update journal_entries set status = 'posted' where id = v_je_closed_id;
    exception when others then
      get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
      if v_sqlstate = 'P0001' and v_err_msg = 'no open fiscal period for date 2099-02-15' then
        v_err_caught := true;
      end if;
    end;

    if v_err_caught then
      insert into test_results values (5, 'Closed Period Posting Blocked', 'PASS', 'require_open_period rejected balanced entry in closed period: ' || v_err_msg);
    else
      insert into test_results values (5, 'Closed Period Posting Blocked', 'FAIL', 'Expected closed period error, got: ' || coalesce(v_err_msg, 'none'));
    end if;
  end if;

  -- -------------------------------------------------------------------
  -- TEST 6: Journal Reversal Helper (Client JSONB Line UUIDs)
  -- -------------------------------------------------------------------
  perform public.create_journal_reversal_entry(
    v_je_bal_id,
    v_je_rev_id,
    'JE-T99',
    104,
    'JE-T99-000104',
    '2099-01-20',
    'تصحيح خطأ محاسبي',
    jsonb_build_object(
      '1', '99999999-9999-4999-8999-999999999941',
      '2', '99999999-9999-4999-8999-999999999942'
    )
  );

  select status into v_res_status from journal_entries where id = v_je_bal_id;
  select status into v_rev_status from journal_entries where id = v_je_rev_id;
  select credit into v_rev_line1_credit from journal_lines where id = '99999999-9999-4999-8999-999999999941';
  select debit into v_rev_line2_debit from journal_lines where id = '99999999-9999-4999-8999-999999999942';

  if v_res_status = 'reversed' and v_rev_status = 'posted'
     and v_rev_line1_credit = 5000.0000 and v_rev_line2_debit = 5000.0000 then
    insert into test_results values (6, 'Reversal Helper with Client Line UUIDs', 'PASS', 'Original=reversed, Reversal=posted, client line UUIDs used and inverted (5000 <-> 5000)');
  else
    insert into test_results values (6, 'Reversal Helper with Client Line UUIDs', 'FAIL', 'orig=' || coalesce(v_res_status, 'null') || ', rev=' || coalesce(v_rev_status, 'null'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 7: Reversing an Entry Whose Date is in a Closed Period (G4-b)
  -- -------------------------------------------------------------------
  -- Step 7a: Post entry while Period 3 (2099-03) is open
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_je_mar_id, v_branch_id, 'JE-T99', 105, 'JE-T99-000105', '2099-03-15', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    ('99999999-9999-4999-8999-999999999931', v_je_mar_id, 1, v_acc_cash, 2500.0000, 0),
    ('99999999-9999-4999-8999-999999999932', v_je_mar_id, 2, v_acc_revenue, 0, 2500.0000);

  update journal_entries set status = 'posted' where id = v_je_mar_id;

  -- Now CLOSE Period 3
  update fiscal_periods set status = 'closed' where id = v_period_to_close_id;

  -- Reverse using OPEN period reversal date (2099-01-25):
  -- Proves require_open_period skips `posted -> reversed` update on original closed-period entry
  perform public.create_journal_reversal_entry(
    v_je_mar_id,
    v_je_mar_rev_open_id,
    'JE-T99',
    106,
    'JE-T99-000106',
    '2099-01-25',
    'عكس قيد فترة مقفولة بتاريخ فترة مفتوحة',
    jsonb_build_object(
      '1', '99999999-9999-4999-8999-999999999943',
      '2', '99999999-9999-4999-8999-999999999944'
    )
  );

  select status into v_res_status from journal_entries where id = v_je_mar_id;
  select status into v_rev_status from journal_entries where id = v_je_mar_rev_open_id;

  if v_res_status = 'reversed' and v_rev_status = 'posted' then
    insert into test_results values (7, 'Reverse Closed-Period Entry in Open Date (G4-b)', 'PASS', 'Original entry in closed period marked reversed; new counter-entry posted in open period');
  else
    insert into test_results values (7, 'Reverse Closed-Period Entry in Open Date (G4-b)', 'FAIL', 'orig=' || coalesce(v_res_status, 'null') || ', rev=' || coalesce(v_rev_status, 'null'));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 8: Atomic Draft->Lines->Post AND Blocked Reversal in Closed Date
  -- -------------------------------------------------------------------
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values (v_je_atomic_id, v_branch_id, 'JE-T99', 107, 'JE-T99-000107', '2099-01-28', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    ('99999999-9999-4999-8999-999999999933', v_je_atomic_id, 1, v_acc_cash, 1200.0000, 0),
    ('99999999-9999-4999-8999-999999999934', v_je_atomic_id, 2, v_acc_revenue, 0, 1200.0000);

  update journal_entries set status = 'posted' where id = v_je_atomic_id;

  select status into v_res_status from journal_entries where id = v_je_atomic_id;
  if v_res_status = 'posted' then
    insert into test_results values (8, 'Atomic Draft->Lines->Post Workflow', 'PASS', 'Single transaction draft->lines->posted sequence succeeded');
  else
    insert into test_results values (8, 'Atomic Draft->Lines->Post Workflow', 'FAIL', 'Atomic posting failed with status: ' || coalesce(v_res_status, 'null'));
  end if;

  -- Attempt reversal with CLOSED reversal date (2099-03-20): must be rejected by require_open_period
  v_err_caught := false;
  v_err_msg := null;
  begin
    perform public.create_journal_reversal_entry(
      v_je_atomic_id,
      v_je_rev_closed_fail_id,
      'JE-T99',
      108,
      'JE-T99-000108',
      '2099-03-20',
      'محاولة عكس بتاريخ فترة مقفولة',
      jsonb_build_object(
        '1', '99999999-9999-4999-8999-999999999945',
        '2', '99999999-9999-4999-8999-999999999946'
      )
    );
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'no open fiscal period for date 2099-03-20' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (9, 'Reversal Date in Closed Period Blocked (G4-b)', 'PASS', 'Posting reversal entry into closed period rejected: ' || v_err_msg);
  else
    insert into test_results values (9, 'Reversal Date in Closed Period Blocked (G4-b)', 'FAIL', 'Expected closed period error, got: ' || coalesce(v_err_msg, 'none'));
  end if;

END $$;

SELECT * FROM test_results ORDER BY test_no;

ROLLBACK;
