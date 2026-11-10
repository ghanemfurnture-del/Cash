-- ==============================================================================
-- DRAFT MIGRATION: 009_core_ledger_helpers_draft.sql
-- Module: Phase 3 Core Ledger Helpers, Performance Indexes, and Reversal Utility
-- Status: DRAFT / SPECIFICATION ONLY (NOT APPLIED TO DATABASE)
-- Note: Bundle ingestion for documents+journal is specified for sync_push_document
-- ==============================================================================

-- Tables referenced:
--   - public.journal_entries (created in 001, extended in 002)
--   - public.journal_lines (created in 001)
--   - public.documents (created in 001)
--   - public.fiscal_years / fiscal_periods (created in 001)
--   - public.accounts (created in 001)

-- 1. Ensure Exact Numeric Constraint on Lines (Single side per line)
-- Note: 001 already enforces check ((debit = 0) <> (credit = 0)).
-- We add an explicit constraint verifying non-negative values and decimal precision:
alter table public.journal_lines
  drop constraint if exists chk_jl_positive_values,
  add constraint chk_jl_positive_values check (debit >= 0 and credit >= 0);

-- 2. Performance Indexes for Ledger & Trial Balance Calculations
create index if not exists idx_journal_lines_account_entry
  on public.journal_lines (account_id, entry_id)
  where deleted_at is null;

create index if not exists idx_journal_entries_branch_status_date
  on public.journal_entries (branch_id, status, entry_date)
  where deleted_at is null;

-- 3. Trial Balance Aggregation Function (Server-Side Performance View/RPC)
create or replace function public.get_trial_balance(
  p_branch_id uuid,
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  account_id uuid,
  account_code text,
  account_name_ar text,
  total_debit numeric(18,4),
  total_credit numeric(18,4),
  balance numeric(18,4)
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  select
    a.id as account_id,
    a.code as account_code,
    a.name_ar as account_name_ar,
    coalesce(sum(l.debit), 0)::numeric(18,4) as total_debit,
    coalesce(sum(l.credit), 0)::numeric(18,4) as total_credit,
    (coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0))::numeric(18,4) as balance
  from accounts a
  left join journal_lines l on l.account_id = a.id and l.deleted_at is null
  left join journal_entries e on e.id = l.entry_id and e.deleted_at is null
  where (p_branch_id is null or e.branch_id = p_branch_id or e.branch_id is null)
    and (e.status in ('posted', 'reversed') or e.status is null)
    and (p_start_date is null or e.entry_date >= p_start_date)
    and (p_end_date is null or e.entry_date <= p_end_date)
  group by a.id, a.code, a.name_ar
  order by a.code asc;
end;
$$;

-- 4. Reversal Entry Helper Function
-- Enforces that reversals are strictly created as new counter-entries rather than editing posted rows.
-- INVARIANT: ALL UUIDs (header p_reversal_id AND every line UUID inside p_line_ids jsonb) and sequence numbers
-- MUST be generated and provided by the client. No server-side max()+1, gen_random_uuid(), or uuid_generate_v4().
-- SECURITY & IMMUTABILITY (005_v1_rls_and_security_triggers.sql):
--   * block_posted_changes (line 25): `if not (old.status = 'posted' and new.status = 'reversed') then raise exception ...;`
--     Explicitly permits transitioning the original entry strictly from 'posted' to 'reversed'.
--   * require_open_period (line 56): checks open fiscal period ONLY when `new.status = 'posted'`.
--     Thus, flipping original entry from 'posted' to 'reversed' is NOT blocked even if its date is in a closed period,
--     whereas posting the NEW reversal entry (step 6) strictly requires p_reversal_date to fall in an OPEN period.
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
  -- 1. Validate client-provided header identifiers & line ID map
  if p_reversal_id is null or p_series_code is null or p_seq_no is null or p_entry_no is null then
    raise exception 'All reversal header parameters (p_reversal_id, p_series_code, p_seq_no, p_entry_no) must be provided by client';
  end if;

  if p_line_ids is null or jsonb_typeof(p_line_ids) <> 'object' then
    raise exception 'p_line_ids must be a JSONB object mapping original line_no (as text) to client-generated UUID';
  end if;

  -- 2. Fetch and validate original entry
  select * into v_orig
  from journal_entries
  where id = p_original_entry_id and deleted_at is null;

  if not found then
    raise exception 'Original journal entry % not found', p_original_entry_id;
  end if;

  if v_orig.status <> 'posted' then
    raise exception 'Cannot reverse non-posted journal entry (current status: %)', v_orig.status;
  end if;

  -- 3. Verify every active original line has a valid RFC 4122 UUID in p_line_ids
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

  -- 4. Insert Reversing Entry Header as 'draft'
  -- (Must insert as 'draft' first because check_entry_balanced fires BEFORE INSERT/UPDATE when status = 'posted')
  insert into journal_entries (
    id, branch_id, series_code, seq_no, entry_no, entry_date,
    description, source_type, source_id, status, reverses_entry_id
  ) values (
    p_reversal_id, v_orig.branch_id, p_series_code, p_seq_no, p_entry_no,
    p_reversal_date,
    'عكس القيد ' || v_orig.entry_no || ': ' || coalesce(p_reason, ''),
    'reversal', v_orig.id, 'draft', v_orig.id
  );

  -- 5. Insert Inverted Lines using ONLY client-provided UUIDs from p_line_ids
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
    credit as debit,  -- Inverted
    debit as credit,  -- Inverted
    currency_code,
    fx_amount,
    'عكس للبند: ' || coalesce(memo, '')
  from journal_lines
  where entry_id = p_original_entry_id and deleted_at is null;

  -- 6. Post the reversal entry atomically (triggers check_entry_balanced & require_open_period on p_reversal_date)
  update journal_entries
  set status = 'posted', posted_at = clock_timestamp()
  where id = p_reversal_id;

  -- 7. Mark original entry as reversed
  -- Allowed by block_posted_changes (005 line 25) and skipped by require_open_period (005 line 56)
  update journal_entries
  set status = 'reversed'
  where id = p_original_entry_id;

  return p_reversal_id;
end;
$$;
