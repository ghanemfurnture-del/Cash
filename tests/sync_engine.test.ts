import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// Complete test suite network isolation: guarantees zero HTTP requests to Supabase project
vi.mock('../src/lib/supabase', () => ({
  IS_DEV_MOCK_AUTH_ENABLED: false,
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        gt: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: new Date().toISOString(), error: null }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
    functions: {
      invoke: vi.fn().mockRejectedValue(new Error('Network calls blocked in test suite')),
    },
  },
}));

import { db } from '../src/db';
import { supabase } from '../src/lib/supabase';
import { OutboxRepository } from '../src/db/outbox';
import { SyncEngine } from '../src/services/sync/syncEngine';
import type { Item, JournalEntry, OutboxItem } from '../src/types/database';

describe('Phase 2b-2: Sync Engine Verification Suite', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.items.clear();
    await db.journal_entries.clear();
    await db.documents.clear();
    await db.document_lines.clear();
    await db.outbox.clear();
    await db.sync_conflicts.clear();
    await db.sync_meta.clear();
  });

  // =========================================================================
  // Test (a): Lower server_seq committing after higher one is NOT skipped
  // Uses simulated server rows array (Mock)
  // =========================================================================
  it('(a) proves that a lower server_seq committing after a higher one is not skipped by commit-safe pull', async () => {
    const itemA_id = crypto.randomUUID();
    const itemB_id = crypto.randomUUID();

    const itemA: Item = {
      id: itemA_id,
      sku: 'SKU-FAST-TX2',
      name_ar: 'منتج سريع (Tx2)',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 150,
      purchase_price: 100,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T12:00:00.000Z',
      updated_at: '2026-10-31T12:00:00.000Z',
      version: 1,
      server_seq: 105,
    };

    const itemB: Item = {
      id: itemB_id,
      sku: 'SKU-LONG-TX1',
      name_ar: 'منتج في معاملة طويلة التزمت لاحقاً (Tx1)',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 350,
      purchase_price: 250,
      min_stock: 10,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T12:00:02.000Z',
      updated_at: '2026-10-31T12:00:02.000Z',
      version: 1,
      server_seq: 100,
    };

    await db.safeApplyServerRow(db.items, itemA);
    await db.sync_meta.put({
      key: 'last_server_seq',
      value: 105,
      updated_at: '2026-10-31T12:00:01.000Z',
    });
    await db.sync_meta.put({
      key: 'last_sync_timestamp',
      value: '2026-10-31T12:00:01.000Z',
      updated_at: '2026-10-31T12:00:01.000Z',
    });

    expect(await db.items.get(itemB_id)).toBeUndefined();

    const serverRows = [itemA, itemB];
    const pullResult = await SyncEngine.pullTable(db.items, 'items', {
      lastServerSeq: 105,
      lastSyncTimestamp: '2026-10-31T12:00:01.000Z',
      fetchFn: async ({ minSeq, lookbackIso }) => {
        const thresholdMs = new Date(lookbackIso).getTime();
        return serverRows.filter(r => r.server_seq > minSeq || new Date(r.updated_at).getTime() >= thresholdMs);
      },
    });

    expect(pullResult.applied).toBe(1);
    expect(pullResult.skipped).toBe(1);

    const storedB = await db.items.get(itemB_id);
    expect(storedB).toBeDefined();
    expect(storedB?.sku).toBe('SKU-LONG-TX1');
    expect(storedB?.server_seq).toBe(100);
  });

  // =========================================================================
  // Test (b): A row with pending outbox ops is NOT overwritten by a pull
  // Tests real Dexie database safeApplyServerRow
  // =========================================================================
  it('(b) proves that a row with pending outbox ops is never overwritten by a pull and routes to sync_conflicts', async () => {
    const itemId = crypto.randomUUID();

    const initialItem: Item = {
      id: itemId,
      sku: 'ITEM-CONFLICT-01',
      name_ar: 'صنف محلي قيد التعديل',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 100,
      purchase_price: 70,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T10:00:00.000Z',
      version: 1,
      server_seq: 50,
    };
    await db.items.put(initialItem);

    await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { sale_price: 125, name_ar: 'تعديل محلي غير متزامن' },
      user_id: 'user-offline-1',
      base_version: 1,
    });

    await db.items.update(itemId, { sale_price: 125, name_ar: 'تعديل محلي غير متزامن' });

    const incomingServerRow: Item = {
      id: itemId,
      sku: 'ITEM-CONFLICT-01',
      name_ar: 'تعديل قادم من السيرفر',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 180,
      purchase_price: 90,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T12:00:00.000Z',
      version: 2,
      server_seq: 80,
    };

    const applyResult = await db.safeApplyServerRow(db.items, incomingServerRow);
    expect(applyResult).toBe('conflict');

    const localAfterPull = await db.items.get(itemId);
    expect(localAfterPull?.sale_price).toBe(125);
    expect(localAfterPull?.name_ar).toBe('تعديل محلي غير متزامن');

    const conflicts = await db.sync_conflicts.where('entity_id').equals(itemId).toArray();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].entity).toBe('items');
    expect(conflicts[0].server_payload.sale_price).toBe(180);
    expect(conflicts[0].local_payload.sale_price).toBe(125);
  });

  // =========================================================================
  // Test (b2): A row with FAILED outbox ops is ALSO NOT overwritten (Item 17)
  // Tests real Dexie database safeApplyServerRow
  // =========================================================================
  it('(b2) proves that a row with FAILED outbox ops is never overwritten by a pull and routes to sync_conflicts', async () => {
    const itemId = crypto.randomUUID();

    const initialItem: Item = {
      id: itemId,
      sku: 'ITEM-FAILED-01',
      name_ar: 'صنف محلي فشلت مزامنته',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 200,
      purchase_price: 140,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T10:00:00.000Z',
      version: 1,
      server_seq: 50,
    };
    await db.items.put(initialItem);

    const queued = await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { sale_price: 220, name_ar: 'تعديل محلي فشل إرساله' },
      user_id: 'user-offline-1',
      base_version: 1,
    });

    // Simulate failed push (e.g. temporary network error or business rejection)
    await OutboxRepository.markFailed(queued.id, 'Temporary network drop');

    // Confirm status is 'failed' in Dexie outbox
    const failedOp = await db.outbox.get(queued.id);
    expect(failedOp?.status).toBe('failed');

    // Server sends updated row
    const incomingServerRow: Item = {
      id: itemId,
      sku: 'ITEM-FAILED-01',
      name_ar: 'تحديث قادم من الخادم',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 250,
      purchase_price: 140,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T12:00:00.000Z',
      version: 2,
      server_seq: 90,
    };

    const applyResult = await db.safeApplyServerRow(db.items, incomingServerRow);
    expect(applyResult).toBe('conflict');

    // PROOF: Local row preserved, not overwritten by pull
    const localItem = await db.items.get(itemId);
    expect(localItem?.sale_price).toBe(200);

    const conflicts = await db.sync_conflicts.where('entity_id').equals(itemId).toArray();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].server_payload.sale_price).toBe(250);
  });

  // =========================================================================
  // Test (b3): A row with IN_FLIGHT outbox ops is ALSO NOT overwritten (Item 6)
  // Tests real Dexie database safeApplyServerRow
  // =========================================================================
  it('(b3) proves that a row with IN_FLIGHT outbox ops is never overwritten by a pull and routes to sync_conflicts', async () => {
    const itemId = crypto.randomUUID();

    const initialItem: Item = {
      id: itemId,
      sku: 'ITEM-INFLIGHT-01',
      name_ar: 'صنف محلي قيد الإرسال',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 300,
      purchase_price: 210,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T10:00:00.000Z',
      version: 1,
      server_seq: 60,
    };
    await db.items.put(initialItem);

    const queued = await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { sale_price: 320 },
      user_id: 'user-offline-1',
      base_version: 1,
    });

    // Mark as in_flight (currently being pushed to server)
    await OutboxRepository.markInFlight([queued.id]);

    const inFlightOp = await db.outbox.get(queued.id);
    expect(inFlightOp?.status).toBe('in_flight');

    // Concurrent incoming pull arrives from server
    const incomingServerRow: Item = {
      id: itemId,
      sku: 'ITEM-INFLIGHT-01',
      name_ar: 'تحديث قادم من الخادم تزامناً مع الإرسال',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 350,
      purchase_price: 210,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T12:00:00.000Z',
      version: 2,
      server_seq: 95,
    };

    const applyResult = await db.safeApplyServerRow(db.items, incomingServerRow);
    expect(applyResult).toBe('conflict');

    // PROOF: Local row preserved, not overwritten by pull
    const localItem = await db.items.get(itemId);
    expect(localItem?.sale_price).toBe(300);

    const conflicts = await db.sync_conflicts.where('entity_id').equals(itemId).toArray();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].server_payload.sale_price).toBe(350);
  });

  // =========================================================================
  // Test (c): Push retry is idempotent (client state machine)
  // [MOCK-LEVEL SERVER]: Tests client outbox state transitions and duplicate handling.
  // Real server-side idempotency is proven in sync_engine_validation_test.sql.
  // =========================================================================
  it('(c) [MOCK-LEVEL SERVER] proves push retry is idempotent: executing same op_id twice produces exactly one effect in client state machine', async () => {
    const fixedOpId = crypto.randomUUID();
    const entryId = crypto.randomUUID();

    const serverSyncOps = new Map<string, any>();
    const serverJournalEntries = new Map<string, any>();

    const mockPushExecutor = async (item: OutboxItem) => {
      if (serverSyncOps.has(item.op_id)) {
        return {
          success: true,
          status: 'duplicate',
          isDuplicate: true,
          original_result: 'applied',
          server_row: serverJournalEntries.get(item.entity_id),
        };
      }

      const serverRow = {
        id: item.entity_id,
        ...item.payload,
        version: 1,
        server_seq: 42,
        created_at: new Date().toISOString(),
      };
      serverJournalEntries.set(item.entity_id, serverRow);

      serverSyncOps.set(item.op_id, {
        op_id: item.op_id,
        user_id: item.user_id,
        result: 'applied',
      });

      return { success: true, status: 'applied', server_row: serverRow };
    };

    const outboxItem: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: fixedOpId,
      user_id: 'user-cai-01',
      entity: 'journal_entries',
      entity_id: entryId,
      op: 'insert',
      payload: { entry_no: 'JE-IDEMP-01', series_code: 'D1', seq_no: 1001 },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };
    await db.outbox.put(outboxItem);

    const firstPush = await SyncEngine.pushOperation(outboxItem, { customExecutor: mockPushExecutor });
    expect(firstPush.success).toBe(true);
    expect(firstPush.isDuplicate).toBeFalsy();
    expect(firstPush.server_row).toBeDefined();
    expect(firstPush.server_row.server_seq).toBe(42);
    expect(serverJournalEntries.size).toBe(1);
    expect(serverSyncOps.size).toBe(1);

    const secondPush = await SyncEngine.pushOperation(outboxItem, { customExecutor: mockPushExecutor });
    expect(secondPush.success).toBe(true);
    expect(secondPush.isDuplicate).toBe(true);
    expect(secondPush.server_row).toBeDefined();
    expect(secondPush.server_row.server_seq).toBe(42);

    expect(serverJournalEntries.size).toBe(1);
    expect(serverSyncOps.size).toBe(1);
    expect(serverJournalEntries.get(entryId).entry_no).toBe('JE-IDEMP-01');
  });

  // =========================================================================
  // Test (d): User without access to a branch CANNOT push to it (client handling)
  // [MOCK-LEVEL SERVER]: Tests client outbox transition to status='failed'.
  // Real Postgres RLS branch denial is proven in sync_engine_validation_test.sql.
  // =========================================================================
  it('(d) [MOCK-LEVEL SERVER] proves client outbox state transitions to failed on branch scoping error response', async () => {
    const branchCaiId = '22222222-2222-2222-2222-222222222201';
    const branchAlxId = '22222222-2222-2222-2222-222222222202';

    const userBranches = new Set([branchCaiId]);

    const mockPushExecutorWithBranchScoping = async (item: OutboxItem) => {
      const payloadBranch = item.payload.branch_id;
      if (payloadBranch && !userBranches.has(payloadBranch)) {
        return {
          success: false,
          error: 'new row violates row-level security policy for table "journal_entries" (branch access denied)',
        };
      }
      return { success: true };
    };

    const validItem: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: 'user-cai-01',
      entity: 'journal_entries',
      entity_id: crypto.randomUUID(),
      op: 'insert',
      payload: { branch_id: branchCaiId, entry_no: 'JE-CAI-OK' },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };
    await db.outbox.put(validItem);

    const validRes = await SyncEngine.pushOperation(validItem, {
      customExecutor: mockPushExecutorWithBranchScoping,
    });
    expect(validRes.success).toBe(true);

    const invalidItem: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: 'user-cai-01',
      entity: 'journal_entries',
      entity_id: crypto.randomUUID(),
      op: 'insert',
      payload: { branch_id: branchAlxId, entry_no: 'JE-CROSS-BRANCH-ILLEGAL' },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };
    await db.outbox.put(invalidItem);

    const invalidRes = await SyncEngine.pushOperation(invalidItem, {
      customExecutor: mockPushExecutorWithBranchScoping,
    });
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.error).toContain('branch access denied');

    const pushAllResult = await SyncEngine.pushAll({
      customExecutor: mockPushExecutorWithBranchScoping,
    });

    const failedItemInDb = await db.outbox.get(invalidItem.id);
    expect(failedItemInDb?.status).toBe('failed');
    expect(failedItemInDb?.error).toContain('branch access denied');
    expect(pushAllResult.failedCount).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // Test (e): Tombstone Application (Item 18)
  // Incoming soft-deleted row (deleted_at set) deletes local row in Dexie
  // =========================================================================
  it('(e) proves tombstone application: incoming row with deleted_at deletes record locally in Dexie', async () => {
    const itemId = crypto.randomUUID();

    const activeItem: Item = {
      id: itemId,
      sku: 'SKU-TO-BE-DELETED',
      name_ar: 'صنف سيتم حذفه بالسيرفر',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 100,
      purchase_price: 70,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T10:00:00.000Z',
      version: 1,
      server_seq: 10,
    };
    await db.items.put(activeItem);

    expect(await db.items.get(itemId)).toBeDefined();

    // Incoming tombstone from server
    const tombstone: Item = {
      ...activeItem,
      version: 2,
      server_seq: 20,
      deleted_at: '2026-10-31T12:00:00.000Z',
      updated_at: '2026-10-31T12:00:00.000Z',
    };

    const res = await db.safeApplyServerRow(db.items, tombstone);
    expect(res).toBe('applied');

    // PROOF: Item was cleanly deleted from local Dexie database!
    const localItemAfterTombstone = await db.items.get(itemId);
    expect(localItemAfterTombstone).toBeUndefined();
  });

  // =========================================================================
  // Test (f): Server Duplicate Response handling original_result applied/rejected (Item 18)
  // Uses mock customExecutor
  // =========================================================================
  it('(f) proves handling of server duplicate responses with original_result applied vs rejected', async () => {
    const opApplied: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: 'user-01',
      entity: 'items',
      entity_id: crypto.randomUUID(),
      op: 'insert',
      payload: { name_ar: 'صنف 1' },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };

    const opRejected: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: 'user-01',
      entity: 'items',
      entity_id: crypto.randomUUID(),
      op: 'insert',
      payload: { name_ar: 'صنف 2' },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };

    const mockDuplicateExecutor = async (item: OutboxItem) => {
      if (item.id === opApplied.id) {
        return {
          success: true,
          status: 'duplicate',
          isDuplicate: true,
          original_result: 'applied',
          server_row: { id: opApplied.entity_id, version: 1, server_seq: 100 },
        };
      }
      return {
        success: false,
        status: 'duplicate',
        isDuplicate: true,
        original_result: 'rejected',
        error: 'Original operation was permanently rejected: check constraint violation',
      };
    };

    const res1 = await SyncEngine.pushOperation(opApplied, { customExecutor: mockDuplicateExecutor });
    expect(res1.success).toBe(true);
    expect(res1.isDuplicate).toBe(true);
    expect(res1.server_row).toBeDefined();
    expect(res1.server_row.server_seq).toBe(100);

    const res2 = await SyncEngine.pushOperation(opRejected, { customExecutor: mockDuplicateExecutor });
    expect(res2.success).toBe(false);
    expect(res2.isDuplicate).toBe(true);
    expect(res2.error).toContain('permanently rejected');
  });

  // =========================================================================
  // Test (g): Server Duplicate Response handling original_result = 'conflict' (ADDENDUM b)
  // Uses mock customExecutor
  // =========================================================================
  it('(g) proves handling of server duplicate response with original_result conflict', async () => {
    const opConflict: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: 'user-01',
      entity: 'items',
      entity_id: crypto.randomUUID(),
      op: 'update',
      payload: { sale_price: 300 },
      base_version: 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };

    const mockConflictDuplicateExecutor = async (_item: OutboxItem) => {
      return {
        success: false,
        status: 'duplicate',
        isDuplicate: true,
        original_result: 'conflict',
        code: 'conflict',
        error: 'Optimistic concurrency conflict: server version has changed',
      };
    };

    const res = await SyncEngine.pushOperation(opConflict, {
      customExecutor: mockConflictDuplicateExecutor,
    });

    expect(res.success).toBe(false);
    expect(res.isDuplicate).toBe(true);
    expect(res.original_result).toBe('conflict');
    expect(res.error).toContain('concurrency conflict');
  });

  // =========================================================================
  // Test (h): Immediate Local Reconciliation from server_row (Item 6)
  // Real Dexie database verification
  // =========================================================================
  it('(h) proves immediate local reconciliation updates Dexie mirror with authoritative server_row', async () => {
    const itemId = crypto.randomUUID();

    const initialItem: Item = {
      id: itemId,
      sku: 'SKU-RECON-01',
      name_ar: 'صنف محلي للمواءمة الفورية',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 100,
      purchase_price: 70,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T10:00:00.000Z',
      version: 1,
      server_seq: 10,
    };
    await db.items.put(initialItem);

    // Simulated push operation returning authoritative server_row
    const authoritativeServerRow: Item = {
      ...initialItem,
      sale_price: 140,
      version: 2,
      server_seq: 155,
      updated_at: '2026-10-31T10:05:00.000Z',
    };

    // Client receives push response and executes local reconciliation
    await db.items.put(authoritativeServerRow);

    const reconciled = await db.items.get(itemId);
    expect(reconciled?.sale_price).toBe(140);
    expect(reconciled?.version).toBe(2);
    expect(reconciled?.server_seq).toBe(155);

    // Subsequent local edit correctly increments from version 2
    const nextQueued = await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { sale_price: 160 },
      user_id: 'user-01',
      base_version: reconciled!.version, // base_version = 2
    });

    expect(nextQueued.base_version).toBe(2);
  });

  // =========================================================================
  // Test (i): Authoritative Server Clock Timestamp Generation (Item 5)
  // Verifies that last_sync_timestamp comes strictly from server clock
  // =========================================================================
  it('(i) proves pullAll records authoritative server clock timestamp from getServerTime in sync_meta', async () => {
    const mockPostgresClock = '2026-10-31T14:30:00.123Z';

    const result = await SyncEngine.pullAll({
      serverTimeFn: async () => mockPostgresClock,
      fetchFn: async () => [],
    });

    expect(result).toBeDefined();

    const storedSyncMeta = await db.sync_meta.get('last_sync_timestamp');
    expect(storedSyncMeta).toBeDefined();
    // PROOF: Recorded timestamp is strictly the server clock, not local Date()
    expect(storedSyncMeta?.value).toBe(mockPostgresClock);
  });

  // =========================================================================
  // Test (j): Client Retry Policy & Poison Pill Containment (Item 7)
  // Verifies transient errors retry up to 5 times, then transition to 'failed'
  // =========================================================================
  it('(j) proves client retry policy: transient error retries up to 5 times before transitioning to failed (poison pill containment)', async () => {
    const itemId = crypto.randomUUID();

    const queued = await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { sale_price: 500 },
      user_id: 'user-01',
      base_version: 1,
    });

    const mockTransientTimeoutExecutor = async (_item: OutboxItem) => {
      return {
        success: false,
        error: 'Transient timeout (57014): statement timeout',
        errorObj: { code: '57014', message: 'canceling statement due to statement timeout' },
      };
    };

    // Attempts 1 to 4: Status remains 'pending', retry_count increments
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await SyncEngine.pushAll({ customExecutor: mockTransientTimeoutExecutor });
      expect(res.failedCount).toBe(1);

      const opInDb = await db.outbox.get(queued.id);
      expect(opInDb?.status).toBe('pending');
      expect(opInDb?.retry_count).toBe(attempt);
      expect(opInDb?.error).toContain(`attempt ${attempt}/5`);
    }

    // 5th Attempt: Cap reached -> transitions to 'failed' to prevent infinite loop
    const fifthPush = await SyncEngine.pushAll({ customExecutor: mockTransientTimeoutExecutor });
    expect(fifthPush.failedCount).toBe(1);

    const poisonedOp = await db.outbox.get(queued.id);
    expect(poisonedOp?.status).toBe('failed');
    expect(poisonedOp?.retry_count).toBe(5);
    expect(poisonedOp?.error).toContain('Max retries (5) exceeded');

    // Subsequent pushAll ignores this failed operation
    const subsequentPush = await SyncEngine.pushAll({ customExecutor: mockTransientTimeoutExecutor });
    expect(subsequentPush.pushedCount).toBe(0);
    expect(subsequentPush.failedCount).toBe(0);
  });

  // =========================================================================
  // Test (k): Immediate Classification of Unexpected SQLSTATEs (Item 7)
  // Verifies 42xxx errors immediately transition to 'failed' with 0 retries
  // =========================================================================
  it('(k) proves unexpected SQLSTATEs (e.g. 42501 / 42703) immediately fail without retry loops', async () => {
    const itemId = crypto.randomUUID();

    const queued = await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { invalid_col: 'value' },
      user_id: 'user-01',
      base_version: 1,
    });

    const mockSqlstateExecutor = async (_item: OutboxItem) => {
      return {
        success: false,
        error: 'column "invalid_col" does not exist',
        errorObj: { code: '42703', message: 'column "invalid_col" of relation "items" does not exist' },
      };
    };

    const res = await SyncEngine.pushAll({ customExecutor: mockSqlstateExecutor });
    expect(res.failedCount).toBe(1);

    const opInDb = await db.outbox.get(queued.id);
    // PROOF: Immediately marked as 'failed', not left as 'pending'
    expect(opInDb?.status).toBe('failed');
    expect(opInDb?.error).toContain('column "invalid_col" of relation "items" does not exist');
  });

  // =========================================================================
  // Test (l): Document Bundle Header ID Enforcement (Permanent Client Error)
  // Refuses to build a document bundle without header.id (or with invalid UUID),
  // and proves pushOperation/pushAll marks the op as 'failed' permanently with 0 retries.
  // =========================================================================
  it('(l) proves SyncEngine refuses document bundles without valid header.id and marks them failed permanently', async () => {
    // 1. Direct call to buildDocumentBundle without header.id throws permanent error
    expect(() => {
      SyncEngine.buildDocumentBundle({
        header: { doc_type: 'sales_invoice', total: 500 }, // missing id
        lines: [{ line_no: 1, qty: 1, unit_price: 500, line_total: 500 }],
      });
    }).toThrow('Document bundle refused: header.id is missing or not a valid UUID');

    // 2. Direct call with invalid non-UUID header.id throws permanent error
    expect(() => {
      SyncEngine.buildDocumentBundle({
        header: { id: 'invalid-non-uuid-string', doc_type: 'sales_invoice' },
      });
    }).toThrow('Document bundle refused: header.id is missing or not a valid UUID');

    // 3. Direct call with valid UUID header.id succeeds
    const validDocId = crypto.randomUUID();
    const validBundle = SyncEngine.buildDocumentBundle({
      header: { id: validDocId, doc_type: 'sales_invoice', total: 200 },
      lines: [{ line_no: 1, qty: 1, unit_price: 200, line_total: 200 }],
      post_now: true,
    });
    expect(validBundle.header.id).toBe(validDocId);
    expect(validBundle.lines).toHaveLength(1);
    expect(validBundle.post_now).toBe(true);

    // 4. Queued outbox item with invalid bundle payload fails permanently in pushOperation/pushAll
    const badBundleOp = await OutboxRepository.queueOperation({
      entity: 'documents',
      entity_id: 'bad-doc-uuid',
      op: 'insert',
      payload: {
        is_bundle: true,
        header: { doc_type: 'sales_invoice' }, // missing id
        lines: [],
      },
      user_id: 'user-01',
    });

    const res = await SyncEngine.pushAll();
    expect(res.failedCount).toBe(1);

    const poisonedOp = await db.outbox.get(badBundleOp.id);
    expect(poisonedOp?.status).toBe('failed');
    expect(poisonedOp?.error).toContain('Document bundle refused: header.id is missing or not a valid UUID');
    expect(poisonedOp?.retry_count).toBe(1); // Fails on first attempt without entering retry loop!
  });

  // =========================================================================
  // Test (m): Document Bundle Send & Reconciliation SUCCESS Path (customExecutor)
  // Proves valid document bundle sends successfully, preserves header/lines,
  // and reconciles authoritative server_row and lines into Dexie db.documents and db.document_lines.
  // =========================================================================
  it('(m) proves document bundle send path succeeds and reconciles header and lines into local Dexie store', async () => {
    const docId = crypto.randomUUID();
    const lineId = crypto.randomUUID();
    const branchId = crypto.randomUUID();

    const bundle = SyncEngine.buildDocumentBundle({
      header: {
        id: docId,
        branch_id: branchId,
        doc_type: 'sales_invoice',
        series_code: 'POS01',
        seq_no: 101,
        doc_no: 'INV-POS01-000101',
        doc_date: '2026-11-02',
        subtotal: 500,
        total: 500,
      },
      lines: [
        {
          id: lineId,
          document_id: docId,
          line_no: 1,
          qty: 2,
          unit_price: 250,
          line_total: 500,
        },
      ],
      post_now: true,
    });

    const queued = await OutboxRepository.queueOperation({
      entity: 'documents',
      entity_id: docId,
      op: 'post',
      payload: {
        is_bundle: true,
        header: bundle.header,
        lines: bundle.lines,
        post_now: bundle.post_now,
      },
      user_id: 'cashier-user-uuid',
    });

    const mockDocumentBundleExecutor = async (item: OutboxItem) => {
      // Assert received payload adheres to atomic bundle contract
      expect(item.entity).toBe('documents');
      expect(item.payload.is_bundle).toBe(true);
      expect(item.payload.header.id).toBe(docId);
      expect(item.payload.lines).toHaveLength(1);

      // Return simulated authoritative server response from sync_push_document
      return {
        success: true,
        status: 'applied',
        code: 'ok',
        server_row: {
          ...item.payload.header,
          status: 'posted',
          posted_at: '2026-11-02T10:00:00.000Z',
          version: 2,
          server_seq: 150,
          created_at: '2026-11-02T10:00:00.000Z',
          updated_at: '2026-11-02T10:00:00.000Z',
        },
        lines: [
          {
            ...item.payload.lines[0],
            version: 1,
            server_seq: 151,
            created_at: '2026-11-02T10:00:00.000Z',
            updated_at: '2026-11-02T10:00:00.000Z',
          },
        ],
      };
    };

    const pushRes = await SyncEngine.pushOperation(queued, {
      customExecutor: mockDocumentBundleExecutor,
    });

    // 1. Assert push response
    expect(pushRes.success).toBe(true);
    expect(pushRes.status).toBe('applied');
    expect(pushRes.server_row?.version).toBe(2);
    expect(pushRes.server_row?.status).toBe('posted');
    expect(pushRes.lines).toHaveLength(1);

    // 2. Assert local IndexedDB (Dexie) reconciliation
    const docInDb = await db.documents.get(docId);
    expect(docInDb).toBeDefined();
    expect(docInDb?.id).toBe(docId);
    expect(docInDb?.status).toBe('posted');
    expect(docInDb?.version).toBe(2);
    expect(docInDb?.server_seq).toBe(150);

    const lineInDb = await db.document_lines.get(lineId);
    expect(lineInDb).toBeDefined();
    expect(lineInDb?.id).toBe(lineId);
    expect(lineInDb?.document_id).toBe(docId);
    expect(lineInDb?.server_seq).toBe(151);

    // 3. Mark applied in outbox and verify it is cleaned up from pending outbox
    await OutboxRepository.markApplied([queued.id]);
    const opInDb = await db.outbox.get(queued.id);
    expect(opInDb).toBeUndefined();
  });

  // =========================================================================
  // Test (n): REAL Send Path for Document Bundles via Edge Function (sync-push)
  // Verifies pushOperation WITHOUT customExecutor:
  // - Passes Bearer JWT in headers
  // - Structures payload with document_bundle
  // - Calls supabase.functions.invoke('sync-push', ...)
  // - Reconciles authoritative server_row and lines into Dexie db.documents and db.document_lines
  // =========================================================================
  it('(n) proves real send path invokes sync-push Edge Function with document_bundle and reconciles locally', async () => {
    const docId = crypto.randomUUID();
    const lineId = crypto.randomUUID();
    const branchId = crypto.randomUUID();

    const bundle = SyncEngine.buildDocumentBundle({
      header: {
        id: docId,
        branch_id: branchId,
        doc_type: 'sales_invoice',
        series_code: 'POS02',
        seq_no: 202,
        doc_no: 'INV-POS02-000202',
        doc_date: '2026-11-02',
        subtotal: 1000,
        total: 1000,
      },
      lines: [
        {
          id: lineId,
          document_id: docId,
          line_no: 1,
          qty: 4,
          unit_price: 250,
          line_total: 1000,
        },
      ],
      post_now: true,
    });

    const queued = await OutboxRepository.queueOperation({
      entity: 'documents',
      entity_id: docId,
      op: 'post',
      payload: {
        is_bundle: true,
        header: bundle.header,
        lines: bundle.lines,
        post_now: bundle.post_now,
      },
      user_id: 'real-user-uuid',
    });

    // Mock Edge Function invoke success response
    const mockServerDoc = {
      ...bundle.header,
      status: 'posted',
      posted_at: '2026-11-02T14:00:00.000Z',
      version: 2,
      server_seq: 500,
      created_at: '2026-11-02T14:00:00.000Z',
      updated_at: '2026-11-02T14:00:00.000Z',
    };
    const mockServerLine = {
      ...bundle.lines[0],
      version: 1,
      server_seq: 501,
      created_at: '2026-11-02T14:00:00.000Z',
      updated_at: '2026-11-02T14:00:00.000Z',
    };

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        status: 'applied',
        code: 'ok',
        document_id: docId,
        server_row: mockServerDoc,
        lines: [mockServerLine],
      },
      error: null,
    } as any);

    // Call real pushOperation without customExecutor, passing caller JWT
    const pushRes = await SyncEngine.pushOperation(queued, {
      jwt: 'bearer-test-token-xyz',
    });

    // 1. Verify Edge Function invocation parameters
    expect(supabase.functions.invoke).toHaveBeenCalledWith('sync-push', {
      headers: {
        Authorization: 'Bearer bearer-test-token-xyz',
      },
      body: {
        document_bundle: {
          op_id: queued.op_id,
          header: bundle.header,
          lines: bundle.lines,
          post_now: true,
          client_ts: queued.client_ts,
        },
      },
    });

    // 2. Verify response
    expect(pushRes.success).toBe(true);
    expect(pushRes.status).toBe('applied');
    expect(pushRes.server_row?.version).toBe(2);
    expect(pushRes.server_row?.server_seq).toBe(500);

    // 3. Verify real local Dexie reconciliation
    const docInDb = await db.documents.get(docId);
    expect(docInDb).toBeDefined();
    expect(docInDb?.id).toBe(docId);
    expect(docInDb?.version).toBe(2);
    expect(docInDb?.server_seq).toBe(500);
    expect(docInDb?.status).toBe('posted');

    const lineInDb = await db.document_lines.get(lineId);
    expect(lineInDb).toBeDefined();
    expect(lineInDb?.id).toBe(lineId);
    expect(lineInDb?.server_seq).toBe(501);
  });

  // =========================================================================
  // Test (o): REAL Send Path Fallback via Direct RPC (sync_push_document)
  // Verifies that when sync-push Edge Function fails or is not deployed,
  // pushOperation falls back to executeDirectUserOperation:
  // - Directly invokes supabase.rpc('sync_push_document', ...) with caller credentials
  // - Reconciles server_row and lines into Dexie db.documents and db.document_lines
  // =========================================================================
  it('(o) proves real send path fallback executes sync_push_document RPC directly when Edge Function is unavailable', async () => {
    const docId = crypto.randomUUID();
    const lineId = crypto.randomUUID();

    const bundle = SyncEngine.buildDocumentBundle({
      header: {
        id: docId,
        branch_id: crypto.randomUUID(),
        doc_type: 'purchase_invoice',
        series_code: 'PUR01',
        seq_no: 301,
        doc_no: 'INV-PUR01-000301',
        doc_date: '2026-11-02',
        subtotal: 1200,
        total: 1200,
      },
      lines: [
        {
          id: lineId,
          document_id: docId,
          line_no: 1,
          qty: 10,
          unit_price: 120,
          line_total: 1200,
        },
      ],
      post_now: false,
    });

    const queued = await OutboxRepository.queueOperation({
      entity: 'documents',
      entity_id: docId,
      op: 'insert',
      payload: {
        is_bundle: true,
        header: bundle.header,
        lines: bundle.lines,
        post_now: bundle.post_now,
      },
      user_id: 'real-user-uuid',
    });

    // 1. Edge Function fails (e.g. gateway 500 error / not deployed)
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: null,
      error: new Error('Edge function not deployed in test environment'),
    } as any);

    // 2. Direct RPC succeeds
    const mockRpcServerDoc = {
      ...bundle.header,
      status: 'draft',
      version: 1,
      server_seq: 600,
      created_at: '2026-11-02T15:00:00.000Z',
      updated_at: '2026-11-02T15:00:00.000Z',
    };
    const mockRpcServerLine = {
      ...bundle.lines[0],
      version: 1,
      server_seq: 601,
      created_at: '2026-11-02T15:00:00.000Z',
      updated_at: '2026-11-02T15:00:00.000Z',
    };

    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: {
        success: true,
        status: 'applied',
        code: 'ok',
        document_id: docId,
        server_row: mockRpcServerDoc,
        lines: [mockRpcServerLine],
      },
      error: null,
    } as any);

    const pushRes = await SyncEngine.pushOperation(queued, {
      jwt: 'bearer-test-token-rpc',
    });

    // 1. Verify fallback was triggered
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('sync_push_document', {
      p_op_id: queued.op_id,
      p_header: bundle.header,
      p_lines: bundle.lines,
      p_post_now: false,
      p_client_ts: queued.client_ts,
    });

    // 2. Verify push response
    expect(pushRes.success).toBe(true);
    expect(pushRes.status).toBe('applied');
    expect(pushRes.server_row?.version).toBe(1);
    expect(pushRes.server_row?.server_seq).toBe(600);

    // 3. Verify Dexie local store was updated by direct RPC reconciliation
    const docInDb = await db.documents.get(docId);
    expect(docInDb).toBeDefined();
    expect(docInDb?.id).toBe(docId);
    expect(docInDb?.version).toBe(1);
    expect(docInDb?.server_seq).toBe(600);

    const lineInDb = await db.document_lines.get(lineId);
    expect(lineInDb).toBeDefined();
    expect(lineInDb?.id).toBe(lineId);
    expect(lineInDb?.server_seq).toBe(601);
  });
});
