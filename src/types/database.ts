// Base record matching _row_base in Postgres migrations
export interface BaseEntity {
  id: string; // Client-generated UUID
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  device_id?: string | null;
  version: number;
  server_seq: number;
  deleted_at?: string | null;
}

// 1. roles
export interface Role extends BaseEntity {
  name: string;
  description?: string | null;
}

// 2. role_permissions
export interface RolePermission extends BaseEntity {
  role_id: string;
  module: string;
  action: 'view' | 'create' | 'edit' | 'post' | 'reverse' | 'delete' | 'export';
}

// 3. profiles
export interface Profile extends BaseEntity {
  full_name: string;
  phone?: string | null;
  role_id?: string | null;
  is_active: boolean;
}

// 4. devices
export interface Device extends BaseEntity {
  user_id: string;
  name: string;
  series_code: string;
  last_sync_at?: string | null;
  revoked_at?: string | null;
  branch_id?: string | null;
}

// 5. company_settings
export interface CompanySettings extends BaseEntity {
  name_ar: string;
  name_en?: string | null;
  tax_number?: string | null;
  address?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  base_currency: string;
  default_vat_rate: number;
  negative_stock: 'allow' | 'warn' | 'block';
}

// 6. fiscal_years
export interface FiscalYear extends BaseEntity {
  name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
}

// 7. fiscal_periods
export interface FiscalPeriod extends BaseEntity {
  fiscal_year_id: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
}

// 8. currencies
export interface Currency extends BaseEntity {
  code: string;
  name_ar: string;
  name_en?: string | null;
  symbol?: string | null;
  decimals: number;
}

// 9. exchange_rates
export interface ExchangeRate extends BaseEntity {
  currency_code: string;
  rate_date: string;
  rate: number;
}

// 10. accounts
export interface Account extends BaseEntity {
  code: string;
  name_ar: string;
  name_en?: string | null;
  parent_id?: string | null;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal_side: 'debit' | 'credit';
  is_postable: boolean;
  is_system: boolean;
  is_active: boolean;
}

// 11. cost_centers
export interface CostCenter extends BaseEntity {
  code: string;
  name_ar: string;
  parent_id?: string | null;
  is_active: boolean;
}

// 12. account_mappings
export interface AccountMapping extends BaseEntity {
  key: string;
  account_id: string;
}

// 13. journal_entries
export interface JournalEntry extends BaseEntity {
  series_code: string;
  seq_no: number;
  entry_no: string;
  entry_date: string;
  description?: string | null;
  source_type: 'manual' | 'document' | 'payment' | 'stock_adjustment' | 'opening' | 'closing' | 'reversal';
  source_id?: string | null;
  status: 'draft' | 'posted' | 'reversed';
  posted_at?: string | null;
  reverses_entry_id?: string | null;
  branch_id?: string | null;
}

// 14. journal_lines
export interface JournalLine extends BaseEntity {
  entry_id: string;
  line_no: number;
  account_id: string;
  party_id?: string | null;
  cost_center_id?: string | null;
  debit: number;
  credit: number;
  currency_code?: string | null;
  fx_amount?: number | null;
  memo?: string | null;
}

// 15. parties
export interface Party extends BaseEntity {
  code: string;
  name_ar: string;
  name_en?: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  tax_number?: string | null;
  credit_limit: number;
  payment_terms_days: number;
  is_active: boolean;
  price_list_id?: string | null;
  eta_receiver_type?: 'B' | 'P' | 'F' | null;
  country_code: string;
  governorate?: string | null;
  city?: string | null;
  street?: string | null;
  building_no?: string | null;
}

// 16. tax_codes
export interface TaxCode extends BaseEntity {
  code: string;
  name: string;
  rate: number;
  kind: 'vat' | 'table' | 'withholding';
  eta_tax_type?: string | null;
  eta_tax_subtype?: string | null;
}

// 17. units
export interface Unit extends BaseEntity {
  name_ar: string;
  name_en?: string | null;
  eta_code?: string | null;
}

// 18. item_categories
export interface ItemCategory extends BaseEntity {
  name_ar: string;
  parent_id?: string | null;
}

// 19. items
export interface Item extends BaseEntity {
  sku: string;
  name_ar: string;
  name_en?: string | null;
  category_id?: string | null;
  base_unit_id: string;
  is_stocked: boolean;
  sale_price: number;
  purchase_price: number;
  tax_code_id?: string | null;
  min_stock: number;
  is_active: boolean;
  tracking: 'none' | 'lot' | 'serial';
}

