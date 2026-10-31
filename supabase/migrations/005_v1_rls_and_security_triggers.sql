-- =====================================================================
-- 005_v1_rls_and_security_triggers.sql
-- 1. Upgrade Ledger Invariant Check Functions to SECURITY DEFINER
--    (Guarantees balance check, open period check, and parent immutability
--     cannot be blinded or bypassed by user-level RLS policies)
-- 2. Optimize helper functions has_perm() and user_has_branch()
-- 3. Complete Row Level Security (RLS) policies for ALL 45 v1 tables
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. UPGRADE INTEGRITY CHECK FUNCTIONS TO SECURITY DEFINER
-- ---------------------------------------------------------------------

-- A. Parent Immutability Check: blocks edits/deletes to posted or reversed records
create or replace function block_posted_changes() returns trigger language plpgsql
security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'posted records cannot be deleted; create a reversal';
    end if;
    return old;
  end if;
  if old.status in ('posted','reversed') then
    if not (old.status = 'posted' and new.status = 'reversed') then
      raise exception 'posted records are immutable; create a reversal instead';
    end if;
  end if;
  return new;
end $$;

-- B. Children Immutability Check: blocks adding, editing, or deleting lines of posted record
create or replace function block_posted_children() returns trigger language plpgsql
security definer set search_path = public as $$
declare
  v jsonb;
  pid uuid;
  pstatus text;
begin
  if tg_op = 'DELETE' then v := to_jsonb(old); else v := to_jsonb(new); end if;
  pid := (v ->> tg_argv[1])::uuid;
  execute format('select status from %I where id = $1', tg_argv[0]) into pstatus using pid;
  if pstatus in ('posted','reversed') then
    raise exception 'cannot change lines of a posted record';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- C. Open Period Check: prevents posting into closed or non-existent periods
create or replace function require_open_period() returns trigger language plpgsql
security definer set search_path = public as $$
declare
  d date := (to_jsonb(new) ->> tg_argv[0])::date;
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted') then
    if not exists (
      select 1 from fiscal_periods
      where d between start_date and end_date
        and status = 'open'
        and deleted_at is null
    ) then
      raise exception 'no open fiscal period for date %', d;
    end if;
  end if;
  return new;
end $$;

-- D. Balanced Journal Entry Check: requires debit = credit and at least 2 lines
create or replace function check_entry_balanced() returns trigger language plpgsql
security definer set search_path = public as $$
declare
  d numeric;
  c numeric;
  n int;
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted') then
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into d, c, n
      from journal_lines
     where entry_id = new.id
       and deleted_at is null;

    if n < 2 or d <> c then
      raise exception 'journal entry % not balanced (debit %, credit %, lines %)', new.entry_no, d, c, n;
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 2. HELPER FUNCTIONS: doc_module, has_perm, user_has_branch
-- ---------------------------------------------------------------------

create or replace function doc_module(doc_type text) returns text
language sql immutable as $$
  select case
    when doc_type in ('quotation','sales_order','sales_invoice','sales_return') then 'sales'
    when doc_type in ('purchase_order','purchase_invoice','purchase_return') then 'purchases'
    else 'inventory'
  end;
$$;

create or replace function has_perm(m text, a text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from profiles p
    join role_permissions rp on rp.role_id = p.role_id
    where p.id = auth.uid()
      and p.is_active
      and rp.module = m
      and rp.action = a
      and rp.deleted_at is null
  );
$$;

