-- =====================================================================
-- 004_v1_grants_and_admin_helper.sql
-- 1. Helper function is_admin() (seed dependency on r.name = 'Admin')
-- 2. Optimize minimal RLS policies to use is_admin() (zero recursion)
-- 3. REVOKE default public/anon access after "Automatically expose tables"
-- 4. GRANT explicit access to authenticated ONLY for v1 modules
-- 5. Set transaction and statement timeouts for role security
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Admin helper function
-- SEED DEPENDENCY: This function strictly relies on the role with name = 'Admin'.
-- The seed data migration must insert this role with exact name 'Admin'.
-- ---------------------------------------------------------------------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p join roles r on r.id = p.role_id
    where p.id = auth.uid()
      and r.name = 'Admin'
      and p.is_active
      and p.deleted_at is null
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Optimize minimal auth policies using is_admin() to prevent recursion
-- ---------------------------------------------------------------------
drop policy if exists profiles_select_own on profiles;
drop policy if exists profiles_update_own on profiles;
drop policy if exists user_branches_select_own on user_branches;

create policy profiles_select_own on profiles
  for select using (id = auth.uid() or is_admin());

create policy profiles_update_own on profiles
  for update using (id = auth.uid() or is_admin());

create policy user_branches_select_own on user_branches
  for select using (user_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------------
-- 3. REVOKE ALL permissions from anon and PUBLIC across all tables/sequences
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, public;
revoke all on all sequences in schema public from anon, public;
revoke all on all routines in schema public from anon, public;

-- Revoke all on all tables from authenticated first to establish clean deny-by-default
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

-- ---------------------------------------------------------------------
-- 4. GRANT access to authenticated ONLY for v1 core modules
-- (POS, HR, Fixed Assets, Budgets, and ETA are withheld until their phases)
-- ---------------------------------------------------------------------

-- A. Organization, Security & Settings (v1)
grant select, insert, update on profiles to authenticated;
grant select on roles to authenticated;
grant select on role_permissions to authenticated;
grant select, insert, update on branches to authenticated;
grant select, insert, update, delete on user_branches to authenticated;
grant select, insert, update, delete on devices to authenticated;
grant select, insert, update on company_settings to authenticated;
grant select, insert, update, delete on settings_kv to authenticated;
grant select on currencies to authenticated;
grant select, insert, update on exchange_rates to authenticated;
grant select, insert, update on fiscal_years to authenticated;
grant select, insert, update on fiscal_periods to authenticated;
grant select, insert, update on number_series to authenticated;
grant select, insert, update on print_templates to authenticated;

-- B. Core Accounting & GL (v1)
grant select, insert, update on accounts to authenticated;
grant select, insert, update on cost_centers to authenticated;
grant select, insert, update on account_mappings to authenticated;
grant select, insert, update on journal_entries to authenticated;
grant select, insert, update, delete on journal_lines to authenticated;

-- C. Parties, Pricing & Tax (v1)
grant select, insert, update on parties to authenticated;
grant select on tax_codes to authenticated;
grant select, insert, update, delete on price_lists to authenticated;
grant select, insert, update, delete on price_list_items to authenticated;

-- D. Inventory, Units & Warehouses (v1)
grant select on units to authenticated;
grant select, insert, update on item_categories to authenticated;
grant select, insert, update on items to authenticated;
grant select, insert, update, delete on item_units to authenticated;
grant select, insert, update, delete on item_barcodes to authenticated;
grant select, insert, update on warehouses to authenticated;
grant select, insert, update on stock_movements to authenticated;

-- E. Sales, Purchases & Documents (v1)
grant select, insert, update on documents to authenticated;
grant select, insert, update, delete on document_lines to authenticated;
grant select, insert, update, delete on document_payments to authenticated;

-- F. Treasury, Payments, Cheques & Reconciliations (v1)
grant select, insert, update on treasury_accounts to authenticated;
grant select, insert, update on payments to authenticated;
grant select, insert, update, delete on payment_allocations to authenticated;
grant select, insert, update on cheques to authenticated;
grant select, insert, update on bank_reconciliations to authenticated;
grant select, insert, update, delete on reconciliation_items to authenticated;

-- G. Installments (v1)
grant select, insert, update on installment_plans to authenticated;
grant select, insert, update, delete on installments to authenticated;

-- H. Attachments, Notifications & Sync Conflicts (v1)
grant select, insert, update, delete on attachments to authenticated;
grant select, update on notifications to authenticated;
grant select, insert, update on sync_conflicts to authenticated;

-- I. Sequence access for client sync cursors
grant usage, select on sequence sync_seq to authenticated;

-- J. Audit Log: READ ONLY for authenticated (under RLS). NO DIRECT CLIENT WRITES!
-- All writes are handled exclusively by the server-side audit_row() trigger.
grant select on audit_log to authenticated;

-- K. Derived Views (v1 reporting)
grant select on v_stock_balance to authenticated;
grant select on v_trial_balance to authenticated;
grant select on v_party_balance to authenticated;
grant select on v_document_balance to authenticated;
grant select on v_low_stock to authenticated;
grant select on v_lot_balance to authenticated;
grant select on v_installment_status to authenticated;

-- ---------------------------------------------------------------------
-- 5. CRITICAL DENIALS (Unreachable by clients):
-- - sync_ops: NO GRANTS to authenticated or anon. Edge Function (service_role) only!
-- - POS: pos_terminals, pos_shifts, pos_cash_movements (Phase 8)
-- - HR & Payroll: departments, employees, pay_components, employee_components,
--                 employee_loans, payroll_tax_brackets, payroll_runs, payslips,
--                 payslip_lines (Phase 9)
-- - Fixed Assets: asset_categories, fixed_assets, depreciation_runs, depreciation_lines (Phase 10)
-- - Budgets: budgets, budget_lines (Phase 7)
-- - ETA: eta_settings, eta_item_codes, eta_submissions (Phase 11)
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 6. Role Timeouts (statement and transaction bounds)
-- ---------------------------------------------------------------------
do $$
begin
  -- Apply statement timeouts
  execute 'alter role authenticated set statement_timeout = ''60s''';
  execute 'alter role authenticated set idle_in_transaction_session_timeout = ''30s''';
  execute 'alter role anon set statement_timeout = ''10s''';
  execute 'alter role anon set idle_in_transaction_session_timeout = ''10s''';

  -- Check if Postgres 17+ transaction_timeout is supported
  if current_setting('server_version_num')::int >= 170000 then
    execute 'alter role authenticated set transaction_timeout = ''60s''';
    execute 'alter role anon set transaction_timeout = ''10s''';
  end if;
end $$;