// 20. item_units
export interface ItemUnit extends BaseEntity {
  item_id: string;
  unit_id: string;
  factor_to_base: number;
}

// 21. item_barcodes
export interface ItemBarcode extends BaseEntity {
  item_id: string;
  unit_id?: string | null;
  barcode: string;
}

// 22. warehouses
export interface Warehouse extends BaseEntity {
  code: string;
  name_ar: string;
  is_active: boolean;
  branch_id?: string | null;
}

// 23. documents
export interface Document extends BaseEntity {
  doc_type: 'quotation' | 'sales_order' | 'sales_invoice' | 'sales_return' | 'purchase_order' | 'purchase_invoice' | 'purchase_return';
  series_code: string;
  seq_no: number;
  doc_no: string;
  doc_date: string;
  due_date?: string | null;
  party_id?: string | null;
  warehouse_id?: string | null;
  currency_code: string;
  exchange_rate: number;
  payment_method?: 'cash' | 'credit' | 'partial' | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  status: 'draft' | 'posted' | 'reversed' | 'cancelled';
  posted_at?: string | null;
  journal_entry_id?: string | null;
  reverses_document_id?: string | null;
  salesperson_id?: string | null;
  notes?: string | null;
  branch_id?: string | null;
  source: 'back_office' | 'pos';
  pos_shift_id?: string | null;
}

// 24. document_lines
export interface DocumentLine extends BaseEntity {
  document_id: string;
  line_no: number;
  item_id?: string | null;
  description?: string | null;
  unit_id?: string | null;
  qty: number;
  unit_factor: number;
  unit_price: number;
  discount_amount: number;
  tax_code_id?: string | null;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  unit_cost?: number | null;
  cost_center_id?: string | null;
  lot_no?: string | null;
  expiry_date?: string | null;
  serial_no?: string | null;
}

// 25. stock_movements
export interface StockMovement extends BaseEntity {
  item_id: string;
  warehouse_id: string;
  movement_date: string;
  movement_type: 'opening' | 'purchase' | 'purchase_return' | 'sale' | 'sale_return' | 'transfer_in' | 'transfer_out' | 'adjustment';
  qty_base: number;
  unit_cost: number;
  source_type?: string | null;
  source_id?: string | null;
  transfer_group_id?: string | null;
  notes?: string | null;
  lot_no?: string | null;
  expiry_date?: string | null;
  serial_no?: string | null;
}

// 26. treasury_accounts
export interface TreasuryAccount extends BaseEntity {
  kind: 'cash' | 'bank';
  name_ar: string;
  bank_name?: string | null;
  account_number?: string | null;
  currency_code: string;
  gl_account_id: string;
  is_active: boolean;
  branch_id?: string | null;
}

// 27. payments
export interface Payment extends BaseEntity {
  voucher_type: 'receipt' | 'payment' | 'expense' | 'transfer';
  series_code: string;
  seq_no: number;
  voucher_no: string;
  voucher_date: string;
  treasury_account_id: string;
  to_treasury_account_id?: string | null;
  party_id?: string | null;
  expense_account_id?: string | null;
  amount: number;
  currency_code: string;
  exchange_rate: number;
  method?: 'cash' | 'bank_transfer' | 'cheque' | 'card' | null;
  reference?: string | null;
  notes?: string | null;
  status: 'draft' | 'posted' | 'reversed';
  posted_at?: string | null;
  journal_entry_id?: string | null;
  branch_id?: string | null;
}

// 28. payment_allocations
export interface PaymentAllocation extends BaseEntity {
  payment_id: string;
  document_id: string;
  amount: number;
  installment_id?: string | null;
}

// 29. cheques
export interface Cheque extends BaseEntity {
  direction: 'received' | 'issued';
  cheque_no: string;
  bank_name?: string | null;
  due_date: string;
  amount: number;
  party_id?: string | null;
  status: 'pending' | 'deposited' | 'cleared' | 'bounced' | 'cancelled';
  payment_id?: string | null;
}

// 30. bank_reconciliations
export interface BankReconciliation extends BaseEntity {
  treasury_account_id: string;
  statement_date: string;
  statement_balance: number;
  status: 'open' | 'completed';
}

// 31. reconciliation_items
export interface ReconciliationItem extends BaseEntity {
  reconciliation_id: string;
  journal_line_id: string;
}

// 32. audit_log
export interface AuditLog extends BaseEntity {
  user_id?: string | null;
  entity: string;
  entity_id: string;
  action: string;
  changes?: Record<string, any> | null;
}