create or replace function user_has_branch(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select b is null
      or is_admin()
      or exists (
        select 1 from user_branches ub
        where ub.user_id = auth.uid()
          and ub.branch_id = b
          and ub.deleted_at is null
      );
$$;

grant execute on function doc_module(text) to authenticated;
grant execute on function has_perm(text, text) to authenticated;
grant execute on function user_has_branch(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. COMPLETE RLS POLICIES FOR ALL V1 TABLES
-- ---------------------------------------------------------------------

-- =====================================================================
-- A. General Ledger & Accounting
-- =====================================================================

-- accounts
drop policy if exists accounts_select on accounts;
drop policy if exists accounts_insert on accounts;
drop policy if exists accounts_update on accounts;

create policy accounts_select on accounts for select using (
  has_perm('accounting', 'view') or has_perm('sales', 'view') or has_perm('purchases', 'view') or has_perm('treasury', 'view') or is_admin()
);
create policy accounts_insert on accounts for insert with check (
  has_perm('accounting', 'create') or is_admin()
);
create policy accounts_update on accounts for update using (
  has_perm('accounting', 'edit') or is_admin()
);

-- cost_centers
drop policy if exists cost_centers_select on cost_centers;
drop policy if exists cost_centers_insert on cost_centers;
drop policy if exists cost_centers_update on cost_centers;

create policy cost_centers_select on cost_centers for select using (auth.uid() is not null);
create policy cost_centers_insert on cost_centers for insert with check (has_perm('accounting', 'create') or is_admin());
create policy cost_centers_update on cost_centers for update using (has_perm('accounting', 'edit') or is_admin());

-- account_mappings
drop policy if exists account_mappings_select on account_mappings;
drop policy if exists account_mappings_insert on account_mappings;
drop policy if exists account_mappings_update on account_mappings;

create policy account_mappings_select on account_mappings for select using (has_perm('accounting', 'view') or is_admin());
create policy account_mappings_insert on account_mappings for insert with check (has_perm('accounting', 'edit') or is_admin());
create policy account_mappings_update on account_mappings for update using (has_perm('accounting', 'edit') or is_admin());

-- journal_entries
drop policy if exists journal_entries_select on journal_entries;
drop policy if exists journal_entries_insert on journal_entries;
drop policy if exists journal_entries_update on journal_entries;
drop policy if exists journal_entries_delete on journal_entries;

create policy journal_entries_select on journal_entries for select using (
  user_has_branch(branch_id) and (has_perm('accounting', 'view') or is_admin())
);
create policy journal_entries_insert on journal_entries for insert with check (
  user_has_branch(branch_id) and (has_perm('accounting', 'create') or is_admin())
);
create policy journal_entries_update on journal_entries for update using (
  user_has_branch(branch_id) and (has_perm('accounting', 'edit') or has_perm('accounting', 'post') or has_perm('accounting', 'reverse') or is_admin())
);
create policy journal_entries_delete on journal_entries for delete using (
  user_has_branch(branch_id) and status = 'draft' and (has_perm('accounting', 'delete') or is_admin())
);

-- journal_lines
drop policy if exists journal_lines_select on journal_lines;
drop policy if exists journal_lines_insert on journal_lines;
drop policy if exists journal_lines_update on journal_lines;
drop policy if exists journal_lines_delete on journal_lines;

create policy journal_lines_select on journal_lines for select using (
  exists (
    select 1 from journal_entries je
    where je.id = entry_id
      and user_has_branch(je.branch_id)
      and (has_perm('accounting', 'view') or is_admin())
  )
);
create policy journal_lines_insert on journal_lines for insert with check (
  exists (
    select 1 from journal_entries je
    where je.id = entry_id
      and user_has_branch(je.branch_id)
      and (has_perm('accounting', 'create') or has_perm('accounting', 'edit') or is_admin())
  )
);
create policy journal_lines_update on journal_lines for update using (
  exists (
    select 1 from journal_entries je
    where je.id = entry_id
      and user_has_branch(je.branch_id)
      and (has_perm('accounting', 'edit') or is_admin())
  )
);
create policy journal_lines_delete on journal_lines for delete using (
  exists (
    select 1 from journal_entries je
    where je.id = entry_id
      and user_has_branch(je.branch_id)
      and (has_perm('accounting', 'edit') or is_admin())
  )
);

-- =====================================================================
-- B. Parties, Pricing & Tax
-- =====================================================================

-- parties
drop policy if exists parties_select on parties;
drop policy if exists parties_insert on parties;
drop policy if exists parties_update on parties;

create policy parties_select on parties for select using (
  has_perm('parties', 'view') or has_perm('sales', 'view') or has_perm('purchases', 'view') or is_admin()
);
create policy parties_insert on parties for insert with check (
  has_perm('parties', 'create') or is_admin()
);
create policy parties_update on parties for update using (
  has_perm('parties', 'edit') or is_admin()
);

-- tax_codes
drop policy if exists tax_codes_select on tax_codes;
create policy tax_codes_select on tax_codes for select using (auth.uid() is not null);

-- price_lists
drop policy if exists price_lists_select on price_lists;
drop policy if exists price_lists_insert on price_lists;
drop policy if exists price_lists_update on price_lists;
drop policy if exists price_lists_delete on price_lists;

create policy price_lists_select on price_lists for select using (
  has_perm('sales', 'view') or has_perm('purchases', 'view') or is_admin()
);
create policy price_lists_insert on price_lists for insert with check (
  has_perm('sales', 'edit') or is_admin()
);
create policy price_lists_update on price_lists for update using (
  has_perm('sales', 'edit') or is_admin()
);
create policy price_lists_delete on price_lists for delete using (
  has_perm('sales', 'edit') or is_admin()
);

-- price_list_items
drop policy if exists price_list_items_select on price_list_items;
drop policy if exists price_list_items_insert on price_list_items;
drop policy if exists price_list_items_update on price_list_items;
drop policy if exists price_list_items_delete on price_list_items;

create policy price_list_items_select on price_list_items for select using (
  has_perm('sales', 'view') or has_perm('purchases', 'view') or is_admin()
);
create policy price_list_items_insert on price_list_items for insert with check (
  has_perm('sales', 'edit') or is_admin()
);
create policy price_list_items_update on price_list_items for update using (
  has_perm('sales', 'edit') or is_admin()
);
create policy price_list_items_delete on price_list_items for delete using (
  has_perm('sales', 'edit') or is_admin()
);

-- =====================================================================
-- C. Inventory, Units & Warehouses
-- =====================================================================

-- units
drop policy if exists units_select on units;
create policy units_select on units for select using (auth.uid() is not null);

-- item_categories
drop policy if exists item_categories_select on item_categories;
drop policy if exists item_categories_insert on item_categories;
drop policy if exists item_categories_update on item_categories;

create policy item_categories_select on item_categories for select using (auth.uid() is not null);
create policy item_categories_insert on item_categories for insert with check (has_perm('inventory', 'create') or is_admin());
create policy item_categories_update on item_categories for update using (has_perm('inventory', 'edit') or is_admin());

-- items
drop policy if exists items_select on items;
drop policy if exists items_insert on items;
drop policy if exists items_update on items;

create policy items_select on items for select using (auth.uid() is not null);
create policy items_insert on items for insert with check (has_perm('inventory', 'create') or is_admin());
create policy items_update on items for update using (has_perm('inventory', 'edit') or is_admin());

-- item_units
drop policy if exists item_units_select on item_units;
drop policy if exists item_units_insert on item_units;
drop policy if exists item_units_update on item_units;
drop policy if exists item_units_delete on item_units;

create policy item_units_select on item_units for select using (auth.uid() is not null);
create policy item_units_insert on item_units for insert with check (has_perm('inventory', 'edit') or is_admin());
create policy item_units_update on item_units for update using (has_perm('inventory', 'edit') or is_admin());
create policy item_units_delete on item_units for delete using (has_perm('inventory', 'edit') or is_admin());

-- item_barcodes
drop policy if exists item_barcodes_select on item_barcodes;
drop policy if exists item_barcodes_insert on item_barcodes;
drop policy if exists item_barcodes_update on item_barcodes;
drop policy if exists item_barcodes_delete on item_barcodes;

create policy item_barcodes_select on item_barcodes for select using (auth.uid() is not null);
create policy item_barcodes_insert on item_barcodes for insert with check (has_perm('inventory', 'edit') or is_admin());
create policy item_barcodes_update on item_barcodes for update using (has_perm('inventory', 'edit') or is_admin());
create policy item_barcodes_delete on item_barcodes for delete using (has_perm('inventory', 'edit') or is_admin());

-- warehouses
drop policy if exists warehouses_select on warehouses;
drop policy if exists warehouses_insert on warehouses;
drop policy if exists warehouses_update on warehouses;

create policy warehouses_select on warehouses for select using (user_has_branch(branch_id));
create policy warehouses_insert on warehouses for insert with check (user_has_branch(branch_id) and (has_perm('inventory', 'edit') or is_admin()));
create policy warehouses_update on warehouses for update using (user_has_branch(branch_id) and (has_perm('inventory', 'edit') or is_admin()));

-- stock_movements
drop policy if exists stock_movements_select on stock_movements;
drop policy if exists stock_movements_insert on stock_movements;
drop policy if exists stock_movements_update on stock_movements;

create policy stock_movements_select on stock_movements for select using (
  exists (select 1 from warehouses w where w.id = warehouse_id and user_has_branch(w.branch_id))
);
create policy stock_movements_insert on stock_movements for insert with check (
  exists (select 1 from warehouses w where w.id = warehouse_id and user_has_branch(w.branch_id))
  and (has_perm('inventory', 'create') or has_perm('sales', 'post') or has_perm('purchases', 'post') or is_admin())
);
create policy stock_movements_update on stock_movements for update using (is_admin());

-- =====================================================================
-- D. Documents (Sales & Purchases)
-- =====================================================================

-- documents
drop policy if exists documents_select on documents;
drop policy if exists documents_insert on documents;
drop policy if exists documents_update on documents;
drop policy if exists documents_delete on documents;

create policy documents_select on documents for select using (
  user_has_branch(branch_id) and (has_perm(doc_module(doc_type), 'view') or is_admin())
);
create policy documents_insert on documents for insert with check (
  user_has_branch(branch_id) and (has_perm(doc_module(doc_type), 'create') or is_admin())
);
create policy documents_update on documents for update using (
  user_has_branch(branch_id) and (has_perm(doc_module(doc_type), 'edit') or has_perm(doc_module(doc_type), 'post') or has_perm(doc_module(doc_type), 'reverse') or is_admin())
);
create policy documents_delete on documents for delete using (
  user_has_branch(branch_id) and status = 'draft' and (has_perm(doc_module(doc_type), 'delete') or is_admin())
);

-- document_lines
drop policy if exists document_lines_select on document_lines;
drop policy if exists document_lines_insert on document_lines;
drop policy if exists document_lines_update on document_lines;
drop policy if exists document_lines_delete on document_lines;

create policy document_lines_select on document_lines for select using (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'view') or is_admin())
  )
);
create policy document_lines_insert on document_lines for insert with check (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'create') or has_perm(doc_module(d.doc_type), 'edit') or is_admin())
  )
);
create policy document_lines_update on document_lines for update using (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'edit') or is_admin())
  )
);
create policy document_lines_delete on document_lines for delete using (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'edit') or is_admin())
  )
);

