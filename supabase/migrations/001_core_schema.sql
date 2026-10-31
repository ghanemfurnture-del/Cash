-- =====================================================================
-- 001_core_schema.sql  |  Offline-first accounting app (PostgreSQL / Supabase)
-- Design rules:
--  * UUID primary keys generated ON THE CLIENT (works offline, no collisions)
--  * Money/qty are numeric(18,4); rates numeric(18,6). Never floats.
--  * Financial documents are append-only: draft -> posted -> reversed.
--    Posted rows are immutable; corrections = reversal documents.
--  * Stock is stored as MOVEMENTS; balances are derived (views).
--  * Every table has server_seq: clients pull "everything since cursor".
--  * Local IndexedDB (Dexie) mirrors these tables 1:1, plus a local outbox.
-- NOT YET EXECUTED against a live database: run on Supabase, fix errors.
-- =====================================================================
create extension if not exists pgcrypto;
create sequence if not exists sync_seq;

-- Template for common columns (never used directly)
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

-- ---------- Security: roles, permissions, users, devices ----------
create table roles (like _row_base including defaults,
  name text not null unique, description text, primary key (id));

create table role_permissions (like _row_base including defaults,
  role_id uuid not null references roles(id),
  module  text not null,  -- settings|accounting|parties|sales|purchases|inventory|treasury|reports|users
  action  text not null check (action in ('view','create','edit','post','reverse','delete','export')),
  unique (role_id, module, action), primary key (id));

-- Supabase only: profiles.id = auth.users.id
create table profiles (like _row_base including defaults,
  full_name text not null, phone text,
  role_id uuid references roles(id),
  is_active boolean not null default true,
  primary key (id), foreign key (id) references auth.users(id));

create table devices (like _row_base including defaults,
  user_id uuid not null references profiles(id),
  name text not null,
  series_code text not null unique,          -- e.g. D1, D2: used in document numbers
  last_sync_at timestamptz, revoked_at timestamptz,
  primary key (id));

-- ---------- Company, periods, currencies ----------
create table company_settings (like _row_base including defaults,
  name_ar text not null, name_en text, tax_number text, address text, phone text, logo_url text,
  base_currency char(3) not null default 'EGP',
  default_vat_rate numeric(6,4) not null default 0.14,
  negative_stock text not null default 'warn' check (negative_stock in ('allow','warn','block')),
  primary key (id));

create table fiscal_years (like _row_base including defaults,
  name text not null, start_date date not null, end_date date not null,
  status text not null default 'open' check (status in ('open','closed')),
  check (end_date > start_date), primary key (id));

create table fiscal_periods (like _row_base including defaults,
  fiscal_year_id uuid not null references fiscal_years(id),
  start_date date not null, end_date date not null,
  status text not null default 'open' check (status in ('open','closed')),
  check (end_date >= start_date), primary key (id));

create table currencies (like _row_base including defaults,
  code char(3) not null unique, name_ar text not null, name_en text,
  symbol text, decimals smallint not null default 2, primary key (id));

create table exchange_rates (like _row_base including defaults,
  currency_code char(3) not null, rate_date date not null,
  rate numeric(18,6) not null check (rate > 0),
  unique (currency_code, rate_date), primary key (id));

-- ---------- Chart of accounts ----------
create table accounts (like _row_base including defaults,
  code text not null unique, name_ar text not null, name_en text,
  parent_id uuid references accounts(id),
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  normal_side text not null check (normal_side in ('debit','credit')),
  is_postable boolean not null default true,   -- false = group/header account
  is_system boolean not null default false,
  is_active boolean not null default true,
  primary key (id));

create table cost_centers (like _row_base including defaults,
  code text not null unique, name_ar text not null,
  parent_id uuid references cost_centers(id), is_active boolean not null default true,
  primary key (id));

-- Which GL account each automatic posting uses
create table account_mappings (like _row_base including defaults,
  key text not null unique,  -- sales_revenue, sales_returns, cogs, inventory, vat_output, vat_input,
                             -- receivables, payables, discount_allowed, discount_received,
                             -- inventory_adjustment, retained_earnings, cash_default, bank_default
  account_id uuid not null references accounts(id), primary key (id));

