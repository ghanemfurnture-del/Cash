import { db } from '../../db';
import { supabase } from '../../lib/supabase';
import { OutboxRepository } from '../../db/outbox';
import type { OutboxItem, BaseEntity } from '../../types/database';
import type { Table } from 'dexie';

/**
 * Maximum retry attempts for transient errors before an outbox item is marked as 'failed' (poison pill containment)
 */
export const MAX_RETRY_ATTEMPTS = 5;

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

export interface PushOperationResult {
  success: boolean;
  isDuplicate?: boolean;
  status?: string;
  original_result?: string;
  error?: string;
  errorObj?: any;
  server_row?: any;
  lines?: any[];
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

/**
 * Classifies whether an error is permanent (non-retryable poison op) or transient (retryable).
 *
 * Permanent errors (immediate status 'failed' or 'conflict', no retry):
 * - Server rejections (status === 'rejected')
 * - Optimistic concurrency conflicts (status === 'conflict')
 * - Unexpected SQLSTATEs re-raised by the RPC:
 *   - 42xxx (Syntax, undefined table/column, schema violation, permission denied 42501)
 *   - 23xxx (Integrity, check, foreign key, or unique constraint violations)
 *   - 22xxx (Data exceptions / type conversion)
 *   - 0Axxx (Feature not supported)
 *   - P0001 (Business validation triggers like block_posted_changes, block_posted_children)
 *
 * Transient errors (retryable with exponential backoff up to MAX_RETRY_ATTEMPTS):
 * - 57014 (PostgreSQL statement / query timeout)
 * - 40001 (Serialization failure)
 * - 55P03 (Lock not available)
 * - 08xxx (Connection dropped)
 * - Network errors ("Failed to fetch", "NetworkError", HTTP 503, HTTP 504)
 */
export function classifyError(error: any): { isPermanent: boolean; isConflict: boolean; message: string } {
  if (!error) return { isPermanent: false, isConflict: false, message: 'Unknown error' };

  const message = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
  const code = (error.code || error.sqlstate || '').toString().toUpperCase();

  // Optimistic concurrency conflict
  if (error.status === 'conflict' || code === 'CONFLICT' || message.includes('Optimistic concurrency conflict')) {
    return { isPermanent: true, isConflict: true, message };
  }

  // Explicit server rejection
  if (error.status === 'rejected') {
    return { isPermanent: true, isConflict: false, message };
  }

  // SQLSTATE classification
  if (
    code.startsWith('42') ||
    code.startsWith('23') ||
    code.startsWith('22') ||
    code.startsWith('0A') ||
    code === 'P0001'
  ) {
    return { isPermanent: true, isConflict: false, message };
  }

  // Known permanent message strings
  if (
    message.includes('permission denied') ||
    message.includes('violates foreign key') ||
    message.includes('violates check constraint') ||
    message.includes('violates unique constraint') ||
    message.includes('is pull-only') ||
    message.includes('cannot change lines of a posted record') ||
    message.includes('posted records are immutable') ||
    message.includes('already posted') ||
    message.includes('branch access denied') ||
    message.includes('Operation ID collision')
  ) {
    return { isPermanent: true, isConflict: false, message };
  }

  // Transient / retryable error
  return { isPermanent: false, isConflict: false, message };
}

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
   * Commit-safe pull across all v1 tables.
   * Calls get_server_time() BEFORE the pull query loop so all concurrent
   * commits on the server are guaranteed to be captured by the lookback window.
   */
  static async pullAll(options?: {
    serverTimeFn?: () => Promise<string>;
    fetchFn?: (tableName: string, query: { minSeq: number; lookbackIso: string; limit: number }) => Promise<any[]>;
  }): Promise<{ pulledCount: number; conflictsCount: number; maxSeq: number }> {
    let totalApplied = 0;
    let totalConflicts = 0;
    let highestSeq = 0;

    // Step 1: Fetch authoritative server timestamp from PostgreSQL server clock BEFORE querying tables
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

    // Step 2: Update global cursor using authoritative server clock timestamp
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
   * Refuses to build a document bundle without header.id (or with an invalid UUID),
   * failing the operation as a permanent client error.
   */
  static buildDocumentBundle(params: {
    op_id?: string;
    header: Record<string, any>;
    lines?: Record<string, any>[];
    post_now?: boolean;
    client_ts?: string;
  }): {
    op_id: string;
    header: Record<string, any>;
    lines: Record<string, any>[];
    post_now: boolean;
    client_ts: string;
  } {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const headerId = params?.header?.id;

    if (!headerId || typeof headerId !== 'string' || !UUID_REGEX.test(headerId)) {
      const error: any = new Error('Document bundle refused: header.id is missing or not a valid UUID');
      error.code = '22000';
      error.status = 'rejected';
      error.isPermanent = true;
      throw error;
    }

    return {
      op_id: params.op_id || crypto.randomUUID(),
      header: params.header,
      lines: params.lines || [],
      post_now: Boolean(params.post_now),
      client_ts: params.client_ts || new Date().toISOString(),
    };
  }

  /**
   * Sync-Push: Pushes pending operations to Supabase.
   * MANDATORY SECURITY RULE: Runs every business operation under caller's JWT, never service_role.
   * Employs op_id for guaranteed idempotency.
   */
  static async pushOperation(
    item: OutboxItem,
    options?: {
      jwt?: string;
      customExecutor?: (item: OutboxItem) => Promise<{
        success: boolean;
        isDuplicate?: boolean;
        error?: string;
        errorObj?: any;
        status?: string;
        original_result?: string;
        server_row?: any;
        lines?: any[];
      }>;
    }
  ): Promise<PushOperationResult> {
    // Client-side invariant: refuse document bundle without valid header.id as permanent client error
    if (item.entity === 'documents' && (item.payload?.is_bundle || item.payload?.header)) {
      try {
        this.buildDocumentBundle({
          op_id: item.op_id,
          header: item.payload.header,
          lines: item.payload.lines,
          post_now: item.payload.post_now,
          client_ts: item.client_ts,
        });
      } catch (err: any) {
        return {
          success: false,
          status: 'rejected',
          error: err.message,
          errorObj: { code: '22000', status: 'rejected', message: err.message, isPermanent: true },
        };
      }
    }

    // If a custom executor is injected (for unit tests / mocking)
    if (options?.customExecutor) {
      const res = await options.customExecutor(item);
      const isDuplicate = Boolean(res.isDuplicate || res.status === 'duplicate');
      const originalResult = res.original_result || (isDuplicate ? (res.success ? 'applied' : 'rejected') : undefined);

      // Immediate local reconciliation for customExecutor
      if (res.success && res.server_row && (db as any)[item.entity]) {
        const table = (db as any)[item.entity] as Table<any, string>;
        await table.put(res.server_row);
      }
      if (res.success && res.lines && Array.isArray(res.lines) && db.document_lines) {
        for (const line of res.lines) {
          await db.document_lines.put(line);
        }
      }

      return {
        ...res,
        isDuplicate,
        original_result: originalResult,
        server_row: res.server_row,
        lines: res.lines,
      };
    }

    // Ensure session exists
    const { data: sessionData } = await supabase.auth.getSession();
    const token = options?.jwt || sessionData?.session?.access_token;
    if (!token) {
      return {
        success: false,
        error: 'Push failed: User is not authenticated (missing JWT token)',
        errorObj: { code: '42501', message: 'Missing JWT token' },
      };
    }

    try {
      // 1. Call sync-push Edge Function or execute under caller client
      let responseBody: any = null;

      // Primary path: sync-push Edge Function with caller Bearer token
      const isDocBundle = item.entity === 'documents' && item.payload?.is_bundle;
      const requestBody = isDocBundle
        ? {
            document_bundle: {
              op_id: item.op_id,
              header: item.payload.header,
              lines: item.payload.lines || [],
              post_now: Boolean(item.payload.post_now),
              client_ts: item.client_ts,
            },
          }
        : {
            op_id: item.op_id,
            entity: item.entity,
            entity_id: item.entity_id,
            op: item.op,
            payload: item.payload,
            base_version: item.base_version ?? null,
            client_ts: item.client_ts,
          };

      const { data, error } = await supabase.functions.invoke('sync-push', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: requestBody,
      });

      if (error) {
        // Fallback: If Edge function is not deployed in local test environment,
        // execute directly against PostgREST under the caller's JWT:
        return await this.executeDirectUserOperation(item);
      }

      responseBody = data;

      if (!responseBody?.success) {
        if (responseBody?.status === 'duplicate') {
          return {
            success: responseBody.original_result === 'applied',
            isDuplicate: true,
            status: 'duplicate',
            original_result: responseBody.original_result,
            error: responseBody.error,
            server_row: responseBody.server_row,
            lines: responseBody.lines,
          };
        }
        return {
          success: false,
          status: responseBody?.status || 'rejected',
          error: responseBody?.error || 'Operation rejected by server',
          errorObj: responseBody,
        };
      }

      // Immediate local reconciliation: update version and server_seq to prevent stale base_version on subsequent edits
      if (responseBody?.server_row && (db as any)[item.entity]) {
        const table = (db as any)[item.entity] as Table<any, string>;
        await table.put(responseBody.server_row);
      }
      if (responseBody?.lines && Array.isArray(responseBody.lines) && db.document_lines) {
        for (const line of responseBody.lines) {
          await db.document_lines.put(line);
        }
      }

      return {
        success: true,
        isDuplicate: responseBody?.status === 'duplicate',
        status: responseBody?.status,
        original_result: responseBody?.original_result,
        server_row: responseBody?.server_row,
        lines: responseBody?.lines,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
        errorObj: err,
      };
    }
  }