-- document_payments
drop policy if exists document_payments_select on document_payments;
drop policy if exists document_payments_insert on document_payments;
drop policy if exists document_payments_update on document_payments;
drop policy if exists document_payments_delete on document_payments;

create policy document_payments_select on document_payments for select using (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'view') or is_admin())
  )
);
create policy document_payments_insert on document_payments for insert with check (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'edit') or is_admin())
  )
);
create policy document_payments_update on document_payments for update using (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'edit') or is_admin())
  )
);
create policy document_payments_delete on document_payments for delete using (
  exists (
    select 1 from documents d
    where d.id = document_id
      and user_has_branch(d.branch_id)
      and (has_perm(doc_module(d.doc_type), 'edit') or is_admin())
  )
);

-- =====================================================================
-- E. Treasury, Payments, Cheques & Bank Reconciliations
-- =====================================================================

-- treasury_accounts
drop policy if exists treasury_accounts_select on treasury_accounts;
drop policy if exists treasury_accounts_insert on treasury_accounts;
drop policy if exists treasury_accounts_update on treasury_accounts;

create policy treasury_accounts_select on treasury_accounts for select using (
  user_has_branch(branch_id) and (has_perm('treasury', 'view') or has_perm('sales', 'view') or has_perm('accounting', 'view') or is_admin())
);
create policy treasury_accounts_insert on treasury_accounts for insert with check (
  user_has_branch(branch_id) and (has_perm('treasury', 'edit') or is_admin())
);
create policy treasury_accounts_update on treasury_accounts for update using (
  user_has_branch(branch_id) and (has_perm('treasury', 'edit') or is_admin())
);

