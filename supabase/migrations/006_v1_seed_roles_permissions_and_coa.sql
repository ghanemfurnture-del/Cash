-- =====================================================================
-- 006_v1_seed_roles_permissions_and_coa.sql
-- Production Seed Migration for Phase 2b:
-- 1. Standard Roles (Admin, Accountant, Cashier) - Idempotent, attaches to existing Admin
-- 2. Role Permissions (Module-by-module matrix for Admin, Accountant, Cashier)
-- 3. [NEEDS ACCOUNTANT REVIEW] Egyptian Standard Chart of Accounts (COA)
-- 4. [NEEDS ACCOUNTANT REVIEW] Default System Account Mappings (account_mappings)
-- 5. Standard Units, Tax Codes, Currencies
-- 6. Default Main Branch ('MAIN') & One Open Fiscal Year with 12 Monthly Periods
-- NOTE: Test fixtures (ALX branch, closed periods, test users) live ONLY in test scripts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. STANDARD ROLES (Idempotent: preserves existing Admin role & UUID)
-- Unique constraint in 001: roles.name UNIQUE
-- ---------------------------------------------------------------------
insert into roles (name, description)
values
  ('Admin', 'مدير النظام بصلاحيات كاملة لكافة الفروع والموديلات'),
  ('Accountant', 'محاسب مالي معتمد - إدارة القيود، الحسابات، السندات والتسويات'),
  ('Cashier', 'كاشير مبيعات ونقطة بيع - فواتير وسندات تحصيل الفرع')
on conflict (name) do update
set description = excluded.description;

-- ---------------------------------------------------------------------
-- 2. ROLE PERMISSIONS MATRIX
-- Unique constraint in 001: role_permissions(role_id, module, action) UNIQUE
-- ---------------------------------------------------------------------

-- A. Permissions for Admin (attached dynamically to the existing Admin role)
do $$
declare
  v_admin_role_id uuid;
  m text;
  a text;
  modules text[] := array['accounting', 'sales', 'purchases', 'inventory', 'treasury', 'parties', 'settings', 'reports', 'audit'];
  actions text[] := array['view', 'create', 'edit', 'post', 'delete', 'reverse', 'export'];
begin
  select id into v_admin_role_id from roles where name = 'Admin';

  if v_admin_role_id is not null then
    foreach m in array modules loop
      foreach a in array actions loop
        insert into role_permissions (role_id, module, action)
        values (v_admin_role_id, m, a)
        on conflict (role_id, module, action) do nothing;
      end loop;
    end loop;
  end if;
end $$;

-- B. Permissions for Accountant
do $$
declare
  v_acc_role_id uuid;
begin
  select id into v_acc_role_id from roles where name = 'Accountant';

  if v_acc_role_id is not null then
    -- Accounting: view, create, edit, post, reverse, export
    insert into role_permissions (role_id, module, action) values
      (v_acc_role_id, 'accounting', 'view'),
      (v_acc_role_id, 'accounting', 'create'),
      (v_acc_role_id, 'accounting', 'edit'),
      (v_acc_role_id, 'accounting', 'post'),
      (v_acc_role_id, 'accounting', 'reverse'),
      (v_acc_role_id, 'accounting', 'export'),
      -- Treasury: view, create, edit, post, reverse, export
      (v_acc_role_id, 'treasury', 'view'),
      (v_acc_role_id, 'treasury', 'create'),
      (v_acc_role_id, 'treasury', 'edit'),
      (v_acc_role_id, 'treasury', 'post'),
      (v_acc_role_id, 'treasury', 'reverse'),
      (v_acc_role_id, 'treasury', 'export'),
      -- Parties: view, create, edit, export
      (v_acc_role_id, 'parties', 'view'),
      (v_acc_role_id, 'parties', 'create'),
      (v_acc_role_id, 'parties', 'edit'),
      (v_acc_role_id, 'parties', 'export'),
      -- Read-only on operations and reports
      (v_acc_role_id, 'sales', 'view'),
      (v_acc_role_id, 'purchases', 'view'),
      (v_acc_role_id, 'inventory', 'view'),
      (v_acc_role_id, 'reports', 'view'),
      (v_acc_role_id, 'reports', 'export')
    on conflict (role_id, module, action) do nothing;
  end if;
end $$;

-- C. Permissions for Cashier
do $$
declare
  v_csh_role_id uuid;
