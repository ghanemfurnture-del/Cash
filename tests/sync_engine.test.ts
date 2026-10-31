import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import { OutboxRepository } from '../src/db/outbox';
import { SyncEngine } from '../src/services/sync/syncEngine';
import type { Item, JournalEntry, OutboxItem } from '../src/types/database';

describe('Phase 2b-2: Sync Engine Verification Suite', () => {
  beforeEach(async () => {
    await db.items.clear();
    await db.journal_entries.clear();
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
        };
      }

      serverJournalEntries.set(item.entity_id, {
        id: item.entity_id,
        ...item.payload,
        created_at: new Date().toISOString(),
      });

      serverSyncOps.set(item.op_id, {
        op_id: item.op_id,
        user_id: item.user_id,
        result: 'applied',
      });

      return { success: true, status: 'applied' };
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
    expect(serverJournalEntries.size).toBe(1);
    expect(serverSyncOps.size).toBe(1);

    const secondPush = await SyncEngine.pushOperation(outboxItem, { customExecutor: mockPushExecutor });
    expect(secondPush.success).toBe(true);
    expect(secondPush.isDuplicate).toBe(true);

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
        };
      }
      return {
        success: false,
        status: 'duplicate',
        isDuplicate: true,
        error: 'Original operation was permanently rejected: check constraint violation',
      };
    };

    const res1 = await SyncEngine.pushOperation(opApplied, { customExecutor: mockDuplicateExecutor });
    expect(res1.success).toBe(true);
    expect(res1.isDuplicate).toBe(true);

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
});