// 33. sync_conflicts
export interface SyncConflict extends BaseEntity {
  entity: string;
  entity_id: string;
  local_payload: Record<string, any>;
  server_payload: Record<string, any>;
  base_version?: number | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
  resolution?: 'keep_local' | 'keep_server' | 'merged' | null;
}

// 34. branches
export interface Branch extends BaseEntity {
  code: string;
  name_ar: string;
  name_en?: string | null;
  address?: string | null;
  phone?: string | null;
  eta_branch_code?: string | null;
  is_main: boolean;
  is_active: boolean;
}

// 35. user_branches
export interface UserBranch extends BaseEntity {
  user_id: string;
  branch_id: string;
}

// 36. price_lists
export interface PriceList extends BaseEntity {
  name_ar: string;
  currency_code: string;
  kind: 'sales' | 'purchase';
  is_default: boolean;
}

// 37. price_list_items
export interface PriceListItem extends BaseEntity {
  price_list_id: string;
  item_id: string;
  unit_id?: string | null;
  min_qty: number;
  price: number;
}

// 38. number_series
export interface NumberSeries extends BaseEntity {
  doc_type: string;
  branch_id?: string | null;
  prefix: string;
  padding: number;
  reset_policy: 'never' | 'yearly' | 'monthly';
}

// 39. print_templates
export interface PrintTemplate extends BaseEntity {
  doc_type: string;
  name: string;
  paper: 'a4' | 'a5' | 'thermal80' | 'thermal58';
  html: string;
  is_default: boolean;
}

// 40. settings_kv
export interface SettingsKv extends BaseEntity {
  scope: 'company' | 'branch' | 'user';
  scope_id?: string | null;
  key: string;
  value: Record<string, any>;
}

// 41. attachments
export interface Attachment extends BaseEntity {
  entity: string;
  entity_id: string;
  file_name: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  storage_path?: string | null;
  local_only: boolean;
}

// 42. notifications
export interface Notification extends BaseEntity {
  user_id?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  read_at?: string | null;
}

// 43. eta_settings
export interface EtaSettings extends BaseEntity {
  environment: 'preprod' | 'prod';
  issuer_type: 'B' | 'P' | 'F';
  activity_code?: string | null;
  signing_agent_url: string;
  auto_submit: boolean;
}

// 44. eta_item_codes
export interface EtaItemCode extends BaseEntity {
  item_id: string;
  code_type: 'GS1' | 'EGS';
  item_code: string;
}

// 45. eta_submissions
export interface EtaSubmission extends BaseEntity {
  kind: 'invoice' | 'credit_note' | 'debit_note' | 'receipt';
  document_id: string;
  internal_id: string;
  eta_uuid?: string | null;
  long_id?: string | null;
  submission_id?: string | null;
  status: 'queued' | 'signed' | 'submitted' | 'valid' | 'invalid' | 'rejected' | 'cancelled' | 'failed';
  canonical_payload?: string | null;
  signed_payload?: Record<string, any> | null;
  response?: Record<string, any> | null;
  error_codes?: string[] | null;
  retry_count: number;
  next_retry_at?: string | null;
  submitted_at?: string | null;
  validated_at?: string | null;
  qr_url?: string | null;
}

// 46. pos_terminals
export interface PosTerminal extends BaseEntity {
  branch_id: string;
  name: string;
  warehouse_id: string;
  cash_account_id: string;
  card_account_id?: string | null;
  default_price_list_id?: string | null;
  eta_pos_serial?: string | null;
  is_active: boolean;
}

// 47. pos_shifts
export interface PosShift extends BaseEntity {
  terminal_id: string;
  cashier_id: string;
  opened_at: string;
  opening_cash: number;
  closed_at?: string | null;
  expected_cash?: number | null;
  counted_cash?: number | null;
  cash_difference?: number | null;
  status: 'open' | 'closed';
  journal_entry_id?: string | null;
  notes?: string | null;
}

// 48. pos_cash_movements
export interface PosCashMovement extends BaseEntity {
  shift_id: string;
  kind: 'in' | 'out';
  amount: number;
  reason: string;
}

// 49. document_payments
export interface DocumentPayment extends BaseEntity {
  document_id: string;
  method: 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'wallet' | 'credit';
  amount: number;
  treasury_account_id?: string | null;
  reference?: string | null;
}

// 50. installment_plans
export interface InstallmentPlan extends BaseEntity {
  document_id: string;
  installments_count: number;
  first_due_date: string;
  interest_rate: number;
  down_payment: number;
}

// 51. installments
export interface Installment extends BaseEntity {
  plan_id: string;
  seq: number;
  due_date: string;
  amount: number;
}