-- payments
drop policy if exists payments_select on payments;
drop policy if exists payments_insert on payments;
drop policy if exists payments_update on payments;
drop policy if exists payments_delete on payments;

create policy payments_select on payments for select using (
  user_has_branch(branch_id) and (has_perm('treasury', 'view') or is_admin())
);
create policy payments_insert on payments for insert with check (
  user_has_branch(branch_id) and (has_perm('treasury', 'create') or is_admin())
);
create policy payments_update on payments for update using (
  user_has_branch(branch_id) and (has_perm('treasury', 'edit') or has_perm('treasury', 'post') or has_perm('treasury', 'reverse') or is_admin())
);
create policy payments_delete on payments for delete using (
  user_has_branch(branch_id) and status = 'draft' and (has_perm('treasury', 'delete') or is_admin())
);

-- payment_allocations
drop policy if exists payment_allocations_select on payment_allocations;
drop policy if exists payment_allocations_insert on payment_allocations;
drop policy if exists payment_allocations_update on payment_allocations;
drop policy if exists payment_allocations_delete on payment_allocations;

create policy payment_allocations_select on payment_allocations for select using (
  exists (
    select 1 from payments p
    where p.id = payment_id
      and user_has_branch(p.branch_id)
      and (has_perm('treasury', 'view') or is_admin())
  )
);
create policy payment_allocations_insert on payment_allocations for insert with check (
  exists (
    select 1 from payments p
    where p.id = payment_id
      and user_has_branch(p.branch_id)
      and (has_perm('treasury', 'create') or has_perm('treasury', 'edit') or is_admin())
  )
);
create policy payment_allocations_update on payment_allocations for update using (
  exists (
    select 1 from payments p
    where p.id = payment_id
      and user_has_branch(p.branch_id)
      and (has_perm('treasury', 'edit') or is_admin())
  )
);
create policy payment_allocations_delete on payment_allocations for delete using (
  exists (
    select 1 from payments p
    where p.id = payment_id
      and user_has_branch(p.branch_id)
      and (has_perm('treasury', 'edit') or is_admin())
  )
);

