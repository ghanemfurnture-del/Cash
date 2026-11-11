-- ==============================================================================
-- DRAFT MIGRATION: 009_posted_children_and_period_hardening_draft.sql
-- Module: Phase 3 Security Hardening (Posted Children Re-parenting & Period Overlap)
-- Status: DRAFT / SPECIFICATION ONLY (NOT APPLIED TO DATABASE)
-- Depends on: 001_core_schema.sql, 002_extended_schema.sql, 005_v1_rls_and_security_triggers.sql
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Harden block_posted_children() against Re-Parenting Attacks
-- ------------------------------------------------------------------------------
-- Vulnerability fixed:
--   In 001/005, block_posted_children() inspected ONLY OLD on DELETE and ONLY NEW
--   on INSERT/UPDATE. Because sync_push_op allowlists parent FK columns
--   (e.g., journal_lines.entry_id, document_lines.document_id), an UPDATE moving a
--   child line FROM a 'posted'/'reversed' parent TO a 'draft' parent bypassed the
--   trigger completely, leaving posted journal entries unbalanced!
--
-- Fix:
--   - On UPDATE and DELETE: inspect OLD parent status via tg_argv[0] / tg_argv[1].
--   - On INSERT and UPDATE: inspect NEW parent status via tg_argv[0] / tg_argv[1].
--   - Preserve SECURITY DEFINER, search_path = public (005), and exact error text
--     'cannot change lines of a posted record' for full client/RPC compatibility.
--   Applies automatically to all existing triggers calling block_posted_children():
--     * trg_block_jl     (journal_lines -> journal_entries.entry_id)
--     * trg_block_dl     (document_lines -> documents.document_id)
--     * trg_block_slips  (payslips -> payroll_runs.run_id)
--     * trg_block_deprln (depreciation_lines -> depreciation_runs.run_id)
--     * trg_block_docpay (document_payments -> documents.document_id)
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- 2. Prevent Overlapping Fiscal Periods (EXCLUDE USING gist)
-- ------------------------------------------------------------------------------
-- Context:
--   require_open_period() (001/005) checks `where d between start_date and end_date
--   and status = 'open' and deleted_at is null`. If two active fiscal_periods rows
--   overlap (one 'closed' and another 'open'), posting on a date inside the closed
--   period would silently succeed via the overlapping open period!
--
-- PRE-APPLICATION CHECK (MANDATORY BEFORE APPLYING TO AN EXISTING DATABASE):
--   ALTER TABLE ADD CONSTRAINT will fail with SQLSTATE 23P01 if overlapping active
--   periods already exist in fiscal_periods. Run this diagnostic query first and
--   resolve/soft-delete any returned overlaps before applying this migration:
--
--   SELECT
--     a.id AS period_a_id, a.fiscal_year_id AS fy_a, a.start_date AS a_start, a.end_date AS a_end, a.status AS a_status,
--     b.id AS period_b_id, b.fiscal_year_id AS fy_b, b.start_date AS b_start, b.end_date AS b_end, b.status AS b_status
--   FROM public.fiscal_periods a
--   JOIN public.fiscal_periods b
--     ON a.id < b.id
--    AND a.deleted_at IS NULL
--    AND b.deleted_at IS NULL
--    AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
--   ORDER BY a.start_date, b.start_date;
-- ------------------------------------------------------------------------------
create extension if not exists btree_gist;

alter table public.fiscal_periods
  drop constraint if exists excl_fiscal_periods_no_overlap;

alter table public.fiscal_periods
  add constraint excl_fiscal_periods_no_overlap
  exclude using gist (
    daterange(start_date, end_date, '[]') with &&
  )
  where (deleted_at is null);