  /**
   * Direct user operation execution (calls atomic sync_push_op RPC)
   * Guaranteed to use caller's JWT, enforcing RLS, branch scoping, and atomicity.
   */
  static async executeDirectUserOperation(item: OutboxItem): Promise<PushOperationResult> {
    try {
      if (item.entity === 'documents' && item.payload?.is_bundle) {
        const { data, error } = await (supabase.rpc as any)('sync_push_document', {
          p_op_id: item.op_id,
          p_header: item.payload.header,
          p_lines: item.payload.lines || [],
          p_post_now: Boolean(item.payload.post_now),
          p_client_ts: item.client_ts || new Date().toISOString(),
        });

        if (error) {
          const isTimeout = error.code === '57014' || error.message?.includes('timeout') || error.message?.includes('canceling statement due to statement timeout');
          return {
            success: false,
            error: isTimeout ? `Transient timeout (57014): ${error.message}` : error.message,
            errorObj: error,
          };
        }

        if (!data?.success) {
          if (data?.status === 'duplicate') {
            if (data.original_result === 'applied' && data.server_row && db.documents) {
              await db.documents.put(data.server_row);
            }
            if (data.original_result === 'applied' && Array.isArray(data.lines) && db.document_lines) {
              for (const line of data.lines) {
                await db.document_lines.put(line);
              }
            }
            return {
              success: data.original_result === 'applied',
              isDuplicate: true,
              status: 'duplicate',
              original_result: data.original_result,
              error: data.error,
              server_row: data.server_row,
              lines: data.lines,
            };
          }
          return {
            success: false,
            status: data?.status || 'rejected',
            error: data?.error || 'Document bundle rejected by server',
            errorObj: data,
          };
        }

        if (data?.server_row && db.documents) {
          await db.documents.put(data.server_row);
        }
        if (Array.isArray(data?.lines) && db.document_lines) {
          for (const line of data.lines) {
            await db.document_lines.put(line);
          }
        }

        return {
          success: true,
          isDuplicate: data?.status === 'duplicate',
          status: data?.status,
          original_result: data?.original_result,
          server_row: data?.server_row,
          lines: data?.lines,
        };
      }

      const { data, error } = await (supabase.rpc as any)('sync_push_op', {
        p_op_id: item.op_id,
        p_entity: item.entity,
        p_entity_id: item.entity_id,
        p_op: item.op,
        p_payload: item.payload,
        p_base_version: item.base_version ?? null,
        p_client_ts: item.client_ts || new Date().toISOString(),
      });

      if (error) {
        // Handle 57014 statement timeout explicitly as transient retryable error
        const isTimeout = error.code === '57014' || error.message?.includes('timeout') || error.message?.includes('canceling statement due to statement timeout');
        return {
          success: false,
          error: isTimeout ? `Transient timeout (57014): ${error.message}` : error.message,
          errorObj: error,
        };
      }

      if (!data?.success) {
        if (data?.status === 'duplicate') {
          // Reconcile server row on duplicate of applied op
          if (data.original_result === 'applied' && data.server_row && (db as any)[item.entity]) {
            const table = (db as any)[item.entity] as Table<any, string>;
            await table.put(data.server_row);
          }
          return {
            success: data.original_result === 'applied',
            isDuplicate: true,
            status: 'duplicate',
            original_result: data.original_result,
            error: data.error,
            server_row: data.server_row,
          };
        }
        return {
          success: false,
          status: data?.status || 'rejected',
          error: data?.error || 'Operation rejected by server',
          errorObj: data,
        };
      }

      // Immediate local reconciliation: update version and server_seq to prevent stale base_version on subsequent edits
      if (data?.server_row && (db as any)[item.entity]) {
        const table = (db as any)[item.entity] as Table<any, string>;
        await table.put(data.server_row);
      }

      return {
        success: true,
        isDuplicate: data?.status === 'duplicate',
        status: data?.status,
        original_result: data?.original_result,
        server_row: data?.server_row,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
        errorObj: err,
      };
    }
  }

