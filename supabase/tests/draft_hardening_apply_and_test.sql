BEGIN;

-- =====================================================================
-- supabase/tests/draft_hardening_apply_and_test.sql
-- Phase 3 Hardening Verification Suite (H3):
--   1) Applies draft 009 hardening inside this transaction:
--      - block_posted_children() checking BOTH OLD (UPDATE/DELETE) and NEW (INSERT/UPDATE)
--      - btree_gist + excl_fiscal_periods_no_overlap on fiscal_periods
--   2) Executes all 5 tests from draft_hardening_posted_children_test.sql +
--      re-parenting INTO posted + overlapping period exclusion check.
--   Expected result after hardening: ALL 7 tests report 'PASS'.
--   Ends strictly with ROLLBACK; leaving zero persistent changes.
-- =====================================================================

-- Step 1: Apply 009 hardening inside uncommitted transaction
create or replace function public.block_posted_children()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_pid uuid;
  v_old_status text;
  v_new_pid uuid;
  v_new_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_pid := (to_jsonb(old) ->> tg_argv[1])::uuid;
    if v_old_pid is not null then
      execute format('select status from %I where id = $1', tg_argv[0])
        into v_old_status
        using v_old_pid;
      if v_old_status in ('posted', 'reversed') then
        raise exception 'cannot change lines of a posted record';
      end if;
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new_pid := (to_jsonb(new) ->> tg_argv[1])::uuid;
    if v_new_pid is not null then
      execute format('select status from %I where id = $1', tg_argv[0])
        into v_new_status
        using v_new_pid;
      if v_new_status in ('posted', 'reversed') then
        raise exception 'cannot change lines of a posted record';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create extension if not exists btree_gist;

alter table public.fiscal_periods
  drop constraint if exists excl_fiscal_periods_no_overlap;

alter table public.fiscal_periods
  add constraint excl_fiscal_periods_no_overlap
  exclude using gist (
    daterange(start_date, end_date, '[]') with &&
  )
  where (deleted_at is null);

-- Step 2: Verification Suite
CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

DO $$
DECLARE
  v_branch_id uuid := '99999999-9999-4999-8999-999999999900';
  v_acc_cash uuid := '99999999-9999-4999-8999-9999999999a1';
  v_acc_revenue uuid := '99999999-9999-4999-8999-9999999999a2';
  v_fy_id uuid := '99999999-9999-4999-8999-9999999999b0';
  v_open_period_id uuid := '99999999-9999-4999-8999-9999999999b1';
  v_overlap_period_id uuid := '99999999-9999-4999-8999-9999999999b9';

  v_je_posted_id uuid := '99999999-9999-4999-8999-999999999c01';
  v_je_draft_id uuid := '99999999-9999-4999-8999-999999999c02';
  v_jl_line1_id uuid := '99999999-9999-4999-8999-999999999c11';
  v_jl_line2_id uuid := '99999999-9999-4999-8999-999999999c12';
  v_jl_draft_line_id uuid := '99999999-9999-4999-8999-999999999c13';

  v_doc_posted_id uuid := '99999999-9999-4999-8999-999999999d01';
  v_doc_draft_id uuid := '99999999-9999-4999-8999-999999999d02';
  v_dl_line1_id uuid := '99999999-9999-4999-8999-999999999d11';
  v_dl_line2_id uuid := '99999999-9999-4999-8999-999999999d12';

  v_err_caught boolean;
  v_err_msg text;
  v_sqlstate text;

  v_sum_debit numeric;
  v_sum_credit numeric;
  v_line_count int;
