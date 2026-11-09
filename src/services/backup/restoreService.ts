import Dexie from 'dexie';
import { db, CashERPDatabase } from '../../db';
import {
  CORE_BACKUP_TABLES,
  CURRENT_SCHEMA_VERSION,
  type BackupPayload,
  type RestorePreview,
  type TableComparison,
  type UnsyncedWorkSummary,
} from './types';
import { BACKUP_ERRORS, decryptBackupPayload, type DecryptOptions } from './crypto';
import { isProtectedSyncMetaKey } from './backupService';

export interface InspectOptions extends DecryptOptions {
  database?: CashERPDatabase;
}

export interface ExecuteRestoreOptions {
  database?: CashERPDatabase;
  simulateSnapshotFailure?: boolean;
}

/**
 * Temporary Dexie DB class used for atomic safety snapshot staging.
 */
class SafetySnapshotDatabase extends Dexie {
  constructor() {
    super('cash_safety_snapshot_temp');
    this.version(1).stores({
      branches: 'id',
      accounts: 'id',
      cost_centers: 'id',
      tax_codes: 'id',
      units: 'id',
      currencies: 'id',
      parties: 'id',
      items: 'id',
      warehouses: 'id',
      journal_entries: 'id',
      journal_lines: 'id',
      documents: 'id',
      document_lines: 'id',
      outbox: 'id',
      sync_meta: 'key',
      sync_conflicts: 'id',
    });
  }
}

/**
 * Upgrades older schema payloads to CURRENT_SCHEMA_VERSION (7).
 */
export function upgradeBackupPayloadSchema(payload: BackupPayload): BackupPayload {
  const schemaVer = payload.metadata.schema_version;
  if (schemaVer === CURRENT_SCHEMA_VERSION) {
    return payload;
  }
  if (schemaVer > CURRENT_SCHEMA_VERSION) {
    throw new Error(BACKUP_ERRORS.UNSUPPORTED_SCHEMA_VERSION);
  }

  // Schema upgrade path (e.g. from version 1..6 up to 7)
  if (!payload.data) payload.data = {};
  if (!payload.outbox) payload.outbox = [];
  if (!payload.sync_meta) payload.sync_meta = [];
  if (!payload.sync_conflicts) payload.sync_conflicts = [];

  for (const t of CORE_BACKUP_TABLES) {
    if (!payload.data[t]) {
      payload.data[t] = [];
    }
    for (const row of payload.data[t]) {
      if (row.version === undefined) row.version = 1;
      if (row.server_seq === undefined) row.server_seq = 0;
    }
  }

  payload.metadata.schema_version = CURRENT_SCHEMA_VERSION;
  return payload;
}

/**
 * Inspects a .cashbak file, decrypts it in-memory, validates it,
 * and produces a pre-restore preview with comparisons and unsynced work detection.
 */
export async function inspectBackupFile(
  bytes: Uint8Array,
  password: string,
  options?: InspectOptions
): Promise<RestorePreview> {
  const targetDb = options?.database ?? db;

  // 1. In-memory decryption and schema/format validation
  const plaintext = await decryptBackupPayload(bytes, password, options);

  let payload: BackupPayload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new Error(BACKUP_ERRORS.TRUNCATED_FILE);
  }

  if (!payload || !payload.metadata || !payload.data) {
    throw new Error(BACKUP_ERRORS.TRUNCATED_FILE);
  }

  // Schema upgrade path if needed
  payload = upgradeBackupPayloadSchema(payload);

  // 2. Table-by-table comparisons
  const tableComparisons: TableComparison[] = [];
  for (const tableName of CORE_BACKUP_TABLES) {
    const table = (targetDb as any)[tableName];
    const localCount = table ? await table.count() : 0;
    const backupCount = (payload.data[tableName] || []).length;
    tableComparisons.push({
      table: tableName,
      localCount,
      backupCount,
    });
  }

  const localOutboxCount = await targetDb.outbox.count();
  const backupOutboxCount = (payload.outbox || []).length;
  tableComparisons.push({
    table: 'outbox',
    localCount: localOutboxCount,
    backupCount: backupOutboxCount,
  });

  const localConflictsCount = await targetDb.sync_conflicts.count();
  const backupConflictsCount = (payload.sync_conflicts || []).length;
  tableComparisons.push({
    table: 'sync_conflicts',
    localCount: localConflictsCount,
    backupCount: backupConflictsCount,
  });

  // 3. Unsynced local work detection
  // Detect pending/in_flight outbox operations
  const pendingOutbox = await targetDb.outbox
    .filter((op) => op.status === 'pending' || op.status === 'in_flight' || op.status === 'failed')
    .toArray();

  // Detect local documents not present in the backup
  const backupDocIds = new Set((payload.data['documents'] || []).map((d: any) => d.id));
  const localDocs = await targetDb.documents.toArray();
  const unsyncedDocs = localDocs.filter((d) => !backupDocIds.has(d.id));

  const unsyncedItems: string[] = [];
  for (const op of pendingOutbox) {
    unsyncedItems.push(`عملية غير مرفوعة: ${op.entity} (${op.op_id.slice(0, 8)})`);
  }
  for (const d of unsyncedDocs) {
    unsyncedItems.push(
      `مستند محلي غير مشمول بالنسخة: ${d.doc_no || d.id} (مسلسل ${d.seq_no})`
    );
  }

  const unsyncedWork: UnsyncedWorkSummary = {
    outboxCount: pendingOutbox.length,
    unsyncedDocCount: unsyncedDocs.length,
    items: unsyncedItems,
  };

  const requiresExplicitConfirmation =
    unsyncedWork.outboxCount > 0 || unsyncedWork.unsyncedDocCount > 0;

  return {
    metadata: payload.metadata,
    tableComparisons,
    unsyncedWork,
    requiresExplicitConfirmation,
    payload,
  };
}

