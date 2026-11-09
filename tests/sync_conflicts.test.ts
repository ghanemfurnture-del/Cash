import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import { OutboxRepository } from '../src/db/outbox';
import { ConflictService, isPostedRecord } from '../src/services/sync/conflictService';
import type { SyncConflict } from '../src/types/database';

describe('Phase 2c: Conflict Resolution Suite (Dexie & Outbox)', () => {
  beforeEach(async () => {
    await db.sync_conflicts.clear();
    await db.outbox.clear();
    await db.items.clear();
    await db.documents.clear();
  });

  it('correctly identifies posted records as immutable', () => {
    expect(isPostedRecord({ status: 'posted' })).toBe(true);
    expect(isPostedRecord({ status: 'draft' })).toBe(false);
    expect(isPostedRecord(null)).toBe(false);
    expect(isPostedRecord(undefined)).toBe(false);
  });

  it('retrieves only unresolved conflicts ordered by most recent first', async () => {
    const conflict1: SyncConflict = {
      id: crypto.randomUUID(),
      entity: 'items',
      entity_id: crypto.randomUUID(),
      local_payload: { name: 'Item 1 Local' },
      server_payload: { name: 'Item 1 Server', version: 2 },
      base_version: 1,
      version: 1,
      server_seq: 0,
      created_at: new Date('2026-11-01T10:00:00Z').toISOString(),
      updated_at: new Date('2026-11-01T10:00:00Z').toISOString(),
      resolved_at: null,
      resolved_by: null,
      resolution: null,
    };

    const conflict2: SyncConflict = {
      id: crypto.randomUUID(),
      entity: 'items',
      entity_id: crypto.randomUUID(),
      local_payload: { name: 'Item 2 Local' },
      server_payload: { name: 'Item 2 Server', version: 3 },
      base_version: 2,
      version: 1,
      server_seq: 0,
      created_at: new Date('2026-11-02T10:00:00Z').toISOString(),
      updated_at: new Date('2026-11-02T10:00:00Z').toISOString(),
      resolved_at: new Date('2026-11-02T11:00:00Z').toISOString(), // ALREADY RESOLVED
      resolved_by: 'admin',
      resolution: 'keep_server',
    };

    const conflict3: SyncConflict = {
      id: crypto.randomUUID(),
      entity: 'items',
      entity_id: crypto.randomUUID(),
      local_payload: { name: 'Item 3 Local' },
      server_payload: { name: 'Item 3 Server', version: 4 },
      base_version: 3,
      version: 1,
      server_seq: 0,
      created_at: new Date('2026-11-03T10:00:00Z').toISOString(),
      updated_at: new Date('2026-11-03T10:00:00Z').toISOString(),
      resolved_at: null,
      resolved_by: null,
      resolution: null,
    };

    await db.sync_conflicts.bulkPut([conflict1, conflict2, conflict3]);

    const unresolved = await ConflictService.getUnresolvedConflicts();
    expect(unresolved.length).toBe(2);
    // Most recent first: conflict3 (Nov 3) before conflict1 (Nov 1)
    expect(unresolved[0].id).toBe(conflict3.id);
    expect(unresolved[1].id).toBe(conflict1.id);

    const count = await ConflictService.getUnresolvedCount();
    expect(count).toBe(2);
  });

  it('resolves conflict with "Server Wins": updates local table, clears outbox, marks keep_server', async () => {
    const itemId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    // 1. Initial local item
    await db.items.put({
      id: itemId,
      code: 'ITM-01',
      name: 'Local Edited Name',
      unit_id: crypto.randomUUID(),
      sale_price: 100,
      version: 1,
      server_seq: 10,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // 2. Pending outbox item
    await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { name: 'Local Edited Name', sale_price: 100 },
      base_version: 1,
      user_id: 'user-1',
    });

    // 3. Stored conflict record
    const serverPayload = {
      id: itemId,
      code: 'ITM-01',
      name: 'Server Authoritative Name',
      unit_id: crypto.randomUUID(),
      sale_price: 150,
      version: 2,
      server_seq: 25,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await db.sync_conflicts.put({
      id: conflictId,
      entity: 'items',
      entity_id: itemId,
      local_payload: { name: 'Local Edited Name', sale_price: 100 },
      server_payload: serverPayload,
      base_version: 1,
      version: 1,
      server_seq: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolution: null,
      resolved_at: null,
      resolved_by: null,
    });

    // Resolve using Server Wins
    await ConflictService.resolveServerWins(conflictId, 'test-user');

    // Assert local table now holds server payload
    const updatedLocal = await db.items.get(itemId);
    expect(updatedLocal).toBeDefined();
    expect(updatedLocal?.name).toBe('Server Authoritative Name');
    expect(updatedLocal?.sale_price).toBe(150);
    expect(updatedLocal?.version).toBe(2);

    // Assert outbox operation for this entity is removed
    const pendingOutbox = await db.outbox.where('entity_id').equals(itemId).count();
    expect(pendingOutbox).toBe(0);

    // Assert conflict is marked resolved
    const updatedConflict = await db.sync_conflicts.get(conflictId);
    expect(updatedConflict?.resolution).toBe('keep_server');
    expect(updatedConflict?.resolved_by).toBe('test-user');
    expect(updatedConflict?.resolved_at).toBeTruthy();
  });

  it('resolves conflict with "Re-apply Local" for mutable records: updates base_version in outbox', async () => {
    const itemId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    // Local item draft
    await db.items.put({
      id: itemId,
      code: 'ITM-02',
      name: 'Local Desired Name',
      unit_id: crypto.randomUUID(),
      sale_price: 250,
      version: 1,
      server_seq: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Conflicting outbox op with old base_version 1
    const oldOutbox = await OutboxRepository.queueOperation({
      entity: 'items',
      entity_id: itemId,
      op: 'update',
      payload: { name: 'Local Desired Name', sale_price: 250 },
      base_version: 1,
      user_id: 'user-1',
    });
    await OutboxRepository.markFailed(oldOutbox.id, 'Optimistic conflict', true);

    // Server payload has moved to version 4
    const serverPayload = {
      id: itemId,
      code: 'ITM-02',
      name: 'Server Conflicting Name',
      unit_id: crypto.randomUUID(),
      sale_price: 200,
      version: 4,
      server_seq: 40,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await db.sync_conflicts.put({
      id: conflictId,
      entity: 'items',
      entity_id: itemId,
      local_payload: { name: 'Local Desired Name', sale_price: 250 },
      server_payload: serverPayload,
      base_version: 1,
      version: 1,
      server_seq: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolution: null,
      resolved_at: null,
      resolved_by: null,
    });

    // Resolve using Re-apply Local
    await ConflictService.resolveLocalWins(conflictId, 'accountant-cai');

    // Assert local table is updated with baseVersion + 1
    const updatedLocal = await db.items.get(itemId);
    expect(updatedLocal?.name).toBe('Local Desired Name');
    expect(updatedLocal?.version).toBe(5);

    // Assert new outbox operation is queued with base_version = 4
    const outboxOps = await db.outbox.where('entity_id').equals(itemId).toArray();
    expect(outboxOps.length).toBe(1);
    expect(outboxOps[0].base_version).toBe(4);
    expect(outboxOps[0].status).toBe('pending');
    expect(outboxOps[0].payload).toEqual({ name: 'Local Desired Name', sale_price: 250 });

    // Assert conflict is marked resolved as 'keep_local'
    const updatedConflict = await db.sync_conflicts.get(conflictId);
    expect(updatedConflict?.resolution).toBe('keep_local');
    expect(updatedConflict?.resolved_by).toBe('accountant-cai');
    expect(updatedConflict?.resolved_at).toBeTruthy();
  });

  it('STRICT IMMUTABILITY: blocks "Re-apply Local" on posted documents and throws Arabic error', async () => {
    const docId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    const serverPostedDoc = {
      id: docId,
      doc_type: 'sales_invoice',
      doc_no: 'INV-2026-001',
      status: 'posted', // POSTED IMMUTABLE
      total: 1000,
      version: 2,
      server_seq: 50,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await db.sync_conflicts.put({
      id: conflictId,
      entity: 'documents',
      entity_id: docId,
      local_payload: { total: 1200, notes: 'Trying to modify posted doc' },
      server_payload: serverPostedDoc,
      base_version: 1,
      version: 1,
      server_seq: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolution: null,
      resolved_at: null,
      resolved_by: null,
    });

    // Attempting Re-apply Local MUST reject
    await expect(ConflictService.resolveLocalWins(conflictId, 'user-1')).rejects.toThrow(
      /لا يمكن تعديل المستند المعتمد/
    );

    // Verify conflict remains unresolved
    const conflict = await db.sync_conflicts.get(conflictId);
    expect(conflict?.resolved_at).toBeNull();
  });
});