  /**
   * Process all pending outbox operations sequentially with retry policy:
   * - Permanent failures (rejections, conflicts, 42xxx) marked as 'failed'/'conflict' immediately without retry.
   * - Transient failures (57014 timeout, network drops) retried with exponential backoff up to MAX_RETRY_ATTEMPTS (5).
   * - Poison ops exceeding retry cap transition to 'failed' to prevent infinite retry loops.
   */
  static async pushAll(options?: {
    customExecutor?: (item: OutboxItem) => Promise<{
      success: boolean;
      error?: string;
      errorObj?: any;
      status?: string;
      original_result?: string;
      server_row?: any;
      lines?: any[];
    }>;
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
        const classification = classifyError(res.errorObj || res.error);

        if (classification.isPermanent) {
          // Permanent failure / RLS denial / 42xxx / constraint violation / optimistic conflict
          await OutboxRepository.markFailed(item.id, classification.message, classification.isConflict);

          if (classification.isConflict) {
            try {
              const existingConflict = await db.sync_conflicts.where('entity_id').equals(item.entity_id).first();
              if (!existingConflict) {
                const localTable = (db as any)[item.entity];
                const localRow = localTable ? await localTable.get(item.entity_id) : null;
                await db.sync_conflicts.put({
                  id: crypto.randomUUID(),
                  entity: item.entity,
                  entity_id: item.entity_id,
                  local_payload: item.payload || (localRow as Record<string, any>) || {},
                  server_payload: res.errorObj?.server_row || {},
                  base_version: item.base_version || localRow?.version || 1,
                  version: 1,
                  server_seq: 0,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  resolution: null,
                  resolved_at: null,
                  resolved_by: null,
                });
              }
            } catch (conflictErr) {
              console.error('Failed to register push conflict in sync_conflicts:', conflictErr);
            }
          }

          failedCount++;
          errors.push(`Operation ${item.id} (${item.entity}) permanently failed: ${classification.message}`);
        } else {
          // Transient failure (57014 timeout, network, lock conflict)
          const newRetryCount = (item.retry_count || 0) + 1;
          if (newRetryCount >= MAX_RETRY_ATTEMPTS) {
            // Cap exceeded: poison pill containment
            await OutboxRepository.markFailed(
              item.id,
              `Max retries (${MAX_RETRY_ATTEMPTS}) exceeded. Last error: ${classification.message}`
            );
            failedCount++;
            errors.push(`Operation ${item.id} (${item.entity}) exceeded max retries: ${classification.message}`);
          } else {
            // Under cap: return to 'pending' with incremented retry count
            await db.outbox.update(item.id, {
              status: 'pending',
              retry_count: newRetryCount,
              error: `Transient error (attempt ${newRetryCount}/${MAX_RETRY_ATTEMPTS}): ${classification.message}`,
            });
            failedCount++;
            errors.push(`Operation ${item.id} (${item.entity}) transiently failed (attempt ${newRetryCount}/${MAX_RETRY_ATTEMPTS}): ${classification.message}`);
          }
        }
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