-- cheques
drop policy if exists cheques_select on cheques;
drop policy if exists cheques_insert on cheques;
drop policy if exists cheques_update on cheques;

create policy cheques_select on cheques for select using (has_perm('treasury', 'view') or is_admin());
create policy cheques_insert on cheques for insert with check (has_perm('treasury', 'create') or is_admin());
create policy cheques_update on cheques for update using (has_perm('treasury', 'edit') or is_admin());

-- bank_reconciliations
drop policy if exists bank_reconciliations_select on bank_reconciliations;
drop policy if exists bank_reconciliations_insert on bank_reconciliations;
drop policy if exists bank_reconciliations_update on bank_reconciliations;

create policy bank_reconciliations_select on bank_reconciliations for select using (has_perm('treasury', 'view') or is_admin());
create policy bank_reconciliations_insert on bank_reconciliations for insert with check (has_perm('treasury', 'edit') or is_admin());
create policy bank_reconciliations_update on bank_reconciliations for update using (has_perm('treasury', 'edit') or is_admin());

-- reconciliation_items
drop policy if exists reconciliation_items_select on reconciliation_items;
drop policy if exists reconciliation_items_insert on reconciliation_items;
drop policy if exists reconciliation_items_update on reconciliation_items;
drop policy if exists reconciliation_items_delete on reconciliation_items;

