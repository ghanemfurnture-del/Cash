import { db } from '../../db';
import { OutboxRepository } from '../../db/outbox';
import type { SyncConflict } from '../../types/database';

/**
 * Checks if a given payload represents an immutable posted record.
 * Posted documents and their lines cannot be modified once committed.
 */
export function isPostedRecord(payload: Record<string, any> | null | undefined): boolean {
  if (!payload) return false;
  return payload.status === 'posted';
}

/**
 * Service for querying and resolving synchronization conflicts between local Dexie and Supabase.
 */
export class ConflictService {
  /**
   * Retrieves all unresolved conflicts ordered by most recent first.
   */
  static async getUnresolvedConflicts(): Promise<SyncConflict[]> {
    const list = await db.sync_conflicts.toArray();
    return list
      .filter((c) => !c.resolved_at)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  /**
   * Returns the total count of unresolved conflicts.
   */
  static async getUnresolvedCount(): Promise<number> {
    const list = await db.sync_conflicts.toArray();
    return list.filter((c) => !c.resolved_at).length;
  }

  /**
   * Resolves a conflict using "Server Wins":
   * - Local entity row in Dexie is updated with server_payload (or deleted if soft-deleted).
   * - All pending/failed outbox entries for this entity/entity_id are discarded.
   * - Conflict is marked resolved as 'keep_server'.
   */
  static async resolveServerWins(conflictId: string, resolvedBy: string = 'user'): Promise<void> {
    const conflict = await db.sync_conflicts.get(conflictId);
    if (!conflict) {
      throw new Error(`تعذر العثور على سجل التعارض بالمعرف: ${conflictId}`);
    }

    const table = (db as any)[conflict.entity];
    if (!table) {
      throw new Error(`الجدول ${conflict.entity} غير مسجل في قاعدة البيانات المحلية.`);
    }

    await db.transaction('rw', [table, db.outbox, db.sync_conflicts], async () => {
      // 1. Update local Dexie table with server payload
      if (conflict.server_payload.deleted_at) {
        await table.delete(conflict.entity_id);
      } else {
        await table.put(conflict.server_payload);
      }

      // 2. Remove obsolete local outbox operations
      const pendingOutbox = await db.outbox
        .where('entity')
        .equals(conflict.entity)
        .and((op) => op.entity_id === conflict.entity_id)
        .toArray();

      for (const op of pendingOutbox) {
        await db.outbox.delete(op.id);
      }

      // 3. Mark conflict resolved
      await db.sync_conflicts.update(conflictId, {
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
        resolution: 'keep_server',
        updated_at: new Date().toISOString(),
      });
    });
  }

  /**
   * Resolves a conflict using "Re-apply Local" (Local Wins):
   * - STRICT IMMUTABILITY CHECK: Rejects resolution if the document is posted on either server or local.
   * - Updates local Dexie row with local_payload.
   * - Discards old conflicting outbox operation.
   * - Enqueues a new outbox mutation with base_version = server_payload.version.
   * - Marks conflict resolved as 'keep_local'.
   */
  static async resolveLocalWins(conflictId: string, resolvedBy: string = 'user'): Promise<void> {
    const conflict = await db.sync_conflicts.get(conflictId);
    if (!conflict) {
      throw new Error(`تعذر العثور على سجل التعارض بالمعرف: ${conflictId}`);
    }

    // Immutability Check: Posted documents cannot be overwritten
    if (isPostedRecord(conflict.server_payload) || isPostedRecord(conflict.local_payload)) {
      throw new Error('لا يمكن تعديل المستند المعتمد. السجلات المعتمدة نهائية وغير قابلة للتعديل بحسب معايير الرقابة المحاسبية.');
    }

    const table = (db as any)[conflict.entity];
    if (!table) {
      throw new Error(`الجدول ${conflict.entity} غير مسجل في قاعدة البيانات المحلية.`);
    }

    const baseVersion = Number(conflict.server_payload.version) || 1;

    await db.transaction('rw', [table, db.outbox, db.sync_conflicts], async () => {
      // 1. Update local Dexie row
      const localUpdated = {
        ...conflict.local_payload,
        id: conflict.entity_id,
        version: baseVersion + 1,
        updated_at: new Date().toISOString(),
      };
      await table.put(localUpdated);

      // 2. Remove obsolete local outbox operations
      const pendingOutbox = await db.outbox
        .where('entity')
        .equals(conflict.entity)
        .and((op) => op.entity_id === conflict.entity_id)
        .toArray();

      for (const op of pendingOutbox) {
        await db.outbox.delete(op.id);
      }

      // 3. Queue new outbox operation with updated base_version to satisfy optimistic concurrency
      await OutboxRepository.queueOperation({
        entity: conflict.entity,
        entity_id: conflict.entity_id,
        op: 'update',
        payload: conflict.local_payload,
        base_version: baseVersion,
        user_id: resolvedBy,
      });

      // 4. Mark conflict resolved
      await db.sync_conflicts.update(conflictId, {
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
        resolution: 'keep_local',
        updated_at: new Date().toISOString(),
      });
    });
  }
}

