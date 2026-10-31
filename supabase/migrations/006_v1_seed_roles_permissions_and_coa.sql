-- =====================================================================
-- 006_v1_seed_roles_permissions_and_coa.sql
-- Seed Data for Phase 2b-1:
-- 1. Standard Roles (Admin, Accountant, Cashier)
-- 2. Role Permissions (Module-by-module matrix)
-- 3. Egyptian Standard Chart of Accounts (COA)
-- 4. Testing Branches, Warehouses, Units, Fiscal Periods & Treasury
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. STANDARD ROLES
-- ---------------------------------------------------------------------
insert into roles (id, name, description)
values
  ('11111111-1111-1111-1111-111111111101', 'Admin', 'مدير النظام بصلاحيات كاملة لكافة الفروع والموديلات'),
  ('11111111-1111-1111-1111-111111111102', 'Accountant', 'محاسب مالي معتمد - إدارة القيود، الحسابات، السندات والتسويات'),
  ('11111111-1111-1111-1111-111111111103', 'Cashier', 'كاشير مبيعات ونقطة بيع - فواتير وسندات تحصيل الفرع')
on conflict (name) do update
set description = excluded.description;

-- ---------------------------------------------------------------------
-- 2. ROLE PERMISSIONS
-- ---------------------------------------------------------------------

-- A. Permissions for Admin (All modules & actions)
do $$
declare
  admin_id uuid;
  m text;
  a text;
  modules text[] := array['accounting', 'sales', 'purchases', 'inventory', 'treasury', 'parties', 'settings', 'reports', 'audit'];
  actions text[] := array['view', 'create', 'edit', 'post', 'delete', 'reverse'];
begin
  select id into admin_id from roles where name = 'Admin';

  foreach m in array modules loop
    foreach a in array actions loop
      insert into role_permissions (role_id, module, action)
      values (admin_id, m, a)
      on conflict (role_id, module, action) do nothing;
    end loop;
  end loop;
end $$;

-- B. Permissions for Accountant
do $$
declare
  acc_id uuid;
begin
  select id into acc_id from roles where name = 'Accountant';

  -- Accounting: view, create, edit, post, reverse
  insert into role_permissions (role_id, module, action) values
    (acc_id, 'accounting', 'view'),
    (acc_id, 'accounting', 'create'),
    (acc_id, 'accounting', 'edit'),
    (acc_id, 'accounting', 'post'),
    (acc_id, 'accounting', 'reverse'),
    -- Treasury: view, create, edit, post, reverse
    (acc_id, 'treasury', 'view'),
    (acc_id, 'treasury', 'create'),
    (acc_id, 'treasury', 'edit'),
    (acc_id, 'treasury', 'post'),
    (acc_id, 'treasury', 'reverse'),
    -- Parties: view, create, edit
    (acc_id, 'parties', 'view'),
    (acc_id, 'parties', 'create'),
    (acc_id, 'parties', 'edit'),
    -- Read-only on operations and reports
    (acc_id, 'sales', 'view'),
    (acc_id, 'purchases', 'view'),
    (acc_id, 'inventory', 'view'),
    (acc_id, 'reports', 'view')
  on conflict (role_id, module, action) do nothing;
end $$;

-- C. Permissions for Cashier
do $$
declare
  csh_id uuid;
begin
  select id into csh_id from roles where name = 'Cashier';

  insert into role_permissions (role_id, module, action) values
    -- Sales: view, create, edit, post
    (csh_id, 'sales', 'view'),
    (csh_id, 'sales', 'create'),
    (csh_id, 'sales', 'edit'),
    (csh_id, 'sales', 'post'),
    -- Treasury: view, create (receipts)
    (csh_id, 'treasury', 'view'),
    (csh_id, 'treasury', 'create'),
    -- Parties: view, create (customers)
    (csh_id, 'parties', 'view'),
    (csh_id, 'parties', 'create'),
    -- Inventory: view (stocks)
    (csh_id, 'inventory', 'view')
  on conflict (role_id, module, action) do nothing;