// 52. departments
export interface Department extends BaseEntity {
  name_ar: string;
}

// 53. employees
export interface Employee extends BaseEntity {
  code: string;
  name_ar: string;
  name_en?: string | null;
  department_id?: string | null;
  branch_id?: string | null;
  profile_id?: string | null;
  job_title?: string | null;
  hire_date: string;
  termination_date?: string | null;
  base_salary: number;
  pay_method: 'cash' | 'bank_transfer';
  treasury_account_id?: string | null;
  bank_iban?: string | null;
  national_id?: string | null;
  social_insurance_no?: string | null;
  phone?: string | null;
  is_active: boolean;
}

// 54. pay_components
export interface PayComponent extends BaseEntity {
  code: string;
  name_ar: string;
  kind: 'earning' | 'deduction';
  calc_type: 'fixed' | 'percent_of_base' | 'manual';
  default_value: number;
  gl_account_id?: string | null;
  is_taxable: boolean;
  is_insured: boolean;
}

// 55. employee_components
export interface EmployeeComponent extends BaseEntity {
  employee_id: string;
  component_id: string;
  value: number;
}

// 56. employee_loans
export interface EmployeeLoan extends BaseEntity {
  employee_id: string;
  loan_date: string;
  amount: number;
  monthly_installment: number;
  status: 'active' | 'settled' | 'cancelled';
  payment_id?: string | null;
}

// 57. payroll_tax_brackets
export interface PayrollTaxBracket extends BaseEntity {
  effective_from: string;
  from_amount: number;
  to_amount?: number | null;
  rate: number;
}

// 58. payroll_runs
export interface PayrollRun extends BaseEntity {
  branch_id?: string | null;
  pay_year: number;
  pay_month: number;
  pay_date: string;
  status: 'draft' | 'posted' | 'reversed';
  posted_at?: string | null;
  journal_entry_id?: string | null;
}

// 59. payslips
export interface Payslip extends BaseEntity {
  run_id: string;
  employee_id: string;
  base_salary: number;
  gross: number;
  total_deductions: number;
  net: number;
  payment_id?: string | null;
}

// 60. payslip_lines
export interface PayslipLine extends BaseEntity {
  payslip_id: string;
  component_id?: string | null;
  kind: 'earning' | 'deduction';
  amount: number;
  loan_id?: string | null;
  notes?: string | null;
}

// 61. asset_categories
export interface AssetCategory extends BaseEntity {
  name_ar: string;
  method: 'straight_line' | 'declining_balance';
  life_months: number;
  asset_account_id: string;
  accumulated_depr_account_id: string;
  depr_expense_account_id: string;
}

// 62. fixed_assets
export interface FixedAsset extends BaseEntity {
  code: string;
  name_ar: string;
  category_id: string;
  branch_id?: string | null;
  cost_center_id?: string | null;
  purchase_date: string;
  in_service_date: string;
  cost: number;
  salvage_value: number;
  status: 'active' | 'disposed' | 'fully_depreciated';
  disposal_date?: string | null;
  disposal_amount?: number | null;
  purchase_document_id?: string | null;
}

// 63. depreciation_runs
export interface DepreciationRun extends BaseEntity {
  run_date: string;
  period_id?: string | null;
  status: 'draft' | 'posted' | 'reversed';
  posted_at?: string | null;
  journal_entry_id?: string | null;
}

// 64. depreciation_lines
export interface DepreciationLine extends BaseEntity {
  run_id: string;
  asset_id: string;
  amount: number;
}

// 65. budgets
export interface Budget extends BaseEntity {
  fiscal_year_id: string;
  name_ar: string;
  branch_id?: string | null;
}

// 66. budget_lines
export interface BudgetLine extends BaseEntity {
  budget_id: string;
  account_id: string;
  period_id: string;
  amount: number;
}

// Client-only: outbox
export interface OutboxItem {
  id: string;                  // client uuid
  op_id: string;               // unique operation uuid (for idempotency)
  user_id: string;
  entity: string;              // table name
  entity_id: string;
  op: 'insert' | 'update' | 'delete' | 'post' | 'reverse';
  payload: Record<string, any>;
  base_version?: number | null;
  client_ts: string;
  schema_version: number;
  status: 'pending' | 'in_flight' | 'applied' | 'conflict' | 'failed';
  retry_count: number;
  error?: string | null;
}

// Client-only: sync metadata
export interface SyncMeta {
  key: string;                 // e.g. 'last_server_seq', 'last_sync_at', 'device_id'
  value: any;
  updated_at: string;
}

