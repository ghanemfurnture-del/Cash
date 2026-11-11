BEGIN;

-- =====================================================================
-- supabase/tests/draft_hardening_posted_children_test.sql
-- Phase 3 Security Proof Suite (H2): Re-parenting Vulnerability vs Delete Lock
-- Self-contained script with deterministic 2099 fixtures (does NOT apply 009).
-- Expected behavior on UNPATCHED 001-008:
--   Test 1 (UPDATE journal_lines.entry_id): VULNERABLE (line stolen from posted entry)
--   Test 2 (UPDATE document_lines.document_id): VULNERABLE (line stolen from posted doc)
--   Test 3 (DELETE journal_lines of posted): PASS (blocked by OLD check in DELETE)
--   Test 4 (DELETE document_lines of posted): PASS (blocked by OLD check in DELETE)
--   Test 5 (Posted entry balance invariant): VULNERABLE (posted entry left unbalanced!)
-- Ends strictly with ROLLBACK; leaving zero side effects.
-- =====================================================================

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

  v_je_posted_id uuid := '99999999-9999-4999-8999-999999999c01';
  v_je_draft_id uuid := '99999999-9999-4999-8999-999999999c02';
  v_jl_line1_id uuid := '99999999-9999-4999-8999-999999999c11';
  v_jl_line2_id uuid := '99999999-9999-4999-8999-999999999c12';

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
  values (v_branch_id, 'BR-H2', 'فرع اختبار H2', false, true)
  on conflict (id) do nothing;

  insert into accounts (id, code, name_ar, type, normal_side, is_postable, is_system, is_active)
  values
    (v_acc_cash, 'H2-1101', 'صندوق اختبار H2', 'asset', 'debit', true, false, true),
    (v_acc_revenue, 'H2-4101', 'مبيعات اختبار H2', 'revenue', 'credit', true, false, true)
  on conflict (id) do nothing;

  insert into fiscal_years (id, name, start_date, end_date, status)
  values (v_fy_id, 'FY-2099-H2', '2099-01-01', '2099-12-31', 'open')
  on conflict (id) do nothing;

  insert into fiscal_periods (id, fiscal_year_id, start_date, end_date, status)
  values (v_open_period_id, v_fy_id, '2099-01-01', '2099-01-31', 'open')
  on conflict (id) do nothing;

  -- Create Posted & Draft Journal Entries
  insert into journal_entries (id, branch_id, series_code, seq_no, entry_no, entry_date, status)
  values
    (v_je_posted_id, v_branch_id, 'JE-H2', 201, 'JE-H2-000201', '2099-01-15', 'draft'),
    (v_je_draft_id,  v_branch_id, 'JE-H2', 202, 'JE-H2-000202', '2099-01-16', 'draft');

  insert into journal_lines (id, entry_id, line_no, account_id, debit, credit)
  values
    (v_jl_line1_id, v_je_posted_id, 1, v_acc_cash, 5000.0000, 0),
    (v_jl_line2_id, v_je_posted_id, 2, v_acc_revenue, 0, 5000.0000);

  update journal_entries set status = 'posted', posted_at = clock_timestamp() where id = v_je_posted_id;

  -- Create Posted & Draft Documents (with 2 lines on posted doc so tests 2 & 4 are independent)
  insert into documents (id, branch_id, doc_type, series_code, seq_no, doc_no, doc_date, subtotal, total, status)
  values
    (v_doc_posted_id, v_branch_id, 'sales_invoice', 'DOC-H2', 201, 'INV-H2-000201', '2099-01-15', 1000.0000, 1000.0000, 'draft'),
    (v_doc_draft_id,  v_branch_id, 'sales_invoice', 'DOC-H2', 202, 'INV-H2-000202', '2099-01-16', 0, 0, 'draft');

  insert into document_lines (id, document_id, line_no, description, qty, unit_factor, unit_price, line_total)
  values
    (v_dl_line1_id, v_doc_posted_id, 1, 'بند 1', 1, 1, 600.0000, 600.0000),
    (v_dl_line2_id, v_doc_posted_id, 2, 'بند 2', 1, 1, 400.0000, 400.0000);

  update documents set status = 'posted', posted_at = clock_timestamp() where id = v_doc_posted_id;

  -- -------------------------------------------------------------------
  -- TEST 1: Re-parent journal_line from posted entry -> draft entry
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
    insert into test_results values (1, 'UPDATE journal_lines.entry_id (posted -> draft)', 'VULNERABLE', 'Line was moved from posted entry to draft entry without rejection! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 2: Re-parent document_line from posted doc -> draft doc
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
    insert into test_results values (2, 'UPDATE document_lines.document_id (posted -> draft)', 'VULNERABLE', 'Line was moved from posted document to draft document without rejection! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 3: DELETE journal_line belonging to posted entry
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
    insert into test_results values (3, 'DELETE journal_lines of posted entry', 'VULNERABLE', 'Line of posted entry was deleted! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 4: DELETE document_line belonging to posted document
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
    insert into test_results values (4, 'DELETE document_lines of posted document', 'VULNERABLE', 'Line of posted document was deleted! (msg=' || coalesce(v_err_msg, 'none') || ')');
  end if;

  -- -------------------------------------------------------------------
  -- TEST 5: Verify Balance Integrity of Posted Journal Entry
  -- -------------------------------------------------------------------
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
  into v_sum_debit, v_sum_credit, v_line_count
  from journal_lines
  where entry_id = v_je_posted_id and deleted_at is null;

  if v_line_count >= 2 and v_sum_debit = v_sum_credit then
    insert into test_results values (5, 'Posted Entry Balance Integrity', 'PASS', format('Balanced: debit=%s, credit=%s, lines=%s', v_sum_debit, v_sum_credit, v_line_count));
  else
    insert into test_results values (5, 'Posted Entry Balance Integrity', 'VULNERABLE', format('Posted entry UNBALANCED! debit=%s, credit=%s, lines=%s', v_sum_debit, v_sum_credit, v_line_count));
  end if;

END $$;

SELECT * FROM test_results ORDER BY test_no;

ROLLBACK;
