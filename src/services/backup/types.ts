import type { OutboxItem, SyncMeta, SyncConflict } from '../../types/database';

export const CURRENT_FORMAT_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 7;
export const MAGIC_BYTES = 'CASHBAK'; // 7 bytes ASCII (0x43, 0x41, 0x53, 0x48, 0x42, 0x41, 0x4B)
export const HEADER_SIZE = 39; // 7 + 2 + 2 + 16 + 12

export const CORE_BACKUP_TABLES = [
  'branches',
  'accounts',
  'cost_centers',
  'tax_codes',
  'units',
  'currencies',
  'parties',
  'items',
  'warehouses',
  'journal_entries',
  'journal_lines',
  'documents',
  'document_lines',
] as const;

export type CoreBackupTable = (typeof CORE_BACKUP_TABLES)[number];

export const PROTECTED_SYNC_META_KEYS = [
  'device_id',
  'series_code',
  'branch_id',
  'device_series_code',
  'device_branch_id',
  'device_sync_cursor',
  'last_pushed_op_id',
] as const;

export interface BackupMetadata {
  backup_created_at: string;
  source_device_id: string;
  source_device_code: string;
  source_branch_id: string;
  app_version: string;
  schema_version: number;
  format_version: number;
  record_counts: Record<string, number>;
}

export interface BackupPayload {
  metadata: BackupMetadata;
  data: Record<string, any[]>;
  outbox: OutboxItem[];
  sync_meta: SyncMeta[];
  sync_conflicts?: SyncConflict[];
}

export interface TableComparison {
  table: string;
  localCount: number;
  backupCount: number;
}

export interface UnsyncedWorkSummary {
  outboxCount: number;
  unsyncedDocCount: number;
  items: string[];
}

export interface RestorePreview {
  metadata: BackupMetadata;
  tableComparisons: TableComparison[];
  unsyncedWork: UnsyncedWorkSummary;
  requiresExplicitConfirmation: boolean;
  payload: BackupPayload;
}

export interface PersistenceStatus {
  isPersisted: boolean;
  isStandalone: boolean;
  isIosSafari: boolean;
  usageBytes: number;
  quotaBytes: number;
  warningMessage: string | null;
}