begin
  select id into v_csh_role_id from roles where name = 'Cashier';

  if v_csh_role_id is not null then
    insert into role_permissions (role_id, module, action) values
      -- Sales: view, create, edit, post
      (v_csh_role_id, 'sales', 'view'),
      (v_csh_role_id, 'sales', 'create'),
      (v_csh_role_id, 'sales', 'edit'),
      (v_csh_role_id, 'sales', 'post'),
      -- Treasury: view, create (receipt vouchers)
      (v_csh_role_id, 'treasury', 'view'),
      (v_csh_role_id, 'treasury', 'create'),
      -- Parties: view, create (customers)
      (v_csh_role_id, 'parties', 'view'),
      (v_csh_role_id, 'parties', 'create'),
      -- Inventory: view (stocks)
      (v_csh_role_id, 'inventory', 'view')
    on conflict (role_id, module, action) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. MAIN BRANCH (Idempotent: preserves existing MAIN branch & UUID)
-- Unique constraint in 002: branches.code UNIQUE
-- ---------------------------------------------------------------------
insert into branches (code, name_ar, is_main, is_active)
values ('MAIN', 'الفرع الرئيسي', true, true)
on conflict (code) do update
set is_active = true;

-- ---------------------------------------------------------------------
-- 4. FISCAL YEAR 2026 WITH 12 MONTHLY PERIODS (ALL OPEN)
-- Unique constraints: fiscal_years PK id, fiscal_periods PK id
-- ---------------------------------------------------------------------
do $$
declare
  v_fy_id uuid;
  m int;
  s_date date;
  e_date date;
  p_name text;
begin
  select id into v_fy_id from fiscal_years where name = 'السنة المالية 2026';
  if v_fy_id is null then
    insert into fiscal_years (name, start_date, end_date, status)
    values ('السنة المالية 2026', '2026-01-01', '2026-12-31', 'open')
    returning id into v_fy_id;
  end if;

  for m in 1..12 loop
    s_date := make_date(2026, m, 1);
    e_date := (s_date + interval '1 month - 1 day')::date;
    p_name := 'فترة ' || lpad(m::text, 2, '0') || ' / 2026';

    if not exists (
      select 1 from fiscal_periods
      where fiscal_year_id = v_fy_id and start_date = s_date
    ) then
      insert into fiscal_periods (fiscal_year_id, start_date, end_date, status)
      values (v_fy_id, s_date, e_date, 'open');
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. CURRENCIES, UNITS & TAX CODES
-- Unique constraints: currencies.code UNIQUE, units.name_ar UNIQUE, tax_codes.code UNIQUE
-- ---------------------------------------------------------------------

-- Currencies
insert into currencies (code, name_ar, name_en, symbol, decimals)
values
  ('EGP', 'جنيه مصري', 'Egyptian Pound', 'ج.م', 2),
  ('USD', 'دولار أمريكي', 'US Dollar', '$', 2),
  ('EUR', 'يورو', 'Euro', '€', 2),
  ('SAR', 'ريال سعودي', 'Saudi Riyal', 'ر.س', 2),
  ('AED', 'درهم إماراتي', 'UAE Dirham', 'د.إ', 2)
on conflict (code) do nothing;

-- Units
insert into units (name_ar, name_en)
values
  ('قطعة', 'Piece'),
  ('كرتونة', 'Carton'),
  ('متر', 'Meter'),
  ('كيلوجرام', 'Kilogram'),
  ('لتر', 'Liter')
on conflict (name_ar) do nothing;

-- Tax Codes
insert into tax_codes (code, name, rate, kind)
values
  ('VAT14', 'ضريبة القيمة المضافة 14%', 0.1400, 'vat'),
  ('T0', 'إعفاء ضريبي 0%', 0.0000, 'vat')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 6. [NEEDS ACCOUNTANT REVIEW] EGYPTIAN STANDARD CHART OF ACCOUNTS (COA)
-- Unique constraint in 001: accounts.code UNIQUE
-- ---------------------------------------------------------------------

-- Level 1: Main Header Accounts (is_postable = false, is_system = true)
insert into accounts (code, name_ar, name_en, type, normal_side, is_postable, is_system, is_active)
values
  ('1', 'الأصول', 'Assets', 'asset', 'debit', false, true, true),
  ('2', 'الالتزامات', 'Liabilities', 'liability', 'credit', false, true, true),
  ('3', 'حقوق الملكية', 'Equity', 'equity', 'credit', false, true, true),
  ('4', 'الإيرادات', 'Revenues', 'revenue', 'credit', false, true, true),
  ('5', 'المصروفات', 'Expenses', 'expense', 'debit', false, true, true)
