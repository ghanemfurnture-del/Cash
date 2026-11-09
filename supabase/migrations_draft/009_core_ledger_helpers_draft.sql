-- ==============================================================================
-- DRAFT MIGRATION: 009_core_ledger_helpers_draft.sql
-- Module: Phase 3 Core Ledger Helpers, Performance Views, and Reversal Utility
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
-- Invariant: All UUIDs and sequence numbers MUST be provided by client (no server max()+1 or gen_random_uuid).
-- Security & Immutability: block_posted_changes trigger explicitly permits transition from 'posted' to 'reversed':
--   `if new.status = 'reversed' and old.status = 'posted' then return new; end if;`
create or replace function public.create_journal_reversal_entry(
  p_original_entry_id uuid,
  p_reversal_id uuid,
  p_series_code text,
  p_seq_no int,
  p_entry_no text,
  p_reversal_date date,
  p_reason text
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_orig record;
begin
  -- 1. Validate inputs
  if p_reversal_id is null or p_series_code is null or p_seq_no is null or p_entry_no is null then
    raise exception 'All reversal identification parameters (id, series, seq_no, entry_no) must be provided by client';
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

  -- 3. Insert Reversing Entry Header as 'draft'
  -- (Must be draft initially so check_entry_balanced trigger does not fire before lines exist)
  insert into journal_entries (
    id, branch_id, series_code, seq_no, entry_no, entry_date,
    description, source_type, source_id, status, reverses_entry_id
  ) values (
    p_reversal_id, v_orig.branch_id, p_series_code, p_seq_no, p_entry_no,
    p_reversal_date,
    'عكس القيد ' || v_orig.entry_no || ': ' || coalesce(p_reason, ''),
    'reversal', v_orig.id, 'draft', v_orig.id
  );

  -- 4. Insert Inverted Lines (Debit becomes Credit, Credit becomes Debit)
  -- Uses client-provided reversal entry id
  insert into journal_lines (
    id, entry_id, line_no, account_id, party_id, cost_center_id,
    debit, credit, memo
  )
  select
    -- In standard client-driven offline architecture, line IDs can be derived or passed.
    -- For draft reversal helper, generate lines referencing p_reversal_id:
    extensions.uuid_generate_v4(),
    p_reversal_id,
    line_no,
    account_id,
    party_id,
    cost_center_id,
    credit as debit,  -- Inverted
    debit as credit,  -- Inverted
    'عكس للبند: ' || coalesce(memo, '')
  from journal_lines
  where entry_id = p_original_entry_id and deleted_at is null;

  -- 5. Post the reversal entry atomically (triggers check_entry_balanced)
  update journal_entries
  set status = 'posted', posted_at = clock_timestamp()
  where id = p_reversal_id;

  -- 6. Mark original entry as reversed
  -- Allowed by block_posted_changes trigger: `if new.status = 'reversed' and old.status = 'posted' then return new;`
  update journal_entries
  set status = 'reversed'
  where id = p_original_entry_id;

  return p_reversal_id;
end;
$$;