-- ---------- Journal (double entry) ----------
create table journal_entries (like _row_base including defaults,
  series_code text not null, seq_no int not null, entry_no text not null,
  entry_date date not null,
  description text,
  source_type text not null default 'manual'
    check (source_type in ('manual','document','payment','stock_adjustment','opening','closing','reversal')),
  source_id uuid,                                   -- polymorphic, no FK on purpose
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  posted_at timestamptz,
  reverses_entry_id uuid references journal_entries(id),
  unique (series_code, seq_no), primary key (id));

create table journal_lines (like _row_base including defaults,
  entry_id uuid not null references journal_entries(id) on delete cascade,
  line_no int not null,
  account_id uuid not null references accounts(id),
  party_id uuid,                                     -- FK added below (parties defined later)
  cost_center_id uuid references cost_centers(id),
  debit  numeric(18,4) not null default 0 check (debit  >= 0),
  credit numeric(18,4) not null default 0 check (credit >= 0),
  currency_code char(3), fx_amount numeric(18,4), memo text,
  check ((debit = 0) <> (credit = 0)),               -- exactly one side per line
  unique (entry_id, line_no), primary key (id));

-- ---------- Parties, items, warehouses ----------
create table parties (like _row_base including defaults,
  code text not null unique, name_ar text not null, name_en text,
  is_customer boolean not null default false, is_supplier boolean not null default false,
  phone text, email text, address text, tax_number text,
  credit_limit numeric(18,4) not null default 0,
  payment_terms_days int not null default 0,
  is_active boolean not null default true,
  check (is_customer or is_supplier), primary key (id));
-- Opening balances are posted as an 'opening' journal entry, not stored here.
alter table journal_lines add constraint fk_jl_party foreign key (party_id) references parties(id);

create table tax_codes (like _row_base including defaults,
  code text not null unique, name text not null,
  rate numeric(6,4) not null check (rate >= 0),
  kind text not null default 'vat' check (kind in ('vat','table','withholding')),
  primary key (id));

create table units (like _row_base including defaults,
  name_ar text not null unique, name_en text, primary key (id));

create table item_categories (like _row_base including defaults,
  name_ar text not null, parent_id uuid references item_categories(id), primary key (id));

create table items (like _row_base including defaults,
  sku text not null unique, name_ar text not null, name_en text,
  category_id uuid references item_categories(id),
  base_unit_id uuid not null references units(id),
  is_stocked boolean not null default true,
  sale_price numeric(18,4) not null default 0,
  purchase_price numeric(18,4) not null default 0,
  tax_code_id uuid references tax_codes(id),
  min_stock numeric(18,4) not null default 0,
  is_active boolean not null default true, primary key (id));

create table item_units (like _row_base including defaults,
  item_id uuid not null references items(id), unit_id uuid not null references units(id),
  factor_to_base numeric(18,6) not null check (factor_to_base > 0),
  unique (item_id, unit_id), primary key (id));

create table item_barcodes (like _row_base including defaults,
  item_id uuid not null references items(id), unit_id uuid references units(id),
  barcode text not null unique, primary key (id));

create table warehouses (like _row_base including defaults,
  code text not null unique, name_ar text not null,
  is_active boolean not null default true, primary key (id));

-- ---------- Sales & purchase documents ----------
create table documents (like _row_base including defaults,
  doc_type text not null check (doc_type in ('quotation','sales_order','sales_invoice','sales_return',
                                              'purchase_order','purchase_invoice','purchase_return')),
  series_code text not null, seq_no int not null, doc_no text not null,
  doc_date date not null, due_date date,
  party_id uuid references parties(id),
  warehouse_id uuid references warehouses(id),
  currency_code char(3) not null default 'EGP',
  exchange_rate numeric(18,6) not null default 1,
  payment_method text check (payment_method in ('cash','credit','partial')),
  subtotal       numeric(18,4) not null default 0,
  discount_total numeric(18,4) not null default 0,
  tax_total      numeric(18,4) not null default 0,
  total          numeric(18,4) not null default 0,
  status text not null default 'draft' check (status in ('draft','posted','reversed','cancelled')),
  posted_at timestamptz,
  journal_entry_id uuid references journal_entries(id),
  reverses_document_id uuid references documents(id),
  salesperson_id uuid references profiles(id),
  notes text,
  unique (doc_type, series_code, seq_no), primary key (id));

