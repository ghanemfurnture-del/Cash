-- =====================================================================
-- 002_extended_schema.sql  |  Run AFTER 001_core_schema.sql
-- Adds: multi-branch, price lists, number series, print templates, settings,
--       attachments, notifications, POS (shifts, split payments), lots/expiry/serials,
--       installments, ETA e-invoice/e-receipt queue, HR + payroll + loans,
--       fixed assets + depreciation, budgets, work-queue/derived views.
-- Same rules as 001: client UUIDs, numeric money, posted = immutable, server_seq sync.
-- NOT YET EXECUTED against a live database: run on Supabase, fix errors.
-- SECRETS NEVER GO IN THIS DATABASE: ETA client secret -> Supabase secrets;
-- ETA signing certificate / token PIN -> only inside the local signing agent.
-- =====================================================================

create table _row_base (
  id          uuid        not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  device_id   uuid,
  version     int         not null default 1,
  server_seq  bigint      not null default 0,
  deleted_at  timestamptz
);

-- ---------- Multi-branch ----------
create table branches (like _row_base including defaults,
  code text not null unique, name_ar text not null, name_en text,
  address text, phone text,
  eta_branch_code text,                       -- issuer branch id as registered with ETA
  is_main boolean not null default false,
  is_active boolean not null default true, primary key (id));

create table user_branches (like _row_base including defaults,
  user_id   uuid not null references profiles(id),
  branch_id uuid not null references branches(id),
  unique (user_id, branch_id), primary key (id));

alter table devices           add column branch_id uuid references branches(id);
alter table warehouses        add column branch_id uuid references branches(id);
alter table treasury_accounts add column branch_id uuid references branches(id);
alter table journal_entries   add column branch_id uuid references branches(id);
alter table documents         add column branch_id uuid references branches(id);
alter table payments          add column branch_id uuid references branches(id);
create index on journal_entries (branch_id, entry_date);
create index on documents (branch_id, doc_date);
create index on payments (branch_id, voucher_date);

-- ---------- Pricing, numbering, templates, settings, files, notifications ----------
create table price_lists (like _row_base including defaults,
  name_ar text not null, currency_code char(3) not null default 'EGP',
  kind text not null default 'sales' check (kind in ('sales','purchase')),
  is_default boolean not null default false, primary key (id));

create table price_list_items (like _row_base including defaults,
  price_list_id uuid not null references price_lists(id),
  item_id uuid not null references items(id),
  unit_id uuid references units(id),
  min_qty numeric(18,4) not null default 1,
  price numeric(18,4) not null check (price >= 0),
  unique (price_list_id, item_id, unit_id, min_qty), primary key (id));

alter table parties add column price_list_id uuid references price_lists(id);

create table number_series (like _row_base including defaults,
  doc_type text not null,                      -- documents.doc_type | voucher_type | 'journal_entry'
  branch_id uuid references branches(id),
  prefix text not null default '', padding smallint not null default 6,
  reset_policy text not null default 'never' check (reset_policy in ('never','yearly','monthly')),
  unique (doc_type, branch_id), primary key (id));

create table print_templates (like _row_base including defaults,
  doc_type text not null, name text not null,
  paper text not null default 'a4' check (paper in ('a4','a5','thermal80','thermal58')),
  html text not null, is_default boolean not null default false, primary key (id));

create table settings_kv (like _row_base including defaults,
  scope text not null check (scope in ('company','branch','user')),
  scope_id uuid, key text not null, value jsonb not null,
  unique (scope, scope_id, key), primary key (id));

create table attachments (like _row_base including defaults,
  entity text not null, entity_id uuid not null,
  file_name text not null, mime_type text, size_bytes bigint,
  storage_path text,                           -- Supabase Storage path once uploaded
  local_only boolean not null default true,    -- true until the file is uploaded after sync
  primary key (id));
create index on attachments (entity, entity_id);

create table notifications (like _row_base including defaults,
  user_id uuid references profiles(id),        -- null = everyone with access
  kind text not null,                          -- low_stock, cheque_due, installment_due, lot_expiring,
                                               -- sync_conflict, eta_rejected, backup_overdue, period_open
  title text not null, body text,
  entity text, entity_id uuid, read_at timestamptz, primary key (id));
create index on notifications (user_id, read_at);

-- ---------- Lots / expiry / serials ----------
alter table items          add column tracking text not null default 'none' check (tracking in ('none','lot','serial'));
alter table stock_movements add column lot_no text, add column expiry_date date, add column serial_no text;
alter table document_lines  add column lot_no text, add column expiry_date date, add column serial_no text;
create index on stock_movements (item_id, lot_no);