create policy reconciliation_items_select on reconciliation_items for select using (has_perm('treasury', 'view') or is_admin());
create policy reconciliation_items_insert on reconciliation_items for insert with check (has_perm('treasury', 'edit') or is_admin());
create policy reconciliation_items_update on reconciliation_items for update using (has_perm('treasury', 'edit') or is_admin());
create policy reconciliation_items_delete on reconciliation_items for delete using (has_perm('treasury', 'edit') or is_admin());

-- =====================================================================
-- F. Installments
-- =====================================================================

-- installment_plans
drop policy if exists installment_plans_select on installment_plans;
drop policy if exists installment_plans_insert on installment_plans;
drop policy if exists installment_plans_update on installment_plans;

create policy installment_plans_select on installment_plans for select using (has_perm('sales', 'view') or has_perm('treasury', 'view') or is_admin());
create policy installment_plans_insert on installment_plans for insert with check (has_perm('sales', 'create') or has_perm('sales', 'edit') or is_admin());
create policy installment_plans_update on installment_plans for update using (has_perm('sales', 'edit') or is_admin());

-- installments
drop policy if exists installments_select on installments;
drop policy if exists installments_insert on installments;
drop policy if exists installments_update on installments;
drop policy if exists installments_delete on installments;

create policy installments_select on installments for select using (has_perm('sales', 'view') or has_perm('treasury', 'view') or is_admin());
create policy installments_insert on installments for insert with check (has_perm('sales', 'edit') or is_admin());
create policy installments_update on installments for update using (has_perm('sales', 'edit') or has_perm('treasury', 'edit') or is_admin());
create policy installments_delete on installments for delete using (has_perm('sales', 'edit') or is_admin());

-- =====================================================================
-- G. Settings, Devices, Fiscal Periods & Currencies
-- =====================================================================

-- devices
drop policy if exists devices_select on devices;
drop policy if exists devices_insert on devices;
drop policy if exists devices_update on devices;
drop policy if exists devices_delete on devices;

create policy devices_select on devices for select using (user_id = auth.uid() or is_admin());
create policy devices_insert on devices for insert with check (user_id = auth.uid() or is_admin());
create policy devices_update on devices for update using (user_id = auth.uid() or is_admin());
create policy devices_delete on devices for delete using (user_id = auth.uid() or is_admin());

-- company_settings
drop policy if exists company_settings_select on company_settings;
drop policy if exists company_settings_insert on company_settings;
drop policy if exists company_settings_update on company_settings;

create policy company_settings_select on company_settings for select using (auth.uid() is not null);
create policy company_settings_insert on company_settings for insert with check (is_admin() or has_perm('settings', 'edit'));
create policy company_settings_update on company_settings for update using (is_admin() or has_perm('settings', 'edit'));

-- settings_kv
drop policy if exists settings_kv_select on settings_kv;
drop policy if exists settings_kv_insert on settings_kv;
drop policy if exists settings_kv_update on settings_kv;
drop policy if exists settings_kv_delete on settings_kv;

create policy settings_kv_select on settings_kv for select using (auth.uid() is not null);
create policy settings_kv_insert on settings_kv for insert with check (is_admin() or has_perm('settings', 'edit'));
create policy settings_kv_update on settings_kv for update using (is_admin() or has_perm('settings', 'edit'));
create policy settings_kv_delete on settings_kv for delete using (is_admin() or has_perm('settings', 'edit'));

-- currencies
drop policy if exists currencies_select on currencies;
create policy currencies_select on currencies for select using (auth.uid() is not null);

-- exchange_rates
drop policy if exists exchange_rates_select on exchange_rates;
drop policy if exists exchange_rates_insert on exchange_rates;
drop policy if exists exchange_rates_update on exchange_rates;