create table document_lines (like _row_base including defaults,
  document_id uuid not null references documents(id) on delete cascade,
  line_no int not null,
  item_id uuid references items(id), description text,
  unit_id uuid references units(id),
  qty numeric(18,4) not null,
  unit_factor numeric(18,6) not null default 1,      -- qty * factor = base-unit qty
  unit_price numeric(18,4) not null,
  discount_amount numeric(18,4) not null default 0,
  tax_code_id uuid references tax_codes(id),
  tax_rate numeric(6,4) not null default 0,
  tax_amount numeric(18,4) not null default 0,
  line_total numeric(18,4) not null,
  unit_cost numeric(18,4),                           -- cost snapshot at posting (for COGS)
  cost_center_id uuid references cost_centers(id),
  unique (document_id, line_no), primary key (id));

-- ---------- Inventory movements (balances are derived) ----------
create table stock_movements (like _row_base including defaults,
  item_id uuid not null references items(id),
  warehouse_id uuid not null references warehouses(id),
  movement_date date not null,
  movement_type text not null check (movement_type in
    ('opening','purchase','purchase_return','sale','sale_return','transfer_in','transfer_out','adjustment')),
  qty_base numeric(18,4) not null,                   -- signed: + in, - out
  unit_cost numeric(18,4) not null default 0,        -- cost per BASE unit at that moment
  source_type text, source_id uuid, transfer_group_id uuid, notes text,
  primary key (id));

-- ---------- Treasury, vouchers, cheques ----------
create table treasury_accounts (like _row_base including defaults,
  kind text not null check (kind in ('cash','bank')),
  name_ar text not null, bank_name text, account_number text,
  currency_code char(3) not null default 'EGP',
  gl_account_id uuid not null references accounts(id),
  is_active boolean not null default true, primary key (id));

create table payments (like _row_base including defaults,
  voucher_type text not null check (voucher_type in ('receipt','payment','expense','transfer')),
  series_code text not null, seq_no int not null, voucher_no text not null,
  voucher_date date not null,
  treasury_account_id uuid not null references treasury_accounts(id),
  to_treasury_account_id uuid references treasury_accounts(id),   -- transfers only
  party_id uuid references parties(id),
  expense_account_id uuid references accounts(id),                -- expenses only
  amount numeric(18,4) not null check (amount > 0),
  currency_code char(3) not null default 'EGP',
  exchange_rate numeric(18,6) not null default 1,
  method text check (method in ('cash','bank_transfer','cheque','card')),
  reference text, notes text,
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  posted_at timestamptz,
  journal_entry_id uuid references journal_entries(id),
  unique (voucher_type, series_code, seq_no), primary key (id));

create table payment_allocations (like _row_base including defaults,
  payment_id  uuid not null references payments(id),
  document_id uuid not null references documents(id),
  amount numeric(18,4) not null check (amount > 0),
  unique (payment_id, document_id), primary key (id));

create table cheques (like _row_base including defaults,
  direction text not null check (direction in ('received','issued')),
  cheque_no text not null, bank_name text, due_date date not null,
  amount numeric(18,4) not null check (amount > 0),
  party_id uuid references parties(id),
  status text not null default 'pending'
    check (status in ('pending','deposited','cleared','bounced','cancelled')),
  payment_id uuid references payments(id), primary key (id));

create table bank_reconciliations (like _row_base including defaults,
  treasury_account_id uuid not null references treasury_accounts(id),
  statement_date date not null, statement_balance numeric(18,4) not null,
  status text not null default 'open' check (status in ('open','completed')), primary key (id));

create table reconciliation_items (like _row_base including defaults,
  reconciliation_id uuid not null references bank_reconciliations(id),
  journal_line_id uuid not null references journal_lines(id) unique, primary key (id));