-- ---------- ETA (Egyptian Tax Authority) master data ----------
alter table units     add column eta_code text;                        -- e.g. EA, KGM, as accepted by ETA
alter table tax_codes add column eta_tax_type text, add column eta_tax_subtype text;
alter table parties   add column eta_receiver_type text check (eta_receiver_type in ('B','P','F')),
                      add column country_code char(2) not null default 'EG',
                      add column governorate text, add column city text,
                      add column street text, add column building_no text;

create table eta_settings (like _row_base including defaults,
  environment text not null default 'preprod' check (environment in ('preprod','prod')),
  issuer_type text not null default 'B' check (issuer_type in ('B','P','F')),
  activity_code text,
  signing_agent_url text not null default 'http://127.0.0.1:5199',   -- local signing agent
  auto_submit boolean not null default false, primary key (id));

create table eta_item_codes (like _row_base including defaults,
  item_id uuid not null references items(id),
  code_type text not null check (code_type in ('GS1','EGS')),
  item_code text not null,
  unique (item_id, code_type), primary key (id));

-- One row per document sent to ETA (invoice / credit note / debit note / receipt)
create table eta_submissions (like _row_base including defaults,
  kind text not null check (kind in ('invoice','credit_note','debit_note','receipt')),
  document_id uuid not null references documents(id),
  internal_id text not null,                   -- our document number (new suffix if re-issued)
  eta_uuid text, long_id text, submission_id text,
  status text not null default 'queued'
    check (status in ('queued','signed','submitted','valid','invalid','rejected','cancelled','failed')),
  canonical_payload text,                      -- exact canonical string that was signed
  signed_payload jsonb,                        -- exact JSON that was submitted
  response jsonb, error_codes text[],
  retry_count int not null default 0, next_retry_at timestamptz,
  submitted_at timestamptz, validated_at timestamptz, qr_url text,
  unique (kind, internal_id), primary key (id));
create index on eta_submissions (status, next_retry_at);
create index on eta_submissions (document_id);

-- ---------- POS ----------
create table pos_terminals (like _row_base including defaults,
  branch_id uuid not null references branches(id),
  name text not null,
  warehouse_id uuid not null references warehouses(id),
  cash_account_id uuid not null references treasury_accounts(id),
  card_account_id uuid references treasury_accounts(id),
  default_price_list_id uuid references price_lists(id),
  eta_pos_serial text,
  is_active boolean not null default true, primary key (id));

create table pos_shifts (like _row_base including defaults,
  terminal_id uuid not null references pos_terminals(id),
  cashier_id  uuid not null references profiles(id),
  opened_at timestamptz not null, opening_cash numeric(18,4) not null default 0,
  closed_at timestamptz,
  expected_cash numeric(18,4), counted_cash numeric(18,4), cash_difference numeric(18,4),
  status text not null default 'open' check (status in ('open','closed')),
  journal_entry_id uuid references journal_entries(id),   -- cash over/short posting
  notes text, primary key (id));

create table pos_cash_movements (like _row_base including defaults,
  shift_id uuid not null references pos_shifts(id),
  kind text not null check (kind in ('in','out')),
  amount numeric(18,4) not null check (amount > 0), reason text not null, primary key (id));

alter table documents add column source text not null default 'back_office' check (source in ('back_office','pos'));
alter table documents add column pos_shift_id uuid references pos_shifts(id);
create index on documents (pos_shift_id);

-- Split payments taken at sale time (POS and cash sales). Back-office credit
-- settlements use payments + payment_allocations instead.
create table document_payments (like _row_base including defaults,
  document_id uuid not null references documents(id) on delete cascade,
  method text not null check (method in ('cash','card','bank_transfer','cheque','wallet','credit')),
  amount numeric(18,4) not null check (amount > 0),
  treasury_account_id uuid references treasury_accounts(id),
  reference text, primary key (id));

-- ---------- Installments ----------
create table installment_plans (like _row_base including defaults,
  document_id uuid not null unique references documents(id),
  installments_count int not null check (installments_count > 0),
  first_due_date date not null,
  interest_rate numeric(6,4) not null default 0,
  down_payment numeric(18,4) not null default 0, primary key (id));

create table installments (like _row_base including defaults,
  plan_id uuid not null references installment_plans(id) on delete cascade,
  seq int not null, due_date date not null,
  amount numeric(18,4) not null check (amount > 0),
  unique (plan_id, seq), primary key (id));

