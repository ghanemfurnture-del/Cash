import { db, CashERPDatabase } from '../../db';
import {
  CORE_BACKUP_TABLES,
  CURRENT_FORMAT_VERSION,
  CURRENT_SCHEMA_VERSION,
  PROTECTED_SYNC_META_KEYS,
  type BackupMetadata,
  type BackupPayload,
} from './types';
import { encryptBackupPayload, type EncryptOptions } from './crypto';

export interface CreateBackupOptions extends EncryptOptions {
  appVersion?: string;
  sourceDeviceId?: string;
  sourceDeviceCode?: string;
  sourceBranchId?: string;
  database?: CashERPDatabase;
}

/**
 * Checks if a sync_meta key is protected (should not be exported or overwritten).
 */
export function isProtectedSyncMetaKey(key: string): boolean {
  if (key.startsWith('counter:') || key.startsWith('device_')) {
    return true;
  }
  return (PROTECTED_SYNC_META_KEYS as readonly string[]).includes(key);
}

/**
 * Exports the 13 mirrored core tables + outbox + allowed sync_meta keys
 * into a JSON BackupPayload object.
 */
export async function buildBackupPayload(
  options?: Omit<CreateBackupOptions, 'iterations'>
): Promise<BackupPayload> {
  const targetDb = options?.database ?? db;

  // 1. Collect records for all 13 core mirrored tables
  const data: Record<string, any[]> = {};
  const recordCounts: Record<string, number> = {};

  for (const tableName of CORE_BACKUP_TABLES) {
    const table = (targetDb as any)[tableName];
    if (table) {
      const rows = await table.toArray();
      data[tableName] = rows;
      recordCounts[tableName] = rows.length;
    } else {
      data[tableName] = [];
      recordCounts[tableName] = 0;
    }
  }

  // 2. Collect outbox rows
  const outboxRows = await targetDb.outbox.toArray();
  recordCounts['outbox'] = outboxRows.length;

  // 3. Collect sync_meta (excluding protected keys)
  const syncMetaRows = await targetDb.sync_meta.toArray();
  const allowedSyncMeta = syncMetaRows.filter((row) => !isProtectedSyncMetaKey(row.key));
  recordCounts['sync_meta'] = allowedSyncMeta.length;

  // 4. Collect sync_conflicts
  const syncConflictsRows = await targetDb.sync_conflicts.toArray();
  recordCounts['sync_conflicts'] = syncConflictsRows.length;

  // 5. Resolve device and branch metadata
  const deviceIdMeta = await targetDb.sync_meta.get('device_id');
  const seriesCodeMeta = await targetDb.sync_meta.get('series_code');
  const branchIdMeta = await targetDb.sync_meta.get('current_branch_id');

  const metadata: BackupMetadata = {
    backup_created_at: new Date().toISOString(),
    source_device_id: options?.sourceDeviceId || deviceIdMeta?.value || 'LOCAL_DEVICE',
    source_device_code: options?.sourceDeviceCode || seriesCodeMeta?.value || 'D1',
    source_branch_id: options?.sourceBranchId || branchIdMeta?.value || 'MAIN_BRANCH',
    app_version: options?.appVersion || '1.0.0',
    schema_version: options?.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    format_version: options?.formatVersion ?? CURRENT_FORMAT_VERSION,
    record_counts: recordCounts,
  };

  return {
    metadata,
    data,
    outbox: outboxRows,
    sync_meta: allowedSyncMeta,
    sync_conflicts: syncConflictsRows,
  };
}

/**
 * Creates an encrypted .cashbak binary buffer from the current database state.
 */
export async function exportEncryptedBackup(
  password: string,
  options?: CreateBackupOptions
): Promise<Uint8Array> {
  const payload = await buildBackupPayload(options);
  const jsonString = JSON.stringify(payload);
  return encryptBackupPayload(jsonString, password, options);
}

/**
 * Browser helper to trigger a file download for the encrypted backup.
 */
export function downloadBackupFile(bytes: Uint8Array, filename?: string): void {
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const finalFilename = filename || `cash-erp-backup-${dateStr}.cashbak`;

  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = finalFilename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