-- ---------- Audit & sync infrastructure ----------
create table audit_log (like _row_base including defaults,
  user_id uuid, entity text not null, entity_id uuid not null,
  action text not null, changes jsonb, primary key (id));

create table sync_ops (like _row_base including defaults,       -- idempotent inbox of client operations
  op_id uuid not null unique,                                   -- client-generated; duplicate = already applied
  user_id uuid not null, entity text not null, entity_id uuid not null,
  op text not null check (op in ('insert','update','delete','post','reverse')),
  payload jsonb not null, base_version int,
  client_ts timestamptz not null, schema_version int not null,
  result text check (result in ('applied','duplicate','conflict','rejected')),
  error text, primary key (id));

create table sync_conflicts (like _row_base including defaults,
  entity text not null, entity_id uuid not null,
  local_payload jsonb not null, server_payload jsonb not null, base_version int,
  resolved_at timestamptz, resolved_by uuid,
  resolution text check (resolution in ('keep_local','keep_server','merged')),
  primary key (id));

-- ---------- Indexes ----------
create index on journal_lines (account_id);
create index on journal_lines (entry_id);
create index on journal_lines (party_id);
create index on journal_entries (entry_date);
create index on documents (party_id, doc_date);
create index on documents (doc_type, doc_date);
create index on document_lines (document_id);
create index on stock_movements (item_id, warehouse_id);
create index on stock_movements (movement_date);
create index on payments (party_id, voucher_date);
create index on payment_allocations (document_id);
create index on cheques (due_date, status);

-- ---------- Triggers: stamping, immutability, period & balance rules ----------
create or replace function stamp_row() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.server_seq := nextval('sync_seq');
  if tg_op = 'INSERT' then new.version := 1; else new.version := old.version + 1; end if;
  return new;
end $$;

-- Posted/reversed headers are immutable; only posted -> reversed is allowed.
create or replace function block_posted_changes() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'posted records cannot be deleted; create a reversal'; end if;
    return old;
  end if;
  if old.status in ('posted','reversed') then
    if not (old.status = 'posted' and new.status = 'reversed') then
      raise exception 'posted records are immutable; create a reversal instead';
    end if;
  end if;
  return new;
end $$;

-- Lines of a posted/reversed parent cannot change.
-- NOTE for the sync engine: insert header as draft + lines, THEN post.
create or replace function block_posted_children() returns trigger language plpgsql as $$
declare v jsonb; pid uuid; pstatus text;
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

-- Posting requires an OPEN fiscal period for the document date.
create or replace function require_open_period() returns trigger language plpgsql as $$
declare d date := (to_jsonb(new) ->> tg_argv[0])::date;
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted') then
    if not exists (select 1 from fiscal_periods
                   where d between start_date and end_date and status = 'open' and deleted_at is null) then
      raise exception 'no open fiscal period for date %', d;
    end if;
  end if;
  return new;
end $$;

-- Posting a journal entry requires debit = credit and at least 2 lines.
create or replace function check_entry_balanced() returns trigger language plpgsql as $$
declare d numeric; c numeric; n int;
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted') then
    select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n
      from journal_lines where entry_id = new.id and deleted_at is null;
    if n < 2 or d <> c then
      raise exception 'journal entry % not balanced (debit %, credit %, lines %)', new.entry_no, d, c, n;
    end if;
  end if;
  return new;
end $$;

create or replace function audit_row() returns trigger language plpgsql security definer as $$
declare v jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into audit_log (user_id, entity, entity_id, action, changes)
  values (auth.uid(), tg_table_name, (v ->> 'id')::uuid, lower(tg_op),
          case when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) else v end);
  return null;
end $$;

-- Immutability
create trigger trg_block_je  before update or delete on journal_entries for each row execute function block_posted_changes();
create trigger trg_block_doc before update or delete on documents       for each row execute function block_posted_changes();
create trigger trg_block_pay before update or delete on payments        for each row execute function block_posted_changes();
create trigger trg_block_jl  before insert or update or delete on journal_lines
  for each row execute function block_posted_children('journal_entries', 'entry_id');