create policy exchange_rates_select on exchange_rates for select using (auth.uid() is not null);
create policy exchange_rates_insert on exchange_rates for insert with check (has_perm('accounting', 'edit') or is_admin());
create policy exchange_rates_update on exchange_rates for update using (has_perm('accounting', 'edit') or is_admin());

-- fiscal_years
drop policy if exists fiscal_years_select on fiscal_years;
drop policy if exists fiscal_years_insert on fiscal_years;
drop policy if exists fiscal_years_update on fiscal_years;

create policy fiscal_years_select on fiscal_years for select using (auth.uid() is not null);
create policy fiscal_years_insert on fiscal_years for insert with check (has_perm('accounting', 'edit') or is_admin());
create policy fiscal_years_update on fiscal_years for update using (has_perm('accounting', 'edit') or is_admin());

-- fiscal_periods
drop policy if exists fiscal_periods_select on fiscal_periods;
drop policy if exists fiscal_periods_insert on fiscal_periods;
drop policy if exists fiscal_periods_update on fiscal_periods;

create policy fiscal_periods_select on fiscal_periods for select using (auth.uid() is not null);
create policy fiscal_periods_insert on fiscal_periods for insert with check (has_perm('accounting', 'edit') or is_admin());
create policy fiscal_periods_update on fiscal_periods for update using (has_perm('accounting', 'edit') or is_admin());

-- number_series
drop policy if exists number_series_select on number_series;
drop policy if exists number_series_insert on number_series;
drop policy if exists number_series_update on number_series;

create policy number_series_select on number_series for select using (auth.uid() is not null);
create policy number_series_insert on number_series for insert with check (is_admin() or has_perm('settings', 'edit'));
create policy number_series_update on number_series for update using (is_admin() or has_perm('settings', 'edit'));

-- print_templates
drop policy if exists print_templates_select on print_templates;
drop policy if exists print_templates_insert on print_templates;
drop policy if exists print_templates_update on print_templates;

create policy print_templates_select on print_templates for select using (auth.uid() is not null);
create policy print_templates_insert on print_templates for insert with check (is_admin() or has_perm('settings', 'edit'));
create policy print_templates_update on print_templates for update using (is_admin() or has_perm('settings', 'edit'));

-- =====================================================================
-- H. Attachments, Notifications, Conflicts & Audit Log
-- =====================================================================

-- attachments
drop policy if exists attachments_select on attachments;
drop policy if exists attachments_insert on attachments;
drop policy if exists attachments_update on attachments;
drop policy if exists attachments_delete on attachments;

create policy attachments_select on attachments for select using (auth.uid() is not null);
create policy attachments_insert on attachments for insert with check (created_by = auth.uid() or is_admin());
create policy attachments_update on attachments for update using (created_by = auth.uid() or is_admin());
create policy attachments_delete on attachments for delete using (created_by = auth.uid() or is_admin());

-- notifications
drop policy if exists notifications_select on notifications;
drop policy if exists notifications_update on notifications;

create policy notifications_select on notifications for select using (user_id = auth.uid() or is_admin());
create policy notifications_update on notifications for update using (user_id = auth.uid() or is_admin());

-- sync_conflicts
drop policy if exists sync_conflicts_select on sync_conflicts;
drop policy if exists sync_conflicts_insert on sync_conflicts;
drop policy if exists sync_conflicts_update on sync_conflicts;

create policy sync_conflicts_select on sync_conflicts for select using (auth.uid() is not null);
create policy sync_conflicts_insert on sync_conflicts for insert with check (is_admin() or has_perm('settings', 'edit'));
create policy sync_conflicts_update on sync_conflicts for update using (is_admin() or has_perm('settings', 'edit'));

-- audit_log: READ ONLY under RLS for admins or users with audit view perm
-- No INSERT/UPDATE/DELETE policies: writes occur exclusively via audit_row() trigger
drop policy if exists audit_log_select on audit_log;
create policy audit_log_select on audit_log for select using (is_admin() or has_perm('audit', 'view'));

