import { describe, it, expect } from 'vitest';
import {
  validateSyncPushBody,
  mapRpcErrorToHttpResponse,
  UUID_REGEX,
} from '../supabase/functions/sync-push/validator';

describe('Phase 2b-3: sync-push Gateway Pure Logic & Validation Suite', () => {
  it('confirms UUID_REGEX matches valid UUIDv4 and rejects invalid formats', () => {
    expect(UUID_REGEX.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(UUID_REGEX.test(crypto.randomUUID())).toBe(true);
    expect(UUID_REGEX.test('not-a-uuid')).toBe(false);
    expect(UUID_REGEX.test('123e4567-e89b-12d3-a456-42661417400g')).toBe(false);
    expect(UUID_REGEX.test('')).toBe(false);
  });

  describe('Document Bundle Validation', () => {
    const validOpId = crypto.randomUUID();
    const validDocId = crypto.randomUUID();

    it('rejects document_bundle if op_id is missing or not a valid UUID', () => {
      const res = validateSyncPushBody({
        document_bundle: {
          op_id: 'bad-op-id',
          header: { id: validDocId, doc_type: 'sales_invoice' },
        },
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.status).toBe(422);
        expect(res.body.error).toContain('Invalid or missing op_id UUID');
      }
    });

    it('rejects document_bundle if header is not an object', () => {
      const res = validateSyncPushBody({
        document_bundle: {
          op_id: validOpId,
          header: 'not-an-object',
        },
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.status).toBe(422);
        expect(res.body.error).toContain('Document header must be an object');
      }
    });

    it('rejects document_bundle if header.id is missing', () => {
      const res = validateSyncPushBody({
        document_bundle: {
          op_id: validOpId,
          header: { doc_type: 'sales_invoice', total: 100 },
        },
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.status).toBe(422);
        expect(res.body.error).toContain('Missing or invalid header.id UUID');
      }
    });

    it('rejects document_bundle if header.id is not a valid UUID', () => {
      const res = validateSyncPushBody({
        document_bundle: {
          op_id: validOpId,
          header: { id: 'invalid-doc-id', doc_type: 'sales_invoice' },
        },
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.status).toBe(422);
        expect(res.body.error).toContain('Missing or invalid header.id UUID');
      }
    });

    it('successfully extracts valid document_bundle into sync_push_document RPC arguments', () => {
      const header = {
        id: validDocId,
        doc_type: 'sales_invoice',
        series_code: 'POS1',
        seq_no: 1001,
        total: 750,
      };
      const lines = [
        { id: crypto.randomUUID(), document_id: validDocId, line_no: 1, line_total: 750 },
      ];

      const res = validateSyncPushBody({
        document_bundle: {
          op_id: validOpId,
          header,
          lines,
          post_now: true,
          client_ts: '2026-11-02T12:00:00.000Z',
        },
      });

      expect(res.kind).toBe('document_bundle');
      if (res.kind === 'document_bundle') {
        expect(res.rpcName).toBe('sync_push_document');
        expect(res.rpcArgs.p_op_id).toBe(validOpId);
        expect(res.rpcArgs.p_header).toEqual(header);
        expect(res.rpcArgs.p_lines).toEqual(lines);
        expect(res.rpcArgs.p_post_now).toBe(true);
        expect(res.rpcArgs.p_client_ts).toBe('2026-11-02T12:00:00.000Z');
      }
    });
  });

  describe('Single Operation Validation', () => {
    const validOpId = crypto.randomUUID();
    const validEntityId = crypto.randomUUID();

    it('rejects single operation with unsupported op string', () => {
      const res = validateSyncPushBody({
        op_id: validOpId,
        entity: 'items',
        entity_id: validEntityId,
        op: 'truncate',
        payload: {},
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.status).toBe(422);
        expect(res.body.error).toContain('Invalid op');
      }
    });

    it('normalizes single op and builds sync_push_op arguments', () => {
      const res = validateSyncPushBody({
        op_id: validOpId,
        entity: 'items',
        entity_id: validEntityId,
        op: 'update',
        payload: { sale_price: 250 },
        base_version: 3,
      });

      expect(res.kind).toBe('single_op');
      if (res.kind === 'single_op') {
        expect(res.rpcName).toBe('sync_push_op');
        expect(res.rpcArgs.p_op_id).toBe(validOpId);
        expect(res.rpcArgs.p_entity).toBe('items');
        expect(res.rpcArgs.p_base_version).toBe(3);
        expect(res.rpcArgs.p_payload).toEqual({ sale_price: 250 });
      }
    });
  });

  describe('PostgreSQL / PostgREST Error to HTTP Mapping', () => {
    it('maps statement timeout code 57014 to HTTP 504 Gateway Timeout', () => {
      const mapped = mapRpcErrorToHttpResponse({ code: '57014', message: 'canceling statement due to statement timeout' });
      expect(mapped.status).toBe(504);
      expect(mapped.body.status).toBe('transient_error');
      expect(mapped.body.error).toContain('Statement timeout');
    });

    it('maps lock conflict 40001 / 55P03 to HTTP 503 Service Unavailable', () => {
      const mapped1 = mapRpcErrorToHttpResponse({ code: '40001', message: 'could not serialize access' });
      expect(mapped1.status).toBe(503);
      expect(mapped1.body.status).toBe('transient_error');

      const mapped2 = mapRpcErrorToHttpResponse({ code: '55P03', message: 'lock not available' });
      expect(mapped2.status).toBe(503);
    });

    it('maps generic database / RLS permission denial to HTTP 400 Bad Request', () => {
      const mapped = mapRpcErrorToHttpResponse({ code: '42501', message: 'permission denied for table items' });
      expect(mapped.status).toBe(400);
      expect(mapped.body.status).toBe('rejected');
      expect(mapped.body.code).toBe('database_error');
    });
  });
});