end $$;

-- ---------------------------------------------------------------------
-- 3. BRANCHES & FISCAL CONFIGURATION FOR TESTING
-- ---------------------------------------------------------------------

-- Branches
insert into branches (id, code, name_ar, is_main, is_active)
values
  ('22222222-2222-2222-2222-222222222201', 'CAI', 'فرع القاهرة الرئيسي', true, true),
  ('22222222-2222-2222-2222-222222222202', 'ALX', 'فرع الإسكندرية', false, true)
on conflict (code) do update
set name_ar = excluded.name_ar, is_main = excluded.is_main, is_active = excluded.is_active;

-- Fiscal Year 2026
insert into fiscal_years (id, name, start_date, end_date, status)
values
  ('33333333-3333-3333-3333-333333333301', 'السنة المالية 2026', '2026-01-01', '2026-12-31', 'open')
on conflict (id) do nothing;

-- Fiscal Periods (Current Open period vs Past Closed period)
insert into fiscal_periods (id, fiscal_year_id, start_date, end_date, status)
values
  -- Open Period (October 2026) -> Valid postings succeed
  ('44444444-4444-4444-4444-444444444401', '33333333-3333-3333-3333-333333333301', '2026-10-01', '2026-10-31', 'open'),
  -- Closed Period (September 2026) -> Posting must be rejected by require_open_period()
  ('44444444-4444-4444-4444-444444444402', '33333333-3333-3333-3333-333333333301', '2026-09-01', '2026-09-30', 'closed')
on conflict (id) do nothing;

-- Currencies
insert into currencies (code, name_ar, name_en, symbol, decimals)
values
  ('EGP', 'جنيه مصري', 'Egyptian Pound', 'ج.م', 2),
  ('USD', 'دولار أمريكي', 'US Dollar', '$', 2)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 4. EGYPTIAN STANDARD CHART OF ACCOUNTS (دليل الحسابات المصري)
-- ---------------------------------------------------------------------

-- Level 1: Main Categories (Header Accounts)
insert into accounts (id, code, name_ar, name_en, type, normal_side, is_postable, is_system, is_active)
values
  ('55555555-5555-5555-5555-555555555501', '1', 'الأصول', 'Assets', 'asset', 'debit', false, true, true),
  ('55555555-5555-5555-5555-555555555502', '2', 'الالتزامات', 'Liabilities', 'liability', 'credit', false, true, true),
  ('55555555-5555-5555-5555-555555555503', '3', 'حقوق الملكية', 'Equity', 'equity', 'credit', false, true, true),
  ('55555555-5555-5555-5555-555555555504', '4', 'الإيرادات', 'Revenues', 'revenue', 'credit', false, true, true),
  ('55555555-5555-5555-5555-555555555505', '5', 'المصروفات', 'Expenses', 'expense', 'debit', false, true, true)
on conflict (code) do nothing;