/**
 * Executes the restore protocol atomically:
 * 1. Takes an automatic safety snapshot in `cash_safety_snapshot_temp`.
 * 2. Swaps data in an atomic single Dexie transaction.
 * 3. Applies the sequence counter rule: new_seq_no = max(current_local, restored_max).
 * 4. Preserves restoring device identity.
 * 5. Cleans up safety snapshot on success; rolls back on failure.
 */
export async function executeRestore(
  preview: RestorePreview,
  options?: ExecuteRestoreOptions
): Promise<void> {
  const targetDb = options?.database ?? db;
  const payload = preview.payload;

  // 1. STEP 1: Automatic Safety Snapshot
  if (options?.simulateSnapshotFailure) {
    throw new Error(BACKUP_ERRORS.SAFETY_SNAPSHOT_FAILED);
  }

  let snapshotDb: SafetySnapshotDatabase | null = null;
  try {
    snapshotDb = new SafetySnapshotDatabase();
    await snapshotDb.open();

    // Copy all 13 core tables to snapshot DB
    for (const tableName of CORE_BACKUP_TABLES) {
      const table = (targetDb as any)[tableName];
      if (table) {
        const rows = await table.toArray();
        if (rows.length > 0) {
          await (snapshotDb as any)[tableName].bulkPut(rows);
        }
      }
    }

    // Copy outbox & sync_meta to snapshot DB
    const outboxRows = await targetDb.outbox.toArray();
    if (outboxRows.length > 0) {
      await snapshotDb.table('outbox').bulkPut(outboxRows);
    }

    const metaRows = await targetDb.sync_meta.toArray();
    if (metaRows.length > 0) {
      await snapshotDb.table('sync_meta').bulkPut(metaRows);
    }

    const conflictRows = await targetDb.sync_conflicts.toArray();
    if (conflictRows.length > 0) {
      await snapshotDb.table('sync_conflicts').bulkPut(conflictRows);
    }
  } catch (err: any) {
    if (snapshotDb) {
      snapshotDb.close();
      await Dexie.delete('cash_safety_snapshot_temp');
    }
    throw new Error(BACKUP_ERRORS.SAFETY_SNAPSHOT_FAILED, { cause: err });
  }

  // 2. STEP 2: Compute Maximum Sequence Numbers for each series
  // Rule: new_seq_no = max(current_local, restored_max)
  const localMaxMap = new Map<string, number>();

  // From existing local documents
  const currentLocalDocs = await targetDb.documents.toArray();
  for (const doc of currentLocalDocs) {
    const key = `${doc.doc_type}:${doc.series_code}`;
    const curr = localMaxMap.get(key) || 0;
    if (doc.seq_no > curr) {
      localMaxMap.set(key, doc.seq_no);
    }
  }

  // From existing sync_meta counter cache
  const existingMeta = await targetDb.sync_meta.toArray();
  for (const m of existingMeta) {
    if (m.key.startsWith('counter:')) {
      const key = m.key.replace('counter:', '');
      const val = Number(m.value) || 0;
      const curr = localMaxMap.get(key) || 0;
      if (val > curr) {
        localMaxMap.set(key, val);
      }
    }
  }

  // From incoming restored documents
  const restoredMaxMap = new Map<string, number>();
  const incomingDocs = payload.data['documents'] || [];
  for (const doc of incomingDocs) {
    const key = `${doc.doc_type}:${doc.series_code}`;
    const curr = restoredMaxMap.get(key) || 0;
    if (doc.seq_no > curr) {
      restoredMaxMap.set(key, doc.seq_no);
    }
  }

  // 3. STEP 3: Atomic Data Swap Transaction
  try {
    const tablesToLock = [
      ...CORE_BACKUP_TABLES.map((t) => (targetDb as any)[t]),
      targetDb.outbox,
      targetDb.sync_meta,
      targetDb.sync_conflicts,
    ].filter(Boolean);

    await targetDb.transaction('rw', tablesToLock, async () => {
      // Clear all 13 core tables
      for (const tableName of CORE_BACKUP_TABLES) {
        const table = (targetDb as any)[tableName];
        if (table) {
          await table.clear();
          const rows = payload.data[tableName] || [];
          if (rows.length > 0) {
            await table.bulkPut(rows);
          }
        }
      }

      // Restore outbox
      await targetDb.outbox.clear();
      if (payload.outbox && payload.outbox.length > 0) {
        await targetDb.outbox.bulkPut(payload.outbox);
      }

      // Restore allowed sync_meta (excluding protected keys)
      if (payload.sync_meta && payload.sync_meta.length > 0) {
        for (const meta of payload.sync_meta) {
          if (!isProtectedSyncMetaKey(meta.key)) {
            await targetDb.sync_meta.put(meta);
          }
        }
      }

      // Restore sync_conflicts
      await targetDb.sync_conflicts.clear();
      if (payload.sync_conflicts && payload.sync_conflicts.length > 0) {
        await targetDb.sync_conflicts.bulkPut(payload.sync_conflicts);
      }

      // Apply the Max Sequence Counter Rule
      const allSeriesKeys = new Set([...localMaxMap.keys(), ...restoredMaxMap.keys()]);
      for (const key of allSeriesKeys) {
        const localMax = localMaxMap.get(key) || 0;
        const restoredMax = restoredMaxMap.get(key) || 0;
        const newMax = Math.max(localMax, restoredMax);
        await targetDb.sync_meta.put({
          key: `counter:${key}`,
          value: newMax,
          updated_at: new Date().toISOString(),
        });
      }
    });

    // 4. STEP 4: Success Cleanup
    if (snapshotDb) {
      snapshotDb.close();
      await Dexie.delete('cash_safety_snapshot_temp');
    }
  } catch (txError: any) {
    // If transaction failed, attempt full rollback from safety snapshot
    if (snapshotDb) {
      try {
        const tablesToRestore = [
          ...CORE_BACKUP_TABLES.map((t) => (targetDb as any)[t]),
          targetDb.outbox,
          targetDb.sync_meta,
          targetDb.sync_conflicts,
        ].filter(Boolean);

        await targetDb.transaction('rw', tablesToRestore, async () => {
          for (const tableName of CORE_BACKUP_TABLES) {
            const table = (targetDb as any)[tableName];
            const snapshotTable = (snapshotDb as any)[tableName];
            if (table && snapshotTable) {
              await table.clear();
              const rows = await snapshotTable.toArray();
              if (rows.length > 0) {
                await table.bulkPut(rows);
              }
            }
          }
          await targetDb.outbox.clear();
          const outboxRows = await snapshotDb.table('outbox').toArray();
          if (outboxRows.length > 0) {
            await targetDb.outbox.bulkPut(outboxRows);
          }
          await targetDb.sync_meta.clear();
          const metaRows = await snapshotDb.table('sync_meta').toArray();
          if (metaRows.length > 0) {
            await targetDb.sync_meta.bulkPut(metaRows);
          }
          await targetDb.sync_conflicts.clear();
          const conflictRows = await snapshotDb.table('sync_conflicts').toArray();
          if (conflictRows.length > 0) {
            await targetDb.sync_conflicts.bulkPut(conflictRows);
          }
        });
      } catch (rollbackErr) {
        console.error('Snapshot rollback failed:', rollbackErr);
      } finally {
        snapshotDb.close();
        await Dexie.delete('cash_safety_snapshot_temp');
      }
    }
    throw txError;
  }
}

