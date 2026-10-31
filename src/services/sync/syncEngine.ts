import { db } from '../../db';
import { supabase } from '../../lib/supabase';
import { OutboxRepository } from '../../db/outbox';
import type { OutboxItem, BaseEntity } from '../../types/database';
import type { Table } from 'dexie';

/**
 * Sync Configuration Constants (from docs/sync.md)
 */
export const SYNC_CONFIG = {
  /** Maximum transaction duration in seconds (Postgres 17 ceiling) */
  T_MAX_SECONDS: 60,
  /** Commit-safe overlap lookback window: T_max + 100% margin = 120 seconds */
  LOOKBACK_WINDOW_SECONDS: 120,
  /** Maximum rows pulled per batch */
  PULL_BATCH_LIMIT: 500,
  /** Maximum rows pushed per chunk */
  PUSH_CHUNK_SIZE: 100,
};

export interface SyncResult {
  pulledCount: number;
  pushedCount: number;
  conflictsCount: number;
  errors: string[];
}

/**
 * List of core v1 tables synchronized between Dexie and Supabase
 */
export const SYNCABLE_V1_TABLES = [
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
  'payments',
  'fiscal_years',
  'fiscal_periods',
] as const;

export class SyncEngine {
  /**
   * Authoritative Commit-Safe Pull for a single table:
   * Queries: WHERE server_seq > :last_server_seq OR updated_at >= (:last_sync - 120s)
   * Applies the Local Idempotent Upsert Rule without 'OR'
   */
  static async pullTable<T extends BaseEntity>(
    table: Table<T, string>,
    tableName: string,
    options?: {
      lastServerSeq?: number;
      lastSyncTimestamp?: string;
      fetchFn?: (query: { minSeq: number; lookbackIso: string; limit: number }) => Promise<T[]>;
    }
  ): Promise<{ applied: number; conflicts: number; skipped: number; maxSeq: number }> {
    // 1. Resolve cursors from Dexie sync_meta if not provided
    const lastSeqRecord = await db.sync_meta.get(`cursor_${tableName}`);
    const globalSeqRecord = await db.sync_meta.get('last_server_seq');
    const lastSeq = options?.lastServerSeq ?? Math.max(lastSeqRecord?.value || 0, globalSeqRecord?.value || 0);

    const lastSyncRecord = await db.sync_meta.get('last_sync_timestamp');
    const lastSyncIso = options?.lastSyncTimestamp ?? lastSyncRecord?.value ?? new Date(0).toISOString();

    const lastSyncMs = new Date(lastSyncIso).getTime();
    const lookbackMs = Math.max(0, lastSyncMs - SYNC_CONFIG.LOOKBACK_WINDOW_SECONDS * 1000);
    const lookbackIso = new Date(lookbackMs).toISOString();

    // 2. Fetch rows from Supabase (or custom fetchFn for tests)
    let rows: T[] = [];
    if (options?.fetchFn) {
      rows = await options.fetchFn({
        minSeq: lastSeq,
        lookbackIso,
        limit: SYNC_CONFIG.PULL_BATCH_LIMIT,
      });
    } else {
      // Direct PostgREST query under user's authenticated session
      const { data, error } = await (supabase
        .from(tableName as any)
        .select('*') as any)
        .or(`server_seq.gt.${lastSeq},updated_at.gte.${lookbackIso}`)
        .order('server_seq', { ascending: true })
        .limit(SYNC_CONFIG.PULL_BATCH_LIMIT);

      if (error) {
        throw new Error(`Failed to pull table ${tableName}: ${error.message}`);
      }
      rows = (data as unknown as T[]) || [];
    }

    let applied = 0;
    let conflicts = 0;
    let skipped = 0;
    let maxSeq = lastSeq;

    // 3. Process each incoming row using safeApplyServerRow
    for (const row of rows) {
      const result = await db.safeApplyServerRow(table, row);
      if (result === 'applied') {
        applied++;
      } else if (result === 'conflict') {
        conflicts++;
      } else {
        skipped++;
      }

      if (row.server_seq && row.server_seq > maxSeq) {
        maxSeq = row.server_seq;
      }
    }

    // 4. Update table cursor in sync_meta
    await db.sync_meta.put({
      key: `cursor_${tableName}`,
      value: maxSeq,
      updated_at: new Date().toISOString(),
    });

    return { applied, conflicts, skipped, maxSeq };
  }