alter table payment_allocations add column installment_id uuid references installments(id);

-- ---------- HR & payroll ----------
create table departments (like _row_base including defaults,
  name_ar text not null unique, primary key (id));

create table employees (like _row_base including defaults,
  code text not null unique, name_ar text not null, name_en text,
  department_id uuid references departments(id),
  branch_id uuid references branches(id),
  profile_id uuid references profiles(id),
  job_title text, hire_date date not null, termination_date date,
  base_salary numeric(18,4) not null default 0,
  pay_method text not null default 'cash' check (pay_method in ('cash','bank_transfer')),
  treasury_account_id uuid references treasury_accounts(id),
  bank_iban text,
  national_id text, social_insurance_no text,   -- SENSITIVE: payroll roles only (RLS), consider encryption
  phone text, is_active boolean not null default true, primary key (id));

create table pay_components (like _row_base including defaults,
  code text not null unique, name_ar text not null,
  kind text not null check (kind in ('earning','deduction')),
  calc_type text not null default 'fixed' check (calc_type in ('fixed','percent_of_base','manual')),
  default_value numeric(18,4) not null default 0,
  gl_account_id uuid references accounts(id),
  is_taxable boolean not null default true, is_insured boolean not null default false,
  primary key (id));

create table employee_components (like _row_base including defaults,
  employee_id  uuid not null references employees(id),
  component_id uuid not null references pay_components(id),
  value numeric(18,4) not null,
  unique (employee_id, component_id), primary key (id));

create table employee_loans (like _row_base including defaults,
  employee_id uuid not null references employees(id),
  loan_date date not null,
  amount numeric(18,4) not null check (amount > 0),
  monthly_installment numeric(18,4) not null check (monthly_installment > 0),
  status text not null default 'active' check (status in ('active','settled','cancelled')),
  payment_id uuid references payments(id), primary key (id));

-- Tax brackets are DATA, not code: the accountant enters the current legal values.
create table payroll_tax_brackets (like _row_base including defaults,
  effective_from date not null,
  from_amount numeric(18,4) not null, to_amount numeric(18,4),
  rate numeric(6,4) not null check (rate >= 0), primary key (id));

create table payroll_runs (like _row_base including defaults,
  branch_id uuid references branches(id),
  pay_year smallint not null, pay_month smallint not null check (pay_month between 1 and 12),
  pay_date date not null,
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  posted_at timestamptz,
  journal_entry_id uuid references journal_entries(id),
  unique (branch_id, pay_year, pay_month), primary key (id));

create table payslips (like _row_base including defaults,
  run_id uuid not null references payroll_runs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  base_salary numeric(18,4) not null default 0,
  gross numeric(18,4) not null default 0,
  total_deductions numeric(18,4) not null default 0,
  net numeric(18,4) not null default 0,
  payment_id uuid references payments(id),
  unique (run_id, employee_id), primary key (id));

create table payslip_lines (like _row_base including defaults,
  payslip_id uuid not null references payslips(id) on delete cascade,
  component_id uuid references pay_components(id),
  kind text not null check (kind in ('earning','deduction')),
  amount numeric(18,4) not null check (amount >= 0),
  loan_id uuid references employee_loans(id), notes text, primary key (id));

-- ---------- Fixed assets ----------
create table asset_categories (like _row_base including defaults,
  name_ar text not null,
  method text not null default 'straight_line' check (method in ('straight_line','declining_balance')),
  life_months int not null check (life_months > 0),
  asset_account_id uuid not null references accounts(id),
  accumulated_depr_account_id uuid not null references accounts(id),
  depr_expense_account_id uuid not null references accounts(id), primary key (id));

create table fixed_assets (like _row_base including defaults,
  code text not null unique, name_ar text not null,
  category_id uuid not null references asset_categories(id),
  branch_id uuid references branches(id), cost_center_id uuid references cost_centers(id),
  purchase_date date not null, in_service_date date not null,
  cost numeric(18,4) not null check (cost >= 0),
  salvage_value numeric(18,4) not null default 0,
  status text not null default 'active' check (status in ('active','disposed','fully_depreciated')),
  disposal_date date, disposal_amount numeric(18,4),
  purchase_document_id uuid references documents(id), primary key (id));

create table depreciation_runs (like _row_base including defaults,
  run_date date not null, period_id uuid references fiscal_periods(id),
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  posted_at timestamptz, journal_entry_id uuid references journal_entries(id), primary key (id));

