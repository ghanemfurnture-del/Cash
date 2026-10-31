import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import type { Party } from '../src/types/database';

describe('Local Database (Dexie 66 Mirrored Tables & Upsert Engine)', () => {
  beforeEach(async () => {
    await db.parties.clear();
    await db.outbox.clear();
    await db.sync_conflicts.clear();
  });

  it('mirrors all 66 database contract tables + outbox + sync_meta', () => {
    const tableNames = db.tables.map((t) => t.name);

    // Expected exactly 66 tables from 001 + 002 + 2 client tables = 68
    expect(tableNames.length).toBe(68);

    // Critical accounting & sync tables
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('journal_entries');
    expect(tableNames).toContain('journal_lines');
    expect(tableNames).toContain('documents');
    expect(tableNames).toContain('document_lines');
    expect(tableNames).toContain('document_payments');
    expect(tableNames).toContain('stock_movements');
    expect(tableNames).toContain('treasury_accounts');
    expect(tableNames).toContain('payments');
    expect(tableNames).toContain('payment_allocations');
    expect(tableNames).toContain('cheques');
    expect(tableNames).toContain('bank_reconciliations');
    expect(tableNames).toContain('reconciliation_items');
    expect(tableNames).toContain('number_series');
    expect(tableNames).toContain('print_templates');
    expect(tableNames).toContain('branches');
    expect(tableNames).toContain('user_branches');
    expect(tableNames).toContain('pos_terminals');
    expect(tableNames).toContain('pos_shifts');
    expect(tableNames).toContain('pos_cash_movements');
    expect(tableNames).toContain('eta_settings');
    expect(tableNames).toContain('eta_item_codes');
    expect(tableNames).toContain('eta_submissions');
    expect(tableNames).toContain('employees');
    expect(tableNames).toContain('payroll_runs');
    expect(tableNames).toContain('payslips');
    expect(tableNames).toContain('fixed_assets');
    expect(tableNames).toContain('depreciation_runs');
    expect(tableNames).toContain('budgets');
    expect(tableNames).toContain('budget_lines');
    expect(tableNames).toContain('sync_conflicts');

    // Client outbox & metadata
    expect(tableNames).toContain('outbox');
    expect(tableNames).toContain('sync_meta');
  });

  it('applies server rows strictly when server_seq is higher (Condition 1 rule)', async () => {
    const partyId = crypto.randomUUID();

    const initialParty: Party = {
      id: partyId,
      code: 'CUST-001',
      name_ar: 'شركة الأمل للتجارة',
      is_customer: true,
      is_supplier: false,
      credit_limit: 50000,
      payment_terms_days: 30,
      is_active: true,
      country_code: 'EG',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 10,
    };

    // Apply initial row
    const result1 = await db.safeApplyServerRow(db.parties, initialParty);
    expect(result1).toBe('applied');

    const stored1 = await db.parties.get(partyId);
    expect(stored1?.name_ar).toBe('شركة الأمل للتجارة');

    // Incoming updated row from server with higher server_seq
    const updatedParty: Party = {
      ...initialParty,
      name_ar: 'شركة الأمل الدولية',
      server_seq: 25,
      version: 2,
    };

    const result2 = await db.safeApplyServerRow(db.parties, updatedParty);
    expect(result2).toBe('applied');

    const stored2 = await db.parties.get(partyId);
    expect(stored2?.name_ar).toBe('شركة الأمل الدولية');
  });

  it('skips incoming server row with lower server_seq regardless of version (no OR rule)', async () => {
    const partyId = crypto.randomUUID();

    const currentParty: Party = {
      id: partyId,
      code: 'CUST-002',
      name_ar: 'النسخة الحالية',
      is_customer: true,
      is_supplier: false,
      credit_limit: 10000,
      payment_terms_days: 0,
      is_active: true,
      country_code: 'EG',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 50,
    };
    await db.parties.put(currentParty);

    // Stale/out-of-order delivery with lower server_seq (30 < 50) even if version claims 99
    const staleServerRow: Party = {
      ...currentParty,
      name_ar: 'نسخة متأخرة قديمة',
      version: 99,
      server_seq: 30,
    };

    const result = await db.safeApplyServerRow(db.parties, staleServerRow);
    expect(result).toBe('skipped');

    // Value remains unchanged
    const stored = await db.parties.get(partyId);
    expect(stored?.name_ar).toBe('النسخة الحالية');
  });

  it('routes to sync_conflicts and NEVER overwrites local row with pending outbox changes', async () => {
    const partyId = crypto.randomUUID();

    const localParty: Party = {
      id: partyId,
      code: 'CUST-003',
      name_ar: 'العميل مع تعديل محلي أوفلاين',
      is_customer: true,
      is_supplier: false,
      credit_limit: 20000,
      payment_terms_days: 15,
      is_active: true,
      country_code: 'EG',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 15,
    };
    await db.parties.put(localParty);

    // Simulate an offline pending outbox operation on this party
    await db.outbox.put({
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: 'user-1',
      entity: 'parties',
      entity_id: partyId,
      op: 'update',
      payload: { name_ar: 'العميل مع تعديل محلي أوفلاين' },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    });

    // Server sends an update with higher server_seq
    const incomingServerParty: Party = {
      ...localParty,
      name_ar: 'تعديل وارد من السيرفر يتعارض مع الأوفلاين',
      server_seq: 40,
      version: 2,
    };

    const result = await db.safeApplyServerRow(db.parties, incomingServerParty);
    expect(result).toBe('conflict');

    // Verify local row was NOT overwritten
    const stored = await db.parties.get(partyId);
    expect(stored?.name_ar).toBe('العميل مع تعديل محلي أوفلاين');

    // Verify conflict record was created
    const conflictRecord = await db.sync_conflicts.where('entity_id').equals(partyId).first();
    expect(conflictRecord).toBeDefined();
    expect(conflictRecord?.entity).toBe('parties');
    expect(conflictRecord?.server_payload.name_ar).toBe('تعديل وارد من السيرفر يتعارض مع الأوفلاين');
  });
});