  /**
   * Retrieves authoritative server timestamp from PostgreSQL get_server_time() RPC.
   * Guarantees sync cursor lookback thresholds never depend on device clocks.
   */
  static async getServerTime(customFetch?: () => Promise<string>): Promise<string> {
    if (customFetch) {
      return customFetch();
    }
    try {
      const { data, error } = await (supabase.rpc as any)('get_server_time');
      if (error || !data) {
        throw new Error(error?.message || 'Failed to retrieve server time');
      }
      return data;
    } catch {
      // In offline/disconnected mode, preserve previous sync timestamp
      const lastSyncRecord = await db.sync_meta.get('last_sync_timestamp');
      return lastSyncRecord?.value || new Date(0).toISOString();
    }
  }

  /**
   * Commit-safe pull across all v1 tables
   */
  static async pullAll(options?: {
    serverTimeFn?: () => Promise<string>;
    fetchFn?: (tableName: string, query: { minSeq: number; lookbackIso: string; limit: number }) => Promise<any[]>;
  }): Promise<{ pulledCount: number; conflictsCount: number; maxSeq: number }> {
    let totalApplied = 0;
    let totalConflicts = 0;
    let highestSeq = 0;

    // Fetch authoritative server timestamp from PostgreSQL server clock
    const serverTimestamp = await this.getServerTime(options?.serverTimeFn);

    for (const tableName of SYNCABLE_V1_TABLES) {
      const table = (db as any)[tableName] as Table<any, string> | undefined;
      if (!table) continue;

      const res = await this.pullTable(table, tableName, {
        fetchFn: options?.fetchFn ? (q) => options.fetchFn!(tableName, q) : undefined,
      });
      totalApplied += res.applied;
      totalConflicts += res.conflicts;
      if (res.maxSeq > highestSeq) {
        highestSeq = res.maxSeq;
      }
    }

    // Update global cursor using authoritative server clock timestamp
    await db.sync_meta.put({
      key: 'last_server_seq',
      value: highestSeq,
      updated_at: new Date().toISOString(),
    });
    await db.sync_meta.put({
      key: 'last_sync_timestamp',
      value: serverTimestamp,
      updated_at: new Date().toISOString(),
    });

    return {
      pulledCount: totalApplied,
      conflictsCount: totalConflicts,
      maxSeq: highestSeq,
    };
  }

  /**
   * Sync-Push: Pushes pending operations to Supabase
   * MANDATORY SECURITY RULE: Runs every business operation under caller's JWT, never service_role.
   * Employs op_id for guaranteed idempotency.
   */
  static async pushOperation(
    item: OutboxItem,
    options?: {
      jwt?: string;
      customExecutor?: (item: OutboxItem) => Promise<{ success: boolean; isDuplicate?: boolean; error?: string; status?: string }>;
    }
  ): Promise<{ success: boolean; isDuplicate?: boolean; error?: string }> {
    // If a custom executor is injected (for unit tests / mocking)
    if (options?.customExecutor) {
      const res = await options.customExecutor(item);
      return {
        ...res,
        isDuplicate: Boolean(res.isDuplicate || res.status === 'duplicate'),
      };
    }

    // Ensure session exists
    const { data: sessionData } = await supabase.auth.getSession();
    const token = options?.jwt || sessionData?.session?.access_token;
    if (!token) {
      throw new Error('Push failed: User is not authenticated (missing JWT token)');
    }

    try {
      // 1. Call sync-push Edge Function or execute under caller client
      let responseBody: any = null;

      // Primary path: sync-push Edge Function with caller Bearer token
      const { data, error } = await supabase.functions.invoke('sync-push', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          op_id: item.op_id,
          entity: item.entity,
          entity_id: item.entity_id,
          op: item.op,
          payload: item.payload,
          base_version: item.base_version,
          client_ts: item.client_ts,
        },
      });

