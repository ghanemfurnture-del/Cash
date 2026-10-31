-- =====================================================================
-- 004_v1_grants_and_admin_helper.sql
-- 1. Helper function is_admin() (seed dependency on r.name = 'Admin')
-- 2. Optimize minimal RLS policies to use is_admin() (zero recursion)
-- 3. REVOKE default public/anon access after "Automatically expose tables"
-- 4. ALTER DEFAULT PRIVILEGES: Engine-level deny-by-default for new tables
-- 5. GRANT explicit access to authenticated ONLY for v1 modules
-- 6. ALTER VIEW SET (security_invoker = true) for all public views
-- 7. Role Timeouts: service_role bounded to 60s (Postgres 17 transaction_timeout)
-- =====================================================================

/*
=====================================================================
VERIFICATION QUERIES (Run after applying 004 in Supabase SQL Editor):
=====================================================================

-- 1. Verify is_admin() function definition and security definer status:
SELECT proname, prosecdef, prosrc 
FROM pg_proc 
WHERE proname = 'is_admin';

-- 2. Verify NO table privileges remain for anon or PUBLIC in public schema (Expected: 0 rows):
SELECT table_name, privilege_type, grantee
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'PUBLIC');

-- 3. Verify authenticated only has v1 tables and NO access to sync_ops, employees, or future modules:
SELECT table_name, array_agg(privilege_type ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'authenticated'
GROUP BY table_name
ORDER BY table_name;

-- 3b. Confirm denied tables return 0 grants for authenticated (Expected: 0 rows):
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'authenticated'
  AND table_name IN ('sync_ops', 'employees', 'pos_shifts', 'fixed_assets', 'budgets', 'eta_submissions');

-- 3c. Confirm audit_log has ONLY SELECT privilege for authenticated (Expected: exactly 1 row with 'SELECT'):
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'authenticated' AND table_name = 'audit_log';

-- 4. Verify security_invoker = true on all 12 public v_* views:
SELECT c.relname AS view_name, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname LIKE 'v_%'
ORDER BY c.relname;

-- 5. Verify default privileges revoked for future tables/sequences:
SELECT defaclrole::regrole AS owner_role, nspname AS schema, defaclobjtype AS object_type, defaclacl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';

-- 6. Verify role timeouts on service_role (Postgres 17: transaction_timeout = '60s'):
SELECT rolname, rolconfig
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated', 'authenticator', 'service_role');
=====================================================================
*/

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
-- 4. ALTER DEFAULT PRIVILEGES (Engine-level Deny-by-Default)
-- Ensures any table, sequence or routine created in the future in public
-- does not inherit automatic grants to anon, authenticated or public.
-- ---------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated, public;
alter default privileges in schema public revoke all on routines from anon, authenticated, public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    execute 'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, public';
    execute 'alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, public';
    execute 'alter default privileges for role postgres in schema public revoke all on routines from anon, authenticated, public';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. GRANT access to authenticated ONLY for v1 core modules
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
-- 6. SET security_invoker = true ON ALL PUBLIC VIEWS
-- Ensures views respect caller RLS policies instead of view definer.
-- ---------------------------------------------------------------------
alter view v_stock_balance set (security_invoker = true);
alter view v_trial_balance set (security_invoker = true);
alter view v_party_balance set (security_invoker = true);
alter view v_document_balance set (security_invoker = true);
alter view v_low_stock set (security_invoker = true);
alter view v_lot_balance set (security_invoker = true);
alter view v_installment_status set (security_invoker = true);
alter view v_pos_shift_summary set (security_invoker = true);
alter view v_pos_shift_payments set (security_invoker = true);
alter view v_employee_loan_balance set (security_invoker = true);
alter view v_budget_vs_actual set (security_invoker = true);
alter view v_eta_work_queue set (security_invoker = true);

-- ---------------------------------------------------------------------
-- 7. CRITICAL DENIALS (Unreachable by clients):
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
-- 8. Role Timeouts (service_role only for backend/Edge Functions)
-- anon and authenticated keep their Supabase default timeouts (anon=3s, authenticated=8s).
-- service_role (Postgres 17.11) is configured with a strict 60s hard ceiling:
-- ---------------------------------------------------------------------
alter role service_role set statement_timeout = '60s';
alter role service_role set idle_in_transaction_session_timeout = '15s';
alter role service_role set transaction_timeout = '60s';

-- Reload PostgREST configuration
notify pgrst, 'reload config';
