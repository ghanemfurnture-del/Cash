import { db } from './index';
import type { OutboxItem } from '../types/database';

/**
 * Repository for managing local outbox operations
 * All local writes go through outbox to guarantee reliable offline sync.
 */
export class OutboxRepository {
  /**
   * Queue a new operation into the outbox.
   */
  static async queueOperation(params: {
    entity: string;
    entity_id: string;
    op: 'insert' | 'update' | 'delete' | 'post' | 'reverse';
    payload: Record<string, any>;
    user_id: string;
    base_version?: number | null;
  }): Promise<OutboxItem> {
    const item: OutboxItem = {
      id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      user_id: params.user_id,
      entity: params.entity,
      entity_id: params.entity_id,
      op: params.op,
      payload: params.payload,
      base_version: params.base_version ?? 1,
      client_ts: new Date().toISOString(),
      schema_version: 1,
      status: 'pending',
      retry_count: 0,
      error: null,
    };

    await db.outbox.put(item);
    return item;
  }

  /**
   * Get all pending operations ordered by timestamp.
   */
  static async getPendingOperations(): Promise<OutboxItem[]> {
    return db.outbox
      .where('status')
      .equals('pending')
      .sortBy('client_ts');
  }

  /**
   * Mark operations as in-flight during push sync.
   */
  static async markInFlight(ids: string[]): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      for (const id of ids) {
        await db.outbox.update(id, { status: 'in_flight' });
      }
    });
  }

  /**
   * Mark operations as applied (or remove them).
   */
  static async markApplied(ids: string[]): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      for (const id of ids) {
        await db.outbox.delete(id);
      }
    });
  }

  /**
   * Mark operation as failed or conflicting.
   */
  static async markFailed(id: string, error: string, isConflict: boolean = false): Promise<void> {
    const item = await db.outbox.get(id);
    if (!item) return;

    await db.outbox.update(id, {
      status: isConflict ? 'conflict' : 'failed',
      retry_count: item.retry_count + 1,
      error,
    });
  }

  /**
   * Check how many operations are currently pending or conflicting.
   */
  static async getCounts(): Promise<{ pending: number; inFlight: number; conflict: number }> {
    const pending = await db.outbox.where('status').equals('pending').count();
    const inFlight = await db.outbox.where('status').equals('in_flight').count();
    const conflict = await db.outbox.where('status').equals('conflict').count();
    return { pending, inFlight, conflict };
  }
}
