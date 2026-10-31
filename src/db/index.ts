import Dexie, { type Table } from 'dexie';
import type {
  Role,
  RolePermission,
  Profile,
  Device,
  CompanySettings,
  FiscalYear,
  FiscalPeriod,
  Currency,
  ExchangeRate,
  Account,
  CostCenter,
  AccountMapping,
  JournalEntry,
  JournalLine,
  Party,
  TaxCode,
  Unit,
  ItemCategory,
  Item,
  ItemUnit,
  ItemBarcode,
  Warehouse,
  Document,
  DocumentLine,
  StockMovement,
  TreasuryAccount,
  Payment,
  PaymentAllocation,
  Cheque,
  BankReconciliation,
  ReconciliationItem,
  AuditLog,
  SyncConflict,
  Branch,
  UserBranch,
  PriceList,
  PriceListItem,
  NumberSeries,
  PrintTemplate,
  SettingsKv,
  Attachment,
  Notification,
  EtaSettings,
  EtaItemCode,
  EtaSubmission,
  PosTerminal,
  PosShift,
  PosCashMovement,
  DocumentPayment,
  InstallmentPlan,
  Installment,
  Department,
  Employee,
  PayComponent,
  EmployeeComponent,
  EmployeeLoan,
  PayrollTaxBracket,
  PayrollRun,
  Payslip,
  PayslipLine,
  AssetCategory,
  FixedAsset,
  DepreciationRun,
  DepreciationLine,
  Budget,
  BudgetLine,
  OutboxItem,
  SyncMeta,
  BaseEntity
} from '../types/database';

export class CashERPDatabase extends Dexie {
  // 66 Mirrored Postgres Tables
  roles!: Table<Role, string>;
  role_permissions!: Table<RolePermission, string>;
  profiles!: Table<Profile, string>;
  devices!: Table<Device, string>;
  company_settings!: Table<CompanySettings, string>;
  fiscal_years!: Table<FiscalYear, string>;
  fiscal_periods!: Table<FiscalPeriod, string>;
  currencies!: Table<Currency, string>;
  exchange_rates!: Table<ExchangeRate, string>;
  accounts!: Table<Account, string>;
  cost_centers!: Table<CostCenter, string>;
  account_mappings!: Table<AccountMapping, string>;
  journal_entries!: Table<JournalEntry, string>;
  journal_lines!: Table<JournalLine, string>;
  parties!: Table<Party, string>;
  tax_codes!: Table<TaxCode, string>;
  units!: Table<Unit, string>;
  item_categories!: Table<ItemCategory, string>;
  items!: Table<Item, string>;
  item_units!: Table<ItemUnit, string>;
  item_barcodes!: Table<ItemBarcode, string>;
  warehouses!: Table<Warehouse, string>;
  documents!: Table<Document, string>;
  document_lines!: Table<DocumentLine, string>;
  stock_movements!: Table<StockMovement, string>;
  treasury_accounts!: Table<TreasuryAccount, string>;
  payments!: Table<Payment, string>;
  payment_allocations!: Table<PaymentAllocation, string>;
  cheques!: Table<Cheque, string>;
  bank_reconciliations!: Table<BankReconciliation, string>;
  reconciliation_items!: Table<ReconciliationItem, string>;
  audit_log!: Table<AuditLog, string>;
  sync_conflicts!: Table<SyncConflict, string>;
  branches!: Table<Branch, string>;
  user_branches!: Table<UserBranch, string>;
  price_lists!: Table<PriceList, string>;
  price_list_items!: Table<PriceListItem, string>;
  number_series!: Table<NumberSeries, string>;
  print_templates!: Table<PrintTemplate, string>;
  settings_kv!: Table<SettingsKv, string>;
  attachments!: Table<Attachment, string>;
  notifications!: Table<Notification, string>;
  eta_settings!: Table<EtaSettings, string>;
  eta_item_codes!: Table<EtaItemCode, string>;
  eta_submissions!: Table<EtaSubmission, string>;
  pos_terminals!: Table<PosTerminal, string>;
  pos_shifts!: Table<PosShift, string>;
  pos_cash_movements!: Table<PosCashMovement, string>;
  document_payments!: Table<DocumentPayment, string>;
  installment_plans!: Table<InstallmentPlan, string>;
  installments!: Table<Installment, string>;
  departments!: Table<Department, string>;
  employees!: Table<Employee, string>;
  pay_components!: Table<PayComponent, string>;
  employee_components!: Table<EmployeeComponent, string>;
  employee_loans!: Table<EmployeeLoan, string>;
  payroll_tax_brackets!: Table<PayrollTaxBracket, string>;
  payroll_runs!: Table<PayrollRun, string>;
  payslips!: Table<Payslip, string>;
  payslip_lines!: Table<PayslipLine, string>;
  asset_categories!: Table<AssetCategory, string>;
  fixed_assets!: Table<FixedAsset, string>;
  depreciation_runs!: Table<DepreciationRun, string>;
  depreciation_lines!: Table<DepreciationLine, string>;
  budgets!: Table<Budget, string>;
  budget_lines!: Table<BudgetLine, string>;