      if (error) {
        // Fallback: If Edge function is not deployed in local test environment,
        // execute directly against PostgREST under the caller's JWT:
        return await this.executeDirectUserOperation(item);
      }

      responseBody = data;
      if (responseBody?.status === 'duplicate') {
        return { success: true, isDuplicate: true };
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Direct user operation execution (calls atomic sync_push_op RPC)
   * Guaranteed to use caller's JWT, enforcing RLS, branch scoping, and atomicity.
   */
  static async executeDirectUserOperation(item: OutboxItem): Promise<{ success: boolean; isDuplicate?: boolean; error?: string }> {
    try {
      const { data, error } = await (supabase.rpc as any)('sync_push_op', {
        p_op_id: item.op_id,
        p_entity: item.entity,
        p_entity_id: item.entity_id,
        p_op: item.op,
        p_payload: item.payload,
        p_base_version: item.base_version || null,
        p_client_ts: item.client_ts || new Date().toISOString(),
      });

      if (error) {
        // Handle 57014 statement timeout explicitly as transient retryable error
        const isTimeout = error.code === '57014' || error.message?.includes('timeout') || error.message?.includes('canceling statement due to statement timeout');
        return {
          success: false,
          error: isTimeout ? `Transient timeout (57014): ${error.message}` : error.message,
        };
      }

      if (!data?.success) {
        if (data?.status === 'duplicate') {
          return { success: data.original_result === 'applied', isDuplicate: true, error: data.error };
        }
        return { success: false, error: data?.error || 'Operation rejected by server' };
      }

      // Immediate local reconciliation: update version and server_seq to prevent stale base_version on subsequent edits
      if (data?.server_row && (db as any)[item.entity]) {
        const table = (db as any)[item.entity] as Table<any, string>;
        await table.put(data.server_row);
      }

      return { success: true, isDuplicate: data?.status === 'duplicate' };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Process all pending outbox operations sequentially
   */
  static async pushAll(options?: {
    customExecutor?: (item: OutboxItem) => Promise<{ success: boolean; error?: string; status?: string }>;
  }): Promise<{ pushedCount: number; failedCount: number; errors: string[] }> {
    const pendingOps = await OutboxRepository.getPendingOperations();
    if (pendingOps.length === 0) {
      return { pushedCount: 0, failedCount: 0, errors: [] };
    }

    const ids = pendingOps.map(op => op.id);
    await OutboxRepository.markInFlight(ids);

    let pushedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    for (const item of pendingOps) {
      const res = await this.pushOperation(item, options);
      if (res.success) {
        await OutboxRepository.markApplied([item.id]);
        pushedCount++;
      } else {
        const errorMsg = res.error || 'Unknown push error';
        await OutboxRepository.markFailed(item.id, errorMsg);
        failedCount++;
        errors.push(`Operation ${item.id} (${item.entity}) failed: ${errorMsg}`);
      }
    }

    return { pushedCount, failedCount, errors };
  }

  /**
   * Full bidirectional synchronization: Push offline writes, then Pull latest updates
   */
  static async syncAll(): Promise<SyncResult> {
    const pushRes = await this.pushAll();
    const pullRes = await this.pullAll();

    return {
      pulledCount: pullRes.pulledCount,
      pushedCount: pushRes.pushedCount,
      conflictsCount: pullRes.conflictsCount,
      errors: pushRes.errors,
    };
  }
}
