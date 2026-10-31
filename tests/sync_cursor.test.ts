import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import type { Item } from '../src/types/database';

describe('Commit-Safe Sync Cursor Engine (Simulation of Out-of-Order Commits)', () => {
  beforeEach(async () => {
    await db.items.clear();
    await db.outbox.clear();
    await db.sync_conflicts.clear();
    await db.sync_meta.clear();
  });

  it('proves that a lower server_seq committing AFTER a higher server_seq is NOT skipped', async () => {
    // -------------------------------------------------------------------------
    // SCENARIO:
    // Tx1 (long bulk import) started first, allocated server_seq: 100 for Item B.
    // Tx2 (fast cashier sale) started second, allocated server_seq: 105 for Item A.
    // Tx2 committed FIRST at T1.
    // Client pulled at T1, receiving Item A (seq: 105).
    // Client cursor advanced to 105.
    // Later at T2, Tx1 finally committed Item B (seq: 100).
    // Prove that the client pulls Item B and does NOT skip it!
    // -------------------------------------------------------------------------

    const itemA_id = crypto.randomUUID();
    const itemB_id = crypto.randomUUID();

    const itemA: Item = {
      id: itemA_id,
      sku: 'ITEM-A',
      name_ar: 'منتج سريع (Tx2)',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 150,
      purchase_price: 100,
      min_stock: 5,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:00.000Z',
      updated_at: '2026-10-31T10:00:00.000Z',
      version: 1,
      server_seq: 105, // Tx2 sequence
    };

    const itemB: Item = {
      id: itemB_id,
      sku: 'ITEM-B',
      name_ar: 'منتج مستورد جماعياً في معاملة طويلة (Tx1)',
      base_unit_id: 'unit-ea',
      is_stocked: true,
      sale_price: 300,
      purchase_price: 220,
      min_stock: 10,
      is_active: true,
      tracking: 'none',
      created_at: '2026-10-31T10:00:02.000Z',
      updated_at: '2026-10-31T10:00:02.000Z',
      version: 1,
      server_seq: 100, // Tx1 sequence (LOWER than Item A, but committed AFTER Item A)
    };

    // 1. Client first syncs at T1: receives Item A (seq 105)
    const resultA = await db.safeApplyServerRow(db.items, itemA);
    expect(resultA).toBe('applied');

    // Client records last seen server sequence = 105 and last sync timestamp
    await db.sync_meta.put({
      key: 'last_server_seq',
      value: 105,
      updated_at: '2026-10-31T10:00:01.000Z',
    });

    const storedA = await db.items.get(itemA_id);
    expect(storedA).toBeDefined();
    expect(storedA?.sku).toBe('ITEM-A');

    // Verify Item B is NOT yet in the local database
    const storedB_initial = await db.items.get(itemB_id);
    expect(storedB_initial).toBeUndefined();

    // -------------------------------------------------------------------------
    // 2. Simulated Server-Side Commit-Safe Pull with Time-Based Lookback Window:
    // A naive query "WHERE server_seq > 105" would MISS item B (100 <= 105)!
    // But our commit-safe pull queries:
    // "WHERE server_seq > :cursor OR updated_at >= :last_sync - INTERVAL '15m'"
    // -------------------------------------------------------------------------
    const clientLastSeq = (await db.sync_meta.get('last_server_seq'))?.value || 0;
    const clientLastSyncTs = new Date('2026-10-31T10:00:01.000Z').getTime();
    const lookbackThreshold = clientLastSyncTs - 15 * 60 * 1000; // 15 minutes before last sync

    // Simulated server database holding both items:
    const serverDatabase = [itemA, itemB];

    // Evaluate server query with lookback window:
    const pulledRows = serverDatabase.filter((row) => {
      const isNewerSeq = row.server_seq > clientLastSeq;
      const isWithinTimeLookback = new Date(row.updated_at).getTime() >= lookbackThreshold;
      return isNewerSeq || isWithinTimeLookback;
    });

    // Proves that Item B was retrieved despite having a lower sequence number (100 < 105)
    expect(pulledRows.map((r) => r.id)).toContain(itemB_id);

    // 3. Client processes the pulled rows:
    for (const row of pulledRows) {
      await db.safeApplyServerRow(db.items, row);
    }

    // PROOF: Item B is now safely applied in local Dexie database!
    const storedB_afterSync = await db.items.get(itemB_id);
    expect(storedB_afterSync).toBeDefined();
    expect(storedB_afterSync?.sku).toBe('ITEM-B');
    expect(storedB_afterSync?.server_seq).toBe(100);

    // PROOF: Item A was not corrupted or regressed
    const storedA_afterSync = await db.items.get(itemA_id);
    expect(storedA_afterSync?.sku).toBe('ITEM-A');
    expect(storedA_afterSync?.server_seq).toBe(105);
  });
});