BEGIN
  -- 0. Deterministic Isolated Fixtures (Year 2099)
  insert into branches (id, code, name_ar, is_main, is_active)
  values (v_branch_id, 'BR-H3', 'فرع اختبار H3', false, true)
  on conflict (id) do nothing;

  insert into accounts (id, code, name_ar, type, normal_side, is_postable, is_system, is_active)
  values
    (v_acc_cash, 'H3-1101', 'صندوق اختبار H3', 'asset', 'debit', true, false, true),
    (v_acc_revenue, 'H3-4101', 'مبيعات اختبار H3', 'revenue', 'credit', true, false, true)
  on conflict (id) do nothing;

  insert into fiscal_years (id, name, start_date, end_date, status)
  values (v_fy_id, 'FY-2099-H3', '2099-01-01', '2099-12-31', 'open')
  on conflict (id) do nothing;

  insert into fiscal_periods (id, fiscal_year_id, start_date, end_date, status)
  values (v_open_period_id, v_fy_id, '2099-01-01', '2099-01-31', 'open')
  on conflict (id) do nothing;

  -- Create Posted & Draft Journal Entries
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values
    (v_je_posted_id, v_branch_id, 'JE-H3', 301, 'JE-H3-000301', '2099-01-15', 'draft'),
    (v_je_draft_id,  v_branch_id, 'JE-H3', 302, 'JE-H3-000302', '2099-01-16', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    (v_jl_line1_id,      v_je_posted_id, 1, v_acc_cash,    5000.0000, 0),
    (v_jl_line2_id,      v_je_posted_id, 2, v_acc_revenue, 0,         5000.0000),
    (v_jl_draft_line_id, v_je_draft_id,  1, v_acc_cash,    2500.0000, 0);

  update journal_entries set status = 'posted', posted_at = clock_timestamp() where id = v_je_posted_id;

  -- Create Posted & Draft Documents
  insert into documents (id, branch_id, doc_type, series_code, seq_no, doc_no, doc_date, subtotal, total, status)
  values
    (v_doc_posted_id, v_branch_id, 'sales_invoice', 'DOC-H3', 301, 'INV-H3-000301', '2099-01-15', 1000.0000, 1000.0000, 'draft'),
    (v_doc_draft_id,  v_branch_id, 'sales_invoice', 'DOC-H3', 302, 'INV-H3-000302', '2099-01-16', 0, 0, 'draft');

  insert into document_lines (id, document_id, line_no, description, qty, unit_factor, unit_price, line_total)
  values
    (v_dl_line1_id, v_doc_posted_id, 1, 'بند 1', 1, 1, 600.0000, 600.0000),
    (v_dl_line2_id, v_doc_posted_id, 2, 'بند 2', 1, 1, 400.0000, 400.0000);

  update documents set status = 'posted', posted_at = clock_timestamp() where id = v_doc_posted_id;

  -- -------------------------------------------------------------------
  -- TEST 1: Re-parent journal_line FROM posted entry -> draft entry (must block!)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  begin
    update journal_lines set entry_id = v_je_draft_id where id = v_jl_line1_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (1, 'UPDATE journal_lines.entry_id (posted -> draft)', 'PASS', 'Blocked with expected error: ' || v_err_msg);
  else
    insert into test_results values (1, 'UPDATE journal_lines.entry_id (posted -> draft)', 'FAIL', 'Expected block did not occur! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 2: Re-parent document_line FROM posted doc -> draft doc (must block!)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  begin
    update document_lines set document_id = v_doc_draft_id where id = v_dl_line1_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (2, 'UPDATE document_lines.document_id (posted -> draft)', 'PASS', 'Blocked with expected error: ' || v_err_msg);
  else
    insert into test_results values (2, 'UPDATE document_lines.document_id (posted -> draft)', 'FAIL', 'Expected block did not occur! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 3: DELETE journal_line belonging to posted entry (must block!)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  begin
    delete from journal_lines where id = v_jl_line2_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (3, 'DELETE journal_lines of posted entry', 'PASS', 'Blocked with expected error: ' || v_err_msg);
  else
    insert into test_results values (3, 'DELETE journal_lines of posted entry', 'FAIL', 'Expected block did not occur! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: DELETE document_line belonging to posted document (must block!)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  begin
    delete from document_lines where id = v_dl_line2_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (4, 'DELETE document_lines of posted document', 'PASS', 'Blocked with expected error: ' || v_err_msg);
  else
    insert into test_results values (4, 'DELETE document_lines of posted document', 'FAIL', 'Expected block did not occur! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 5: Verify Balance Integrity of Posted Journal Entry (must stay balanced!)
  -- -------------------------------------------------------------------
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
  into v_sum_debit, v_sum_credit, v_line_count
  from journal_lines
  where entry_id = v_je_posted_id and deleted_at is null;

  if v_line_count = 2 and v_sum_debit = 5000.0000 and v_sum_credit = 5000.0000 then
    insert into test_results values (5, 'Posted Entry Balance Integrity', 'PASS', format('Balanced: debit=%s, credit=%s, lines=%s', v_sum_debit, v_sum_credit, v_line_count));
  else
    insert into test_results values (5, 'Posted Entry Balance Integrity', 'FAIL', format('Posted entry integrity broken! debit=%s, credit=%s, lines=%s', v_sum_debit, v_sum_credit, v_line_count));
  end if;

  -- -------------------------------------------------------------------
  -- TEST 6: Re-parent journal_line FROM draft entry -> posted entry (NEW check!)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  begin
    update journal_lines set entry_id = v_je_posted_id where id = v_jl_draft_line_id;
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = 'P0001' and v_err_msg = 'cannot change lines of a posted record' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (6, 'UPDATE journal_lines.entry_id (draft -> posted)', 'PASS', 'Blocked with expected error: ' || v_err_msg);
  else
    insert into test_results values (6, 'UPDATE journal_lines.entry_id (draft -> posted)', 'FAIL', 'Expected block did not occur! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 7: Reject overlapping fiscal_periods (GiST Exclusion Constraint)
  -- -------------------------------------------------------------------
  v_err_caught := false;
  v_err_msg := null;
  v_sqlstate := null;
  begin
    insert into fiscal_periods (id, fiscal_year_id, start_date, end_date, status)
    values (v_overlap_period_id, v_fy_id, '2099-01-15', '2099-02-15', 'open');
  exception when others then
    get stacked diagnostics v_err_msg = message_text, v_sqlstate = returned_sqlstate;
    if v_sqlstate = '23P01' then
      v_err_caught := true;
    end if;
  end;

  if v_err_caught then
    insert into test_results values (7, 'Reject overlapping fiscal_periods (23P01)', 'PASS', 'Blocked with SQLSTATE 23P01: ' || v_err_msg);
  else
    insert into test_results values (7, 'Reject overlapping fiscal_periods (23P01)', 'FAIL', 'Overlapping period was inserted! (sqlstate=' || coalesce(v_sqlstate, 'none') || ', msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

END $$;

SELECT * FROM test_results ORDER BY test_no;

ROLLBACK;