create table depreciation_lines (like _row_base including defaults,
  run_id uuid not null references depreciation_runs(id) on delete cascade,
  asset_id uuid not null references fixed_assets(id),
  amount numeric(18,4) not null check (amount >= 0),
  unique (run_id, asset_id), primary key (id));

-- ---------- Budgets ----------
create table budgets (like _row_base including defaults,
  fiscal_year_id uuid not null references fiscal_years(id),
  name_ar text not null, branch_id uuid references branches(id), primary key (id));

create table budget_lines (like _row_base including defaults,
  budget_id uuid not null references budgets(id) on delete cascade,
  account_id uuid not null references accounts(id),
  period_id uuid not null references fiscal_periods(id),
  amount numeric(18,4) not null,
  unique (budget_id, account_id, period_id), primary key (id));

-- ---------- Extra triggers ----------
create or replace function block_closed_shift_changes() returns trigger language plpgsql as $$
begin
  if old.status = 'closed' then raise exception 'closed shifts are immutable'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function block_closed_shift_children() returns trigger language plpgsql as $$
declare v jsonb; s text;
begin
  if tg_op = 'DELETE' then v := to_jsonb(old); else v := to_jsonb(new); end if;
  select status into s from pos_shifts where id = (v ->> 'shift_id')::uuid;
  if s = 'closed' then raise exception 'cannot change a closed shift'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function block_payslip_line_changes() returns trigger language plpgsql as $$
declare v jsonb; rs text;
begin
  if tg_op = 'DELETE' then v := to_jsonb(old); else v := to_jsonb(new); end if;
  select r.status into rs from payslips s join payroll_runs r on r.id = s.run_id
   where s.id = (v ->> 'payslip_id')::uuid;
  if rs in ('posted','reversed') then raise exception 'cannot change lines of a posted payroll run'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Once signed, the canonical and submitted payloads are evidence: never alter them.
create or replace function lock_eta_payload() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.signed_payload is not null then raise exception 'signed ETA payload cannot be deleted'; end if;
    return old;
  end if;
  if old.signed_payload is not null and
     (new.signed_payload is distinct from old.signed_payload
      or new.canonical_payload is distinct from old.canonical_payload) then
    raise exception 'signed ETA payload cannot be altered';
  end if;
  return new;
end $$;

create trigger trg_block_shift  before update or delete on pos_shifts for each row execute function block_closed_shift_changes();
create trigger trg_block_cashmv before insert or update or delete on pos_cash_movements
  for each row execute function block_closed_shift_children();
create trigger trg_block_eta    before update or delete on eta_submissions for each row execute function lock_eta_payload();

create trigger trg_block_payroll before update or delete on payroll_runs for each row execute function block_posted_changes();
create trigger trg_block_deprun  before update or delete on depreciation_runs for each row execute function block_posted_changes();
create trigger trg_block_slips   before insert or update or delete on payslips
  for each row execute function block_posted_children('payroll_runs', 'run_id');
create trigger trg_block_slipln  before insert or update or delete on payslip_lines
  for each row execute function block_payslip_line_changes();
create trigger trg_block_deprln  before insert or update or delete on depreciation_lines
  for each row execute function block_posted_children('depreciation_runs', 'run_id');
create trigger trg_block_docpay  before insert or update or delete on document_payments
  for each row execute function block_posted_children('documents', 'document_id');

create trigger trg_period_payroll before insert or update on payroll_runs      for each row execute function require_open_period('pay_date');
create trigger trg_period_deprun  before insert or update on depreciation_runs for each row execute function require_open_period('run_date');