  // Client-only tables
  outbox!: Table<OutboxItem, string>;
  sync_meta!: Table<SyncMeta, string>;

  constructor() {
    super('CashERPDatabase');

    this.version(1).stores({
      // Security & Company
      roles: 'id, name, server_seq',
      role_permissions: 'id, role_id, [role_id+module+action], server_seq',
      profiles: 'id, role_id, is_active, server_seq',
      devices: 'id, user_id, series_code, branch_id, server_seq',
      company_settings: 'id, server_seq',
      branches: 'id, code, is_main, is_active, server_seq',
      user_branches: 'id, user_id, branch_id, [user_id+branch_id], server_seq',
      settings_kv: 'id, [scope+scope_id+key], server_seq',

      // Accounting
      fiscal_years: 'id, status, start_date, end_date, server_seq',
      fiscal_periods: 'id, fiscal_year_id, status, start_date, end_date, server_seq',
      currencies: 'id, code, server_seq',
      exchange_rates: 'id, [currency_code+rate_date], server_seq',
      accounts: 'id, code, parent_id, type, normal_side, is_postable, is_active, server_seq',
      cost_centers: 'id, code, parent_id, is_active, server_seq',
      account_mappings: 'id, key, account_id, server_seq',
      journal_entries: 'id, [series_code+seq_no], entry_no, entry_date, status, branch_id, server_seq',
      journal_lines: 'id, entry_id, account_id, party_id, cost_center_id, server_seq',

      // Parties & Inventory
      parties: 'id, code, is_customer, is_supplier, is_active, price_list_id, server_seq',
      tax_codes: 'id, code, kind, server_seq',
      units: 'id, name_ar, eta_code, server_seq',
      item_categories: 'id, parent_id, server_seq',
      items: 'id, sku, category_id, is_active, is_stocked, tracking, server_seq',
      item_units: 'id, [item_id+unit_id], server_seq',
      item_barcodes: 'id, barcode, item_id, server_seq',
      warehouses: 'id, code, branch_id, is_active, server_seq',
      stock_movements: 'id, item_id, warehouse_id, movement_date, movement_type, lot_no, server_seq',
      price_lists: 'id, kind, is_default, server_seq',
      price_list_items: 'id, price_list_id, [price_list_id+item_id+unit_id+min_qty], server_seq',

      // Documents & Treasury
      documents: 'id, doc_type, [doc_type+series_code+seq_no], doc_no, doc_date, party_id, warehouse_id, branch_id, status, pos_shift_id, server_seq',
      document_lines: 'id, document_id, [document_id+line_no], item_id, server_seq',
      document_payments: 'id, document_id, method, server_seq',
      treasury_accounts: 'id, kind, gl_account_id, branch_id, is_active, server_seq',
      payments: 'id, voucher_type, [voucher_type+series_code+seq_no], voucher_no, voucher_date, party_id, treasury_account_id, status, branch_id, server_seq',
      payment_allocations: 'id, payment_id, document_id, installment_id, server_seq',
      cheques: 'id, direction, cheque_no, due_date, party_id, status, server_seq',
      bank_reconciliations: 'id, treasury_account_id, statement_date, status, server_seq',
      reconciliation_items: 'id, reconciliation_id, journal_line_id, server_seq',

      // Installments & POS
      installment_plans: 'id, document_id, server_seq',
      installments: 'id, plan_id, [plan_id+seq], due_date, server_seq',
      pos_terminals: 'id, branch_id, is_active, server_seq',
      pos_shifts: 'id, terminal_id, cashier_id, status, server_seq',
      pos_cash_movements: 'id, shift_id, kind, server_seq',

      // ETA
      eta_settings: 'id, server_seq',
      eta_item_codes: 'id, item_id, [item_id+code_type], server_seq',
      eta_submissions: 'id, document_id, internal_id, status, next_retry_at, server_seq',

      // HR & Payroll
      departments: 'id, name_ar, server_seq',
      employees: 'id, code, department_id, branch_id, is_active, server_seq',
      pay_components: 'id, code, kind, server_seq',
      employee_components: 'id, [employee_id+component_id], server_seq',
      employee_loans: 'id, employee_id, status, server_seq',
      payroll_tax_brackets: 'id, effective_from, server_seq',
      payroll_runs: 'id, [branch_id+pay_year+pay_month], status, server_seq',
      payslips: 'id, run_id, [run_id+employee_id], server_seq',
      payslip_lines: 'id, payslip_id, server_seq',

      // Fixed Assets & Budgets
      asset_categories: 'id, server_seq',
      fixed_assets: 'id, code, category_id, branch_id, status, server_seq',
      depreciation_runs: 'id, period_id, status, server_seq',
      depreciation_lines: 'id, run_id, [run_id+asset_id], server_seq',
      budgets: 'id, fiscal_year_id, branch_id, server_seq',
      budget_lines: 'id, budget_id, [budget_id+account_id+period_id], server_seq',

      // Supporting Infrastructure
      number_series: 'id, [doc_type+branch_id], server_seq',
      print_templates: 'id, doc_type, server_seq',
      attachments: 'id, [entity+entity_id], local_only, server_seq',
      notifications: 'id, user_id, read_at, server_seq',
      audit_log: 'id, user_id, [entity+entity_id], server_seq',
      sync_conflicts: 'id, entity, entity_id, resolved_at, server_seq',

      // Client Outbox & Meta
      outbox: 'id, op_id, entity, entity_id, status, client_ts',
      sync_meta: 'key',
    });
  }