-- Level 2 & 3: Postable Detailed Accounts
insert into accounts (id, code, name_ar, name_en, parent_id, type, normal_side, is_postable, is_system, is_active)
values
  -- Assets (1)
  ('55555555-5555-5555-5555-555555555511', '1101', 'الخزينة الرئيسية (نقدية بالصندوق)', 'Cash on Hand', '55555555-5555-5555-5555-555555555501', 'asset', 'debit', true, true, true),
  ('55555555-5555-5555-5555-555555555512', '1102', 'بنك مصر - حساب جاري', 'Bank Current Account', '55555555-5555-5555-5555-555555555501', 'asset', 'debit', true, false, true),
  ('55555555-5555-5555-5555-555555555513', '1103', 'العملاء (حسابات القبض)', 'Accounts Receivable', '55555555-5555-5555-5555-555555555501', 'asset', 'debit', true, true, true),
  ('55555555-5555-5555-5555-555555555514', '1104', 'مخزون البضائع بالمستودعات', 'Merchandise Inventory', '55555555-5555-5555-5555-555555555501', 'asset', 'debit', true, true, true),

  -- Liabilities (2)
  ('55555555-5555-5555-5555-555555555521', '2101', 'الموردون (حسابات الدفع)', 'Accounts Payable', '55555555-5555-5555-5555-555555555502', 'liability', 'credit', true, true, true),
  ('55555555-5555-5555-5555-555555555522', '2102', 'مصلحة الضرائب - ضريبة القيمة المضافة 14%', 'VAT Output Tax Payable', '55555555-5555-5555-5555-555555555502', 'liability', 'credit', true, true, true),

  -- Equity (3)
  ('55555555-5555-5555-5555-555555555531', '3101', 'رأس المال المدفوع', 'Paid-in Capital', '55555555-5555-5555-5555-555555555503', 'equity', 'credit', true, true, true),

  -- Revenues (4)
  ('55555555-5555-5555-5555-555555555541', '4101', 'إيرادات المبيعات التجارية', 'Sales Revenue', '55555555-5555-5555-5555-555555555504', 'revenue', 'credit', true, true, true),

  -- Expenses (5)
  ('55555555-5555-5555-5555-555555555551', '5101', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold (COGS)', '55555555-5555-5555-5555-555555555505', 'expense', 'debit', true, true, true),
  ('55555555-5555-5555-5555-555555555552', '5201', 'مصروفات عمومية وإدارية', 'General & Admin Expenses', '55555555-5555-5555-5555-555555555505', 'expense', 'debit', true, false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 5. UNITS, TAX CODES, WAREHOUSES & TREASURY ACCOUNTS
-- ---------------------------------------------------------------------

-- Units
insert into units (id, name_ar, name_en)
values
  ('66666666-6666-6666-6666-666666666601', 'قطعة', 'Piece'),
  ('66666666-6666-6666-6666-666666666602', 'كرتونة', 'Carton')
on conflict (name_ar) do nothing;

-- Tax Codes
insert into tax_codes (id, code, name, rate, kind)
values
  ('77777777-7777-7777-7777-777777777701', 'T1', 'ضريبة القيمة المضافة 14%', 0.1400, 'vat'),
  ('77777777-7777-7777-7777-777777777702', 'T0', 'إعفاء ضريبي 0%', 0.0000, 'vat')
on conflict (code) do nothing;

-- Warehouses
insert into warehouses (id, code, name_ar, branch_id, is_active)
values
  ('88888888-8888-8888-8888-888888888801', 'WH-CAI', 'مستودع القاهرة الرئيسي', '22222222-2222-2222-2222-222222222201', true),
  ('88888888-8888-8888-8888-888888888802', 'WH-ALX', 'مستودع الإسكندرية', '22222222-2222-2222-2222-222222222202', true)
on conflict (id) do nothing;

-- Treasury Accounts
insert into treasury_accounts (id, kind, name_ar, currency_code, branch_id, is_active)
values
  ('99999999-9999-9999-9999-999999999901', 'cash', 'خزينة فرع القاهرة', 'EGP', '22222222-2222-2222-2222-222222222201', true),
  ('99999999-9999-9999-9999-999999999902', 'cash', 'خزينة فرع الإسكندرية', 'EGP', '22222222-2222-2222-2222-222222222202', true)
on conflict (id) do nothing;

-- Item Category & Test Item
insert into item_categories (id, name_ar)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'أصناف عامة')
on conflict (id) do nothing;

insert into items (id, sku, name_ar, category_id, base_unit_id, is_stocked, sale_price, purchase_price, tracking)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ITEM-TEST-001', 'صنف تجريبي رقم 1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66666666-6666-6666-6666-666666666601', true, 150.0000, 100.0000, 'none')
on conflict (sku) do nothing;

-- Sample Customer Party
insert into parties (id, code, name_ar, is_customer, is_supplier)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'CUST-001', 'شركة الأمل للتجارة (عميل تجريبي)', true, false)
on conflict (code) do nothing;