-- Stamp + sync-cursor index for every table that does not have them yet
do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'server_seq' and c.table_name <> '_row_base'
      and not exists (select 1 from pg_trigger g
                      where g.tgrelid = ('public.' || quote_ident(c.table_name))::regclass and g.tgname = 'trg_stamp')
  loop
    execute format('create trigger trg_stamp before insert or update on %I for each row execute function stamp_row()', t);
    execute format('create index on %I (server_seq)', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['branches','user_branches','price_list_items','employees','employee_loans',
                           'payroll_runs','payslips','pos_shifts','eta_submissions','fixed_assets',
                           'depreciation_runs','installment_plans','document_payments']
  loop
    execute format('create trigger trg_audit after insert or update or delete on %I for each row execute function audit_row()', t);
  end loop;
end $$;

drop table _row_base;

-- ---------- Derived views / work queues ----------
create view v_low_stock as
select i.id as item_id, i.sku, i.name_ar, i.min_stock, coalesce(sum(m.qty_base),0) as qty
from items i
left join stock_movements m on m.item_id = i.id and m.deleted_at is null
where i.is_stocked and i.is_active and i.deleted_at is null
group by i.id
having coalesce(sum(m.qty_base),0) <= i.min_stock;

create view v_lot_balance as            -- filter expiry_date in the app (e.g. next 60 days)
select item_id, warehouse_id, lot_no, expiry_date, sum(qty_base) as qty
from stock_movements
where deleted_at is null and lot_no is not null
group by item_id, warehouse_id, lot_no, expiry_date
having sum(qty_base) > 0;

create view v_installment_status as
select i.id as installment_id, i.plan_id, i.seq, i.due_date, i.amount,
       coalesce(x.paid,0) as paid,
       case when coalesce(x.paid,0) >= i.amount then 'paid'
            when coalesce(x.paid,0) > 0 then 'partial'
            when i.due_date < current_date then 'overdue'
            else 'due' end as status
from installments i
left join (
  select a.installment_id, sum(a.amount) as paid
  from payment_allocations a join payments p on p.id = a.payment_id
  where p.status = 'posted' and a.deleted_at is null and a.installment_id is not null
  group by a.installment_id
) x on x.installment_id = i.id
where i.deleted_at is null;

create view v_pos_shift_summary as
select s.id as shift_id, s.terminal_id, s.cashier_id,
       coalesce(sum(case when d.doc_type = 'sales_invoice' then d.total end),0) as sales_total,
       coalesce(sum(case when d.doc_type = 'sales_return'  then d.total end),0) as returns_total,
       count(d.id) as docs_count
from pos_shifts s
left join documents d on d.pos_shift_id = s.id and d.status = 'posted' and d.deleted_at is null
group by s.id;

create view v_pos_shift_payments as     -- expected cash = opening + cash row + cash-in - cash-out
select d.pos_shift_id as shift_id, p.method,
       sum(case when d.doc_type = 'sales_return' then -p.amount else p.amount end) as amount
from document_payments p join documents d on d.id = p.document_id
where d.status = 'posted' and d.pos_shift_id is not null and p.deleted_at is null
group by d.pos_shift_id, p.method;

create view v_employee_loan_balance as
select l.id as loan_id, l.employee_id, l.amount,
       coalesce(sum(pl.amount),0) as repaid,
       l.amount - coalesce(sum(pl.amount),0) as remaining
from employee_loans l
left join payslip_lines pl on pl.loan_id = l.id and pl.deleted_at is null
  and exists (select 1 from payslips s join payroll_runs r on r.id = s.run_id
              where s.id = pl.payslip_id and r.status = 'posted')
where l.deleted_at is null
group by l.id;

create view v_budget_vs_actual as
select b.id as budget_id, bl.account_id, bl.period_id, bl.amount as budget,
       coalesce((
         select sum(case when a.normal_side = 'credit' then l.credit - l.debit else l.debit - l.credit end)
         from journal_lines l join journal_entries e on e.id = l.entry_id
         where l.account_id = bl.account_id and l.deleted_at is null
           and e.status in ('posted','reversed')
           and e.entry_date between p.start_date and p.end_date), 0) as actual
from budgets b
join budget_lines bl on bl.budget_id = b.id and bl.deleted_at is null
join fiscal_periods p on p.id = bl.period_id
join accounts a on a.id = bl.account_id
where b.deleted_at is null;

create view v_eta_work_queue as         -- everything not yet accepted by ETA
select s.id, s.kind, s.document_id, s.internal_id, s.status, s.error_codes,
       s.retry_count, s.next_retry_at, now() - s.created_at as age
from eta_submissions s
where s.deleted_at is null
  and s.status in ('queued','signed','submitted','invalid','rejected','failed');

-- ---------- RLS (SKELETON) ----------
create or replace function user_has_branch(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select b is null
      or exists (select 1 from user_branches ub
                 where ub.user_id = auth.uid() and ub.branch_id = b and ub.deleted_at is null)
      or exists (select 1 from profiles p join roles r on r.id = p.role_id
                 where p.id = auth.uid() and r.name = 'Admin');
$$;

-- Deny by default on every table. Antigravity must then add per-table policies using
-- has_perm(module, action) AND user_has_branch(branch_id) where a branch_id exists.
-- employees.national_id / social_insurance_no: payroll roles only.
do $$
declare t text;
begin
  for t in select table_name from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