  /**
   * Safe Local Upsert Rule:
   * 1. Never overwrite a local row that has pending outbox operations -> Route to sync_conflicts.
   * 2. Strict sequence comparison: NO 'OR' between server_seq and version.
   */
  async safeApplyServerRow<T extends BaseEntity>(table: Table<T, string>, serverRow: T): Promise<'applied' | 'conflict' | 'skipped'> {
    // 1. Check for pending outbox changes on this entity
    const pendingOutboxCount = await this.outbox
      .where('entity').equals(table.name)
      .and(op => op.entity_id === serverRow.id && (op.status === 'pending' || op.status === 'in_flight'))
      .count();

    const localRow = await table.get(serverRow.id);

    if (pendingOutboxCount > 0) {
      // Conflict: incoming server row collides with un-synced local changes
      await this.sync_conflicts.put({
        id: crypto.randomUUID(),
        entity: table.name,
        entity_id: serverRow.id,
        local_payload: (localRow as Record<string, any>) || {},
        server_payload: serverRow as Record<string, any>,
        base_version: localRow?.version || 1,
        version: 1,
        server_seq: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        resolution: null,
        resolved_at: null,
        resolved_by: null,
      });
      return 'conflict';
    }

    // 2. Strict sequence check: Only apply if server_seq is strictly greater than local
    if (!localRow || serverRow.server_seq > localRow.server_seq) {
      await table.put(serverRow);
      return 'applied';
    }

    return 'skipped';
  }
}

export const db = new CashERPDatabase();