create trigger trg_block_dl  before insert or update or delete on document_lines
  for each row execute function block_posted_children('documents', 'document_id');

-- Period + balance rules
create trigger trg_period_je  before insert or update on journal_entries for each row execute function require_open_period('entry_date');
create trigger trg_period_doc before insert or update on documents       for each row execute function require_open_period('doc_date');
create trigger trg_period_pay before insert or update on payments        for each row execute function require_open_period('voucher_date');
create trigger trg_balance_je before insert or update on journal_entries for each row execute function check_entry_balanced();

-- Stamp every table (updated_at, version, server_seq) + sync cursor index
do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'server_seq' and c.table_name <> '_row_base'
  loop
    execute format('create trigger trg_stamp before insert or update on %I for each row execute function stamp_row()', t);
    execute format('create index on %I (server_seq)', t);
  end loop;
end $$;

-- Audit trail on business tables
do $$
declare t text;
begin
  foreach t in array array['accounts','journal_entries','journal_lines','documents','document_lines',
                           'payments','parties','items','stock_movements','role_permissions','profiles',
                           'fiscal_periods','account_mappings']
  loop
    execute format('create trigger trg_audit after insert or update or delete on %I for each row execute function audit_row()', t);
  end loop;
end $$;

drop table _row_base;  -- template only (LIKE copied its columns)

-- ---------- Derived views (also reimplemented locally for offline reports) ----------
create view v_stock_balance as
select item_id, warehouse_id,
       sum(qty_base)                as qty,
       sum(qty_base * unit_cost)    as value      -- outs recorded at average cost => valid valuation
from stock_movements where deleted_at is null
group by item_id, warehouse_id;

create view v_trial_balance as
select a.id as account_id, a.code, a.name_ar, a.type,
       coalesce(sum(x.debit),0)  as debit,
       coalesce(sum(x.credit),0) as credit,
       coalesce(sum(x.debit - x.credit),0) as balance
from accounts a
left join (
  select l.account_id, l.debit, l.credit
  from journal_lines l join journal_entries e on e.id = l.entry_id
  where e.status in ('posted','reversed') and l.deleted_at is null and e.deleted_at is null
) x on x.account_id = a.id
group by a.id;

create view v_party_balance as   -- positive = party owes us; negative = we owe party
select p.id as party_id, coalesce(sum(l.debit - l.credit),0) as balance
from parties p
left join journal_lines l on l.party_id = p.id and l.deleted_at is null
  and l.account_id in (select account_id from account_mappings where key in ('receivables','payables'))
  and exists (select 1 from journal_entries e where e.id = l.entry_id and e.status in ('posted','reversed'))
group by p.id;

create view v_document_balance as
select d.id as document_id, d.total,
       coalesce(pa.paid,0) as paid, d.total - coalesce(pa.paid,0) as remaining
from documents d
left join (
  select a.document_id, sum(a.amount) as paid
  from payment_allocations a join payments p on p.id = a.payment_id
  where p.status = 'posted' and a.deleted_at is null
  group by a.document_id
) pa on pa.document_id = d.id
where d.status = 'posted'
  and d.doc_type in ('sales_invoice','purchase_invoice','sales_return','purchase_return');

-- ---------- Row Level Security (SKELETON: complete per table) ----------
create or replace function has_perm(m text, a text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p join role_permissions rp on rp.role_id = p.role_id
    where p.id = auth.uid() and p.is_active and rp.module = m and rp.action = a and rp.deleted_at is null);
$$;

alter table accounts         enable row level security;
alter table journal_entries  enable row level security;
alter table journal_lines    enable row level security;
-- TODO(Antigravity): enable RLS on EVERY table, deny by default, and add
-- select/insert/update policies using has_perm(<module>, <action>). Examples:
create policy accounts_select on accounts for select using (has_perm('accounting','view'));
create policy accounts_insert on accounts for insert with check (has_perm('accounting','create'));
create policy accounts_update on accounts for update using (has_perm('accounting','edit'));
-- documents: module depends on doc_type (sales_* -> 'sales', purchase_* -> 'purchases').
-- Devices that are revoked must lose access: check devices.revoked_at in the sync Edge Function.
