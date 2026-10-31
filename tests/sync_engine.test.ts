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
      server_seq: 105, // Fast transaction seq
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
      server_seq: 100, // Allocated earlier, committed AFTER Tx2!
    };

    // Step 1: Client pulled item A earlier, setting cursor to seq 105 at T1
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

    // Step 2: Client performs commit-safe pull
    // Simulated server database holding both records:
    const serverRows = [itemA, itemB];

    const pullResult = await SyncEngine.pullTable(db.items, 'items', {
      lastServerSeq: 105,
      lastSyncTimestamp: '2026-10-31T12:00:01.000Z',
      fetchFn: async ({ minSeq, lookbackIso }) => {
        // Evaluate the server-side commit-safe SQL query filter:
        // WHERE server_seq > minSeq OR updated_at >= lookbackIso
        const thresholdMs = new Date(lookbackIso).getTime();
        return serverRows.filter(r => {
          return r.server_seq > minSeq || new Date(r.updated_at).getTime() >= thresholdMs;
        });
      },
    });

    // Verify Item B was captured and applied
    expect(pullResult.applied).toBe(1); // Item B applied; Item A skipped because seq 105 == local 105
    expect(pullResult.skipped).toBe(1);

    const storedB = await db.items.get(itemB_id);
    expect(storedB).toBeDefined();
    expect(storedB?.sku).toBe('SKU-LONG-TX1');
    expect(storedB?.server_seq).toBe(100);

    const storedA = await db.items.get(itemA_id);
    expect(storedA?.server_seq).toBe(105);
  });

  // =========================================================================
  // Test (b): A row with pending outbox ops is NOT overwritten by a pull
  // =========================================================================
  it('(b) proves that a row with pending outbox ops is never overwritten by a pull and routes to sync_conflicts', async () => {
    const itemId = crypto.randomUUID();

    // 1. Existing local row (version 1, price 100, server_seq 50)
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

    // 2. User edits item offline -> queues pending outbox operation
    await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { sale_price: 125, name_ar: 'تعديل محلي غير متزامن' },
      user_id: 'user-offline-1',
      base_version: 1,
    });

    // Update local row with the offline edit
    await db.items.update(itemId, { sale_price: 125, name_ar: 'تعديل محلي غير متزامن' });

    // 3. Incoming server row has a higher server_seq (server_seq 80, price 180)
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

    // 4. Pull executes safeApplyServerRow
    const applyResult = await db.safeApplyServerRow(db.items, incomingServerRow);

    // Assert: Must be identified as a conflict
    expect(applyResult).toBe('conflict');

    // Assert: Local row was NOT overwritten!
    const localAfterPull = await db.items.get(itemId);
    expect(localAfterPull?.sale_price).toBe(125);
    expect(localAfterPull?.name_ar).toBe('تعديل محلي غير متزامن');

    // Assert: Conflict recorded in sync_conflicts table for user resolution
    const conflicts = await db.sync_conflicts.where('entity_id').equals(itemId).toArray();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].entity).toBe('items');
    expect(conflicts[0].server_payload.sale_price).toBe(180);
    expect(conflicts[0].local_payload.sale_price).toBe(125);
  });

  // =========================================================================
  // Test (c): Push retry is idempotent (same operation twice = one effect)
  // =========================================================================
  it('(c) proves push retry is idempotent: executing same op_id twice produces exactly one effect', async () => {
    const fixedOpId = crypto.randomUUID();
    const entryId = crypto.randomUUID();

    // Simulated server-side sync_ops database
    const serverSyncOps = new Map<string, any>();
    const serverJournalEntries = new Map<string, any>();

    const mockPushExecutor = async (item: OutboxItem) => {
      // Step 1: Check idempotency table (sync_ops)
      if (serverSyncOps.has(item.op_id)) {
        return {
          success: true,
          status: 'duplicate',
        };
      }

      // Step 2: Apply business operation
      serverJournalEntries.set(item.entity_id, {
        id: item.entity_id,
        ...item.payload,
        created_at: new Date().toISOString(),
      });

      // Step 3: Record op_id in sync_ops
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

    // First push: should apply
    const firstPush = await SyncEngine.pushOperation(outboxItem, { customExecutor: mockPushExecutor });
    expect(firstPush.success).toBe(true);
    expect(firstPush.isDuplicate).toBeFalsy();
    expect(serverJournalEntries.size).toBe(1);
    expect(serverSyncOps.size).toBe(1);

    // Second push (e.g. network retry / client reconnection with same outbox item)
    const secondPush = await SyncEngine.pushOperation(outboxItem, { customExecutor: mockPushExecutor });
    expect(secondPush.success).toBe(true);
    expect(secondPush.isDuplicate).toBe(true);

    // PROOF: Exactly one effect on the server!
    expect(serverJournalEntries.size).toBe(1);
    expect(serverSyncOps.size).toBe(1);
    expect(serverJournalEntries.get(entryId).entry_no).toBe('JE-IDEMP-01');
  });

  // =========================================================================
  // Test (d): User without access to a branch CANNOT push to it
  // =========================================================================
  it('(d) proves a user without access to a branch cannot push to it and the push fails with RLS policy error', async () => {
    const branchCaiId = '22222222-2222-2222-2222-222222222201';
    const branchAlxId = '22222222-2222-2222-2222-222222222202';

    // Simulated user profile: Cashier with access ONLY to branch Cairo (branchCaiId)
    const userBranches = new Set([branchCaiId]);

    const mockPushExecutorWithBranchScoping = async (item: OutboxItem) => {
      const payloadBranch = item.payload.branch_id;
      // Enforce RLS branch condition: user_has_branch(branch_id)
      if (payloadBranch && !userBranches.has(payloadBranch)) {
        return {
          success: false,
          error: 'new row violates row-level security policy for table "journal_entries" (branch access denied)',
        };
      }
      return { success: true };
    };

    // 1. Authorized push to Cairo branch: succeeds
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

    // 2. Unauthorized push to Alexandria branch: fails
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
    expect(invalidRes.error).toContain('row-level security policy');
    expect(invalidRes.error).toContain('branch access denied');

    // Run pushAll to verify outbox item status is transitioned to 'failed'
    const pushAllResult = await SyncEngine.pushAll({
      customExecutor: mockPushExecutorWithBranchScoping,
    });

    const failedItemInDb = await db.outbox.get(invalidItem.id);
    expect(failedItemInDb?.status).toBe('failed');
    expect(failedItemInDb?.error).toContain('branch access denied');
    expect(pushAllResult.failedCount).toBeGreaterThanOrEqual(1);
  });
});