on conflict (code) do nothing;

-- Level 2 & 3: Postable Detailed Accounts
insert into accounts (code, name_ar, name_en, parent_id, type, normal_side, is_postable, is_system, is_active)
select v.code, v.name_ar, v.name_en, p.id, v.type, v.normal_side, v.is_postable, v.is_system, true
from (values
  -- Assets (1)
  ('1101', 'الخزينة الرئيسية (نقدية بالصندوق)', 'Cash on Hand', '1', 'asset'::text, 'debit'::text, true, true),
  ('1102', 'بنك مصر - حساب جاري', 'Bank Current Account', '1', 'asset'::text, 'debit'::text, true, false),
  ('1103', 'العملاء (حسابات المدينين التجارية)', 'Accounts Receivable', '1', 'asset'::text, 'debit'::text, true, true),
  ('1104', 'مخزون البضائع بالمستودعات', 'Merchandise Inventory', '1', 'asset'::text, 'debit'::text, true, true),
  ('1105', 'ضريبة القيمة المضافة المدفوعة (مدخلات)', 'VAT Input Tax Recoverable', '1', 'asset'::text, 'debit'::text, true, true),

  -- Liabilities (2)
  ('2101', 'الموردون (حسابات الدائنين التجارية)', 'Accounts Payable', '2', 'liability'::text, 'credit'::text, true, true),
  ('2102', 'ضريبة القيمة المضافة المحصلة (مخرجات)', 'VAT Output Tax Payable', '2', 'liability'::text, 'credit'::text, true, true),

  -- Equity (3)
  ('3101', 'رأس المال المدفوع', 'Paid-in Capital', '3', 'equity'::text, 'credit'::text, true, true),
  ('3102', 'الأرباح والخسائر المرحلة (المحتجزة)', 'Retained Earnings', '3', 'equity'::text, 'credit'::text, true, true),

  -- Revenues (4)
  ('4101', 'إيرادات المبيعات التجارية', 'Sales Revenue', '4', 'revenue'::text, 'credit'::text, true, true),
  ('4102', 'مردودات ومسموحات المبيعات', 'Sales Returns and Allowances', '4', 'revenue'::text, 'debit'::text, true, true),
  ('4201', 'خصم مكتسب (إيراد)', 'Discount Received', '4', 'revenue'::text, 'credit'::text, true, false),

  -- Expenses (5)
  ('5101', 'تكلفة البضاعة المباعة (COGS)', 'Cost of Goods Sold', '5', 'expense'::text, 'debit'::text, true, true),
  ('5201', 'مصروفات عمومية وإدارية', 'General & Admin Expenses', '5', 'expense'::text, 'debit'::text, true, false),
  ('5202', 'خصم مسموح به (مصروف)', 'Discount Allowed', '5', 'expense'::text, 'debit'::text, true, false),
  ('5203', 'فروقات وتسويات جرد المخزون', 'Inventory Adjustment Variance', '5', 'expense'::text, 'debit'::text, true, false)
) as v(code, name_ar, name_en, parent_code, type, normal_side, is_postable, is_system)
join accounts p on p.code = v.parent_code
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 7. [NEEDS ACCOUNTANT REVIEW] DEFAULT SYSTEM ACCOUNT MAPPINGS
-- Unique constraint in 001: account_mappings.key UNIQUE
-- Covers all 14 standard keys defined in 001_core_schema.sql line 98
-- ---------------------------------------------------------------------
insert into account_mappings (key, account_id)
select m.k, a.id
from (values
  ('sales_revenue', '4101'),
  ('sales_returns', '4102'),
  ('cogs', '5101'),
  ('inventory', '1104'),
  ('vat_output', '2102'),
  ('vat_input', '1105'),
  ('receivables', '1103'),
  ('payables', '2101'),
  ('discount_allowed', '5202'),
  ('discount_received', '4201'),
  ('inventory_adjustment', '5203'),
  ('retained_earnings', '3102'),
  ('cash_default', '1101'),
  ('bank_default', '1102')
) as m(k, code)
join accounts a on a.code = m.code
on conflict (key) do update
set account_id = excluded.account_id;
