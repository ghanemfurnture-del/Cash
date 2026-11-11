import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from '../src/db';
import {
  BACKUP_ERRORS,
  decryptBackupPayload,
  encryptBackupPayload,
} from '../src/services/backup/crypto';
import {
  buildBackupPayload,
  exportEncryptedBackup,
} from '../src/services/backup/backupService';
import {
  inspectBackupFile,
  executeRestore,
} from '../src/services/backup/restoreService';
import {
  getPersistenceStatus,
  isIosDevice,
  isStandalonePwa,
  requestPersistentStorage,
} from '../src/services/backup/persistenceService';
import {
  CORE_BACKUP_TABLES,
  CURRENT_FORMAT_VERSION,
  CURRENT_SCHEMA_VERSION,
  type BackupPayload,
} from '../src/services/backup/types';

// Fast iteration count for test suite performance; one test verifies full 600,000 iterations
const TEST_ITERATIONS = 1000;

describe('Phase 2b-3b: Encrypted Backup, Restore with Preview, & Storage Persistence', () => {
  beforeEach(async () => {
    // Clear all tables before each test
    for (const t of CORE_BACKUP_TABLES) {
      await (db as any)[t]?.clear();
    }
    await db.outbox.clear();
    await db.sync_meta.clear();
  });

  // --------------------------------------------------------------------------
  // 1. ROUND-TRIP EQUALITY (13 TABLES + OUTBOX + SYNC_META)
  // --------------------------------------------------------------------------
  it('round-trip equality: exports and restores all 13 core mirrored tables + outbox + sync_meta', async () => {
    // Seed test data in each of the 13 core tables
    const branch = {
      id: '00000000-0000-0000-0000-000000000001',
      code: 'MAIN',
      name_ar: 'الفرع الرئيسي',
      is_main: true,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 1,
    };
    await db.branches.put(branch);

    const account = {
      id: '00000000-0000-0000-0000-000000000002',
      code: '10101',
      name_ar: 'الصندوق الرئيسي',
      type: 'asset' as const,
      normal_side: 'debit' as const,
      is_postable: true,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 2,
    };
    await db.accounts.put(account);

    const costCenter = {
      id: '00000000-0000-0000-0000-000000000003',
      code: 'CC1',
      name_ar: 'إدارة المبيعات',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 3,
    };
    await db.cost_centers.put(costCenter);

    const taxCode = {
      id: '00000000-0000-0000-0000-000000000004',
      code: 'VAT14',
      name_ar: 'ضريبة القيمة المضافة 14%',
      rate: '14.0000',
      kind: 'vat' as const,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 4,
    };
    await db.tax_codes.put(taxCode);

    const unit = {
      id: '00000000-0000-0000-0000-000000000005',
      name_ar: 'قطعة',
      eta_code: 'EA',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 5,
    };
    await db.units.put(unit);

    const currency = {
      id: '00000000-0000-0000-0000-000000000006',
      code: 'EGP',
      name_ar: 'جنيه مصري',
      symbol: 'ج.م',
      is_base: true,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 6,
    };
    await db.currencies.put(currency);

    const party = {
      id: '00000000-0000-0000-0000-000000000007',
      code: 'CUST-001',
      name_ar: 'شركة النيل للتوزيع',
      is_customer: true,
      is_supplier: false,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 7,
    };
    await db.parties.put(party);

    const item = {
      id: '00000000-0000-0000-0000-000000000008',
      sku: 'SKU-001',
      name_ar: 'منتج أ تجريبي',
      tracking: 'none' as const,
      is_stocked: true,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 8,
    };
    await db.items.put(item);

    const warehouse = {
      id: '00000000-0000-0000-0000-000000000009',
      branch_id: branch.id,
      code: 'WH-01',
      name_ar: 'المستودع الرئيسي',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 9,
    };
    await db.warehouses.put(warehouse);

    const journalEntry = {
      id: '00000000-0000-0000-0000-000000000010',
      branch_id: branch.id,
      series_code: 'D1',
      seq_no: 1,
      entry_no: 'JE-D1-000001',
      entry_date: '2026-11-04',
      status: 'posted' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 10,
    };
    await db.journal_entries.put(journalEntry);

    const journalLine = {
      id: '00000000-0000-0000-0000-000000000011',
      entry_id: journalEntry.id,
      account_id: account.id,
      debit: '1000.0000',
      credit: '0.0000',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 11,
    };
    await db.journal_lines.put(journalLine);

    const document = {
      id: '00000000-0000-0000-0000-000000000012',
      branch_id: branch.id,
      doc_type: 'sales_invoice' as const,
      series_code: 'D1',
      seq_no: 1,
      doc_no: 'INV-D1-000001',
      doc_date: '2026-11-04',
      party_id: party.id,
      warehouse_id: warehouse.id,
      status: 'posted' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 12,
    };
    await db.documents.put(document);

    const documentLine = {
      id: '00000000-0000-0000-0000-000000000013',
      document_id: document.id,
      item_id: item.id,
      line_no: 1,
      quantity: '2.0000',
      unit_price: '500.0000',
      total: '1000.0000',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 13,
    };
    await db.document_lines.put(documentLine);

    // Seed outbox
    const outboxOp = {
      id: '00000000-0000-0000-0000-000000000014',
      op_id: '00000000-0000-0000-0000-000000000015',
      client_ts: new Date().toISOString(),
      entity: 'documents',
      entity_id: document.id,
      op_type: 'insert' as const,
      payload: { header: document, lines: [documentLine] },
      status: 'pending' as const,
      retry_count: 0,
      created_at: new Date().toISOString(),
    };
    await db.outbox.put(outboxOp);

    // Seed allowed sync_meta
    await db.sync_meta.put({
      key: 'general_company_note',
      value: 'ملاحظة عامة للمنشأة',
      updated_at: new Date().toISOString(),
    });

    // 1. Export to encrypted buffer
    const password = 'StrongPassword123!';
    const encryptedBytes = await exportEncryptedBackup(password, {
      iterations: TEST_ITERATIONS,
    });
    expect(encryptedBytes.byteLength).toBeGreaterThan(39);

    // 2. Clear entire database
    for (const t of CORE_BACKUP_TABLES) {
      await (db as any)[t].clear();
    }
    await db.outbox.clear();
    await db.sync_meta.clear();

    // Verify database is completely empty
    expect(await db.branches.count()).toBe(0);
    expect(await db.documents.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);

    // 3. Inspect and Preview
    const preview = await inspectBackupFile(encryptedBytes, password, {
      iterations: TEST_ITERATIONS,
    });
    expect(preview.metadata.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(preview.metadata.format_version).toBe(CURRENT_FORMAT_VERSION);
    expect(preview.metadata.record_counts['documents']).toBe(1);

    // 4. Execute Restore
    await executeRestore(preview);

    // 5. Assert all 13 tables + outbox + sync_meta are accurately restored
    const restoredBranch = await db.branches.get(branch.id);
    expect(restoredBranch?.code).toBe('MAIN');

    const restoredAccount = await db.accounts.get(account.id);
    expect(restoredAccount?.code).toBe('10101');

    const restoredCostCenter = await db.cost_centers.get(costCenter.id);
    expect(restoredCostCenter?.code).toBe('CC1');

    const restoredTaxCode = await db.tax_codes.get(taxCode.id);
    expect(restoredTaxCode?.code).toBe('VAT14');

    const restoredUnit = await db.units.get(unit.id);
    expect(restoredUnit?.name_ar).toBe('قطعة');

    const restoredCurrency = await db.currencies.get(currency.id);
    expect(restoredCurrency?.code).toBe('EGP');

    const restoredParty = await db.parties.get(party.id);
    expect(restoredParty?.code).toBe('CUST-001');

    const restoredItem = await db.items.get(item.id);
    expect(restoredItem?.sku).toBe('SKU-001');

    const restoredWarehouse = await db.warehouses.get(warehouse.id);
    expect(restoredWarehouse?.code).toBe('WH-01');

    const restoredJe = await db.journal_entries.get(journalEntry.id);
    expect(restoredJe?.entry_no).toBe('JE-D1-000001');

    const restoredJl = await db.journal_lines.get(journalLine.id);
    expect(restoredJl?.debit).toBe('1000.0000');

    const restoredDoc = await db.documents.get(document.id);
    expect(restoredDoc?.doc_no).toBe('INV-D1-000001');

    const restoredDl = await db.document_lines.get(documentLine.id);
    expect(restoredDl?.total).toBe('1000.0000');

    const restoredOutbox = await db.outbox.get(outboxOp.id);
    expect(restoredOutbox?.entity).toBe('documents');

    const restoredMeta = await db.sync_meta.get('general_company_note');
    expect(restoredMeta?.value).toBe('ملاحظة عامة للمنشأة');
  });

  // --------------------------------------------------------------------------
  // 2. CRYPTOGRAPHIC INTEGRITY & REJECTION CASES
  // --------------------------------------------------------------------------
  it('rejects wrong password with exact Arabic message and leaves database untouched (0%)', async () => {
    await db.branches.put({
      id: '00000000-0000-0000-0000-000000000001',
      code: 'EXISTING',
      name_ar: 'فرع قائم',
      is_main: true,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 1,
    });

    const encrypted = await exportEncryptedBackup('CorrectPassword123!', {
      iterations: TEST_ITERATIONS,
    });

    // Attempt with wrong password
    await expect(
      inspectBackupFile(encrypted, 'WrongPassword999!', {
        iterations: TEST_ITERATIONS,
      })
    ).rejects.toThrow(BACKUP_ERRORS.WRONG_PASSWORD);

    // Database is 100% untouched
    const branch = await db.branches.get('00000000-0000-0000-0000-000000000001');
    expect(branch?.code).toBe('EXISTING');
  });

  it('rejects tampered ciphertext with exact Arabic message', async () => {
    const encrypted = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // Tamper with one byte in the ciphertext body (offset 45)
    encrypted[45] ^= 0xff;

    await expect(
      inspectBackupFile(encrypted, 'Secret123!', {
        iterations: TEST_ITERATIONS,
      })
    ).rejects.toThrow(BACKUP_ERRORS.WRONG_PASSWORD);
  });

  it('rejects tampered magic bytes with exact Arabic message', async () => {
    const encrypted = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // Corrupt magic byte 0 ("C" -> "X")
    encrypted[0] = 0x58; // 'X'

    await expect(
      inspectBackupFile(encrypted, 'Secret123!', {
        iterations: TEST_ITERATIONS,
      })
    ).rejects.toThrow(BACKUP_ERRORS.INVALID_FORMAT);
  });

  it('rejects truncated file shorter than 39-byte header with exact Arabic message', async () => {
    const truncated = new Uint8Array([0x43, 0x41, 0x53, 0x48]); // Only 4 bytes

    await expect(
      inspectBackupFile(truncated, 'Secret123!', {
        iterations: TEST_ITERATIONS,
      })
    ).rejects.toThrow(BACKUP_ERRORS.TRUNCATED_FILE);
  });

  it('rejects unsupported format version (format_version > 1)', async () => {
    const payload = JSON.stringify({ metadata: {}, data: {} });
    const encrypted = await encryptBackupPayload(payload, 'Secret123!', {
      iterations: TEST_ITERATIONS,
      formatVersion: 2, // Unsupported format
    });

    await expect(
      inspectBackupFile(encrypted, 'Secret123!', {
        iterations: TEST_ITERATIONS,
      })
    ).rejects.toThrow(BACKUP_ERRORS.UNSUPPORTED_FORMAT_VERSION);
  });

  it('rejects unsupported schema version (schema_version > 7)', async () => {
    const payload = JSON.stringify({ metadata: {}, data: {} });
    const encrypted = await encryptBackupPayload(payload, 'Secret123!', {
      iterations: TEST_ITERATIONS,
      schemaVersion: 8, // Unsupported schema version
    });

    await expect(
      inspectBackupFile(encrypted, 'Secret123!', {
        iterations: TEST_ITERATIONS,
      })
    ).rejects.toThrow(BACKUP_ERRORS.UNSUPPORTED_SCHEMA_VERSION);
  });

  // --------------------------------------------------------------------------
  // 3. SAFETY SNAPSHOT & ATOMICITY
  // --------------------------------------------------------------------------
  it('aborts immediately on safety snapshot failure and leaves local data 100% untouched', async () => {
    // Current local data
    const localDoc = {
      id: '00000000-0000-0000-0000-000000000099',
      branch_id: '00000000-0000-0000-0000-000000000001',
      doc_type: 'sales_invoice' as const,
      series_code: 'D1',
      seq_no: 42,
      doc_no: 'INV-D1-000042',
      doc_date: '2026-11-04',
      status: 'draft' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 42,
    };
    await db.documents.put(localDoc);

    const encrypted = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });
    const preview = await inspectBackupFile(encrypted, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // Execute with simulated snapshot failure (e.g. QuotaExceeded on iOS Safari)
    await expect(
      executeRestore(preview, { simulateSnapshotFailure: true })
    ).rejects.toThrow(BACKUP_ERRORS.SAFETY_SNAPSHOT_FAILED);

    // Assert local document is untouched
    const docAfter = await db.documents.get(localDoc.id);
    expect(docAfter?.seq_no).toBe(42);
    expect(docAfter?.doc_no).toBe('INV-D1-000042');
  });

  it('cleans up cash_safety_snapshot_temp and preserves cause when snapshot write fails inside try block', async () => {
    const localDoc = {
      id: '00000000-0000-0000-0000-000000000099',
      branch_id: '00000000-0000-0000-0000-000000000001',
      doc_type: 'sales_invoice' as const,
      series_code: 'D1',
      seq_no: 42,
      doc_no: 'INV-D1-000042',
      doc_date: '2026-11-04',
      status: 'draft' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 42,
    };
    await db.documents.put(localDoc);

    const encrypted = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });
    const preview = await inspectBackupFile(encrypted, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    const injectedWriteError = new DOMException(
      'QuotaExceededError: simulated snapshot write failure',
      'QuotaExceededError'
    );
    const origOpen = Dexie.prototype.open;
    const openSpy = vi.spyOn(Dexie.prototype, 'open').mockImplementation(function (this: Dexie) {
      if (this.name === 'cash_safety_snapshot_temp') {
        return origOpen.call(this).then((openedDb) => {
          const docsTable = (
            openedDb as unknown as Record<string, { bulkPut?: (...args: unknown[]) => Promise<unknown> }>
          ).documents;
          if (docsTable) {
            docsTable.bulkPut = async () => {
              throw injectedWriteError;
            };
          }
          return openedDb;
        });
      }
      return origOpen.call(this);
    });
    const deleteSpy = vi.spyOn(Dexie, 'delete');

    try {
      let caughtError: unknown;
      try {
        await executeRestore(preview);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe(BACKUP_ERRORS.SAFETY_SNAPSHOT_FAILED);
      expect((caughtError as Error & { cause?: unknown }).cause).toBe(injectedWriteError);
      expect(deleteSpy).toHaveBeenCalledWith('cash_safety_snapshot_temp');
    } finally {
      openSpy.mockRestore();
      deleteSpy.mockRestore();
    }

    expect(await Dexie.exists('cash_safety_snapshot_temp')).toBe(false);

    const docAfter = await db.documents.get(localDoc.id);
    expect(docAfter?.seq_no).toBe(42);
    expect(docAfter?.doc_no).toBe('INV-D1-000042');
  });

  // --------------------------------------------------------------------------
  // 4. SCENARIO D1 -> D1 (SAME DEVICE RESTORE & SEQUENCE COUNTER MAX RULE)
  // --------------------------------------------------------------------------
  it('Scenario D1 -> D1: Restoring old backup on same device advances/preserves sequence counter to max and prevents duplicate numbers', async () => {
    // 1. D1 creates invoices 1..100
    for (let i = 1; i <= 5; i++) {
      await db.documents.put({
        id: `00000000-0000-0000-0000-0000000000${10 + i}`,
        branch_id: '00000000-0000-0000-0000-000000000001',
        doc_type: 'sales_invoice' as const,
        series_code: 'D1',
        seq_no: i * 20, // 20, 40, 60, 80, 100
        doc_no: `INV-D1-0000${i * 20}`,
        doc_date: '2026-11-04',
        status: 'posted' as const,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
        server_seq: i,
      });
    }

    // 2. Export Backup at invoice 100
    const backupAt100 = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // 3. D1 continues working offline and issues invoices up to 150
    await db.documents.put({
      id: '00000000-0000-0000-0000-000000000150',
      branch_id: '00000000-0000-0000-0000-000000000001',
      doc_type: 'sales_invoice' as const,
      series_code: 'D1',
      seq_no: 150,
      doc_no: 'INV-D1-000150',
      doc_date: '2026-11-04',
      status: 'posted' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 50,
    });
    await db.sync_meta.put({
      key: 'counter:sales_invoice:D1',
      value: 150,
      updated_at: new Date().toISOString(),
    });

    // 4. Restore the older backup (which only has up to 100)
    const preview = await inspectBackupFile(backupAt100, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });
    await executeRestore(preview);

    // 5. Verify the counter rule: new_seq = max(current_local=150, restored_max=100) = 150
    const counterMeta = await db.sync_meta.get('counter:sales_invoice:D1');
    expect(counterMeta?.value).toBe(150);
  });

  // --------------------------------------------------------------------------
  // 5. SCENARIO D1 -> D2 (DIFFERENT DEVICE RESTORE PRESERVES RESTORING IDENTITY)
  // --------------------------------------------------------------------------
  it('Scenario D1 -> D2: Preserves restoring device identity and does not overwrite device series', async () => {
    // Restoring device D2 has its own identity
    await db.sync_meta.put({
      key: 'device_id',
      value: 'DEVICE-002-ID',
      updated_at: new Date().toISOString(),
    });
    await db.sync_meta.put({
      key: 'series_code',
      value: 'D2',
      updated_at: new Date().toISOString(),
    });

    // Create a backup on D1
    const backupFromD1 = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
      sourceDeviceId: 'DEVICE-001-ID',
      sourceDeviceCode: 'D1',
    });

    // Restore on D2
    const preview = await inspectBackupFile(backupFromD1, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });
    await executeRestore(preview);

    // Assert D2 kept its own device_id and series_code
    const deviceId = await db.sync_meta.get('device_id');
    const seriesCode = await db.sync_meta.get('series_code');
    expect(deviceId?.value).toBe('DEVICE-002-ID');
    expect(seriesCode?.value).toBe('D2');
  });

  // --------------------------------------------------------------------------
  // 6. UNSYNCED LOCAL WORK DETECTION & EXPLICIT CONFIRMATION
  // --------------------------------------------------------------------------
  it('detects unsynced local outbox and documents before restore', async () => {
    // 1. Create an empty backup before adding new local work
    const emptyBackup = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // 2. Current local state has pending outbox operations
    await db.outbox.put({
      id: '00000000-0000-0000-0000-000000000001',
      op_id: '00000000-0000-0000-0000-000000000002',
      client_ts: new Date().toISOString(),
      entity: 'documents',
      entity_id: '00000000-0000-0000-0000-000000000003',
      op_type: 'insert',
      payload: {},
      status: 'pending',
      retry_count: 0,
      created_at: new Date().toISOString(),
    });

    // And a local invoice not in the backup
    await db.documents.put({
      id: '00000000-0000-0000-0000-000000000003',
      branch_id: '00000000-0000-0000-0000-000000000001',
      doc_type: 'sales_invoice',
      series_code: 'D1',
      seq_no: 999,
      doc_no: 'INV-D1-000999',
      doc_date: '2026-11-04',
      status: 'draft',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      server_seq: 999,
    });

    const preview = await inspectBackupFile(emptyBackup, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // Assert preview flags unsynced work
    expect(preview.requiresExplicitConfirmation).toBe(true);
    expect(preview.unsyncedWork.outboxCount).toBe(1);
    expect(preview.unsyncedWork.unsyncedDocCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 7. STORAGE PERSISTENCE API & iOS SAFARI DETECTION
  // --------------------------------------------------------------------------
  it('storage persistence helper returns status and detects storage properties', async () => {
    const status = await getPersistenceStatus();
    expect(typeof status.isPersisted).toBe('boolean');
    expect(typeof status.isStandalone).toBe('boolean');
    expect(typeof status.isIosSafari).toBe('boolean');
    expect(typeof status.usageBytes).toBe('number');

    const requested = await requestPersistentStorage();
    expect(typeof requested).toBe('boolean');
  });

  // --------------------------------------------------------------------------
  // 8. OWASP 600,000 ITERATIONS BENCHMARK VERIFICATION
  // --------------------------------------------------------------------------
  it('verifies OWASP 600,000 iterations encryption and decryption succeeds', async () => {
    const payload = JSON.stringify({ test: 'owasp_600k_success' });
    const encrypted = await encryptBackupPayload(payload, 'OwaspPassword123!', {
      iterations: 600_000,
    });
    const decrypted = await decryptBackupPayload(encrypted, 'OwaspPassword123!', {
      iterations: 600_000,
    });
    expect(JSON.parse(decrypted)).toEqual({ test: 'owasp_600k_success' });
  });

  // --------------------------------------------------------------------------
  // 9. SECURITY: EXCLUSION OF AUTH SESSION TOKENS AND CREDENTIALS
  // --------------------------------------------------------------------------
  it('strictly excludes auth session tokens (sb-*-auth-token) and credentials from exported file', async () => {
    // Put fake secret session tokens in storage
    const fakeJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-jwt-token';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sb-cash-auth-token', fakeJwt);
      localStorage.setItem('cash_erp_validated_session', JSON.stringify({ token: fakeJwt }));
    }

    const encrypted = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });
    const decrypted = await decryptBackupPayload(encrypted, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    // Verify token does not appear anywhere in decrypted JSON payload
    expect(decrypted).not.toContain(fakeJwt);
    expect(decrypted).not.toContain('super-secret-jwt-token');

    // Clean up
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('sb-cash-auth-token');
      localStorage.removeItem('cash_erp_validated_session');
    }
  });

  // --------------------------------------------------------------------------
  // 10. PRESERVATION OF SYNC_CONFLICTS
  // --------------------------------------------------------------------------
  it('backs up and restores sync_conflicts to prevent silent loss of unresolved conflict records', async () => {
    const conflict = {
      id: '00000000-0000-0000-0000-000000000099',
      entity: 'documents',
      entity_id: '00000000-0000-0000-0000-000000000012',
      local_payload: { status: 'posted', total: '1000' },
      server_payload: { status: 'draft', total: '800' },
      base_version: 1,
      version: 2,
      server_seq: 15,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolution: null,
      resolved_at: null,
      resolved_by: null,
    };
    await db.sync_conflicts.put(conflict);

    const encrypted = await exportEncryptedBackup('Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    await db.sync_conflicts.clear();
    expect(await db.sync_conflicts.count()).toBe(0);

    const preview = await inspectBackupFile(encrypted, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });
    await executeRestore(preview);

    const restoredConflict = await db.sync_conflicts.get(conflict.id);
    expect(restoredConflict).toBeDefined();
    expect(restoredConflict?.entity).toBe('documents');
    expect(restoredConflict?.local_payload.total).toBe('1000');
  });

  // --------------------------------------------------------------------------
  // 11. SCHEMA UPGRADE PATH (schema_version < 7)
  // --------------------------------------------------------------------------
  it('upgrades older schema payloads (e.g. schema_version 6) smoothly without rejection', async () => {
    const legacyPayload: BackupPayload = {
      metadata: {
        backup_created_at: new Date().toISOString(),
        source_device_id: 'DEV-LEGACY',
        source_device_code: 'D1',
        source_branch_id: 'BRANCH-1',
        app_version: '0.9.0',
        schema_version: 6, // Older schema version
        format_version: 1,
        record_counts: {},
      },
      data: {
        parties: [
          {
            id: '00000000-0000-0000-0000-000000000001',
            code: 'CUST-LEGACY',
            name_ar: 'عميل قديم',
            is_customer: true,
            is_supplier: false,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            // Missing version and server_seq in older schema
          },
        ],
      },
      outbox: [],
      sync_meta: [],
    };

    const encrypted = await encryptBackupPayload(
      JSON.stringify(legacyPayload),
      'Secret123!',
      {
        iterations: TEST_ITERATIONS,
        schemaVersion: 6,
      }
    );

    const preview = await inspectBackupFile(encrypted, 'Secret123!', {
      iterations: TEST_ITERATIONS,
    });

    expect(preview.metadata.schema_version).toBe(7);
    expect(preview.payload.data['parties'][0].version).toBe(1);
    expect(preview.payload.data['parties'][0].server_seq).toBe(0);

    await executeRestore(preview);

    const restoredParty = await db.parties.get('00000000-0000-0000-0000-000000000001');
    expect(restoredParty?.code).toBe('CUST-LEGACY');
  });
});
