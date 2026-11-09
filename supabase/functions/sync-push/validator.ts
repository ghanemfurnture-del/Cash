// =====================================================================
// supabase/functions/sync-push/validator.ts
// Pure Validation and Payload Extraction Logic for Sync-Push Gateway
// Extracted to allow 100% test coverage under Vitest without Deno runtime dependencies.
// =====================================================================

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ValidationSuccessDocumentBundle {
  kind: 'document_bundle';
  rpcName: 'sync_push_document';
  rpcArgs: {
    p_op_id: string;
    p_header: Record<string, any>;
    p_lines: Record<string, any>[];
    p_post_now: boolean;
    p_client_ts: string;
  };
}

export interface ValidationSuccessSingleOp {
  kind: 'single_op';
  rpcName: 'sync_push_op';
  rpcArgs: {
    p_op_id: string;
    p_entity: string;
    p_entity_id: string;
    p_op: string;
    p_payload: Record<string, any>;
    p_base_version: number | null;
    p_client_ts: string;
  };
}

export interface ValidationErrorResponse {
  kind: 'error';
  status: number;
  body: {
    success: false;
    status: 'rejected' | 'transient_error';
    code?: string;
    error: string;
  };
}

export type ParseValidationResult =
  | ValidationSuccessDocumentBundle
  | ValidationSuccessSingleOp
  | ValidationErrorResponse;

/**
 * Validates incoming JSON payload for either a document bundle or a single entity sync operation.
 */
export function validateSyncPushBody(body: any): ParseValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      kind: 'error',
      status: 400,
      body: { success: false, status: 'rejected', code: 'validation', error: 'Malformed JSON payload' },
    };
  }

  // 1. Document Bundle Path
  if (body.document_bundle) {
    const { op_id, header, lines, post_now, client_ts } = body.document_bundle;

    if (!op_id || !UUID_REGEX.test(op_id)) {
      return {
        kind: 'error',
        status: 422,
        body: { success: false, status: 'rejected', code: 'validation', error: 'Invalid or missing op_id UUID' },
      };
    }

    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return {
        kind: 'error',
        status: 422,
        body: { success: false, status: 'rejected', code: 'validation', error: 'Document header must be an object' },
      };
    }

    if (!header.id || typeof header.id !== 'string' || !UUID_REGEX.test(header.id)) {
      return {
        kind: 'error',
        status: 422,
        body: { success: false, status: 'rejected', code: 'validation', error: 'Missing or invalid header.id UUID' },
      };
    }

    return {
      kind: 'document_bundle',
      rpcName: 'sync_push_document',
      rpcArgs: {
        p_op_id: op_id,
        p_header: header,
        p_lines: Array.isArray(lines) ? lines : [],
        p_post_now: Boolean(post_now),
        p_client_ts: client_ts || new Date().toISOString(),
      },
    };
  }

  // 2. Single Entity Operation Path
  const { op_id, entity, entity_id, op, payload, base_version, client_ts } = body;

  if (!op_id || !UUID_REGEX.test(op_id)) {
    return {
      kind: 'error',
      status: 422,
      body: { success: false, status: 'rejected', code: 'validation', error: 'Invalid or missing op_id UUID' },
    };
  }

  if (!entity || typeof entity !== 'string') {
    return {
      kind: 'error',
      status: 422,
      body: { success: false, status: 'rejected', code: 'validation', error: 'Missing or invalid entity string' },
    };
  }

  if (!entity_id || !UUID_REGEX.test(entity_id)) {
    return {
      kind: 'error',
      status: 422,
      body: { success: false, status: 'rejected', code: 'validation', error: 'Missing or invalid entity_id UUID' },
    };
  }

  if (!['insert', 'update', 'delete', 'post', 'reverse'].includes(op)) {
    return {
      kind: 'error',
      status: 422,
      body: { success: false, status: 'rejected', code: 'validation', error: 'Invalid op. Allowed: insert, update, delete, post, reverse' },
    };
  }

  const normalizedPayload = payload ?? {};
  if (typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
    return {
      kind: 'error',
      status: 422,
      body: { success: false, status: 'rejected', code: 'validation', error: 'Payload must be an object' },
    };
  }

  return {
    kind: 'single_op',
    rpcName: 'sync_push_op',
    rpcArgs: {
      p_op_id: op_id,
      p_entity: entity,
      p_entity_id: entity_id,
      p_op: op,
      p_payload: normalizedPayload,
      p_base_version: base_version ?? null,
      p_client_ts: client_ts || new Date().toISOString(),
    },
  };
}

/**
 * Maps PostgreSQL and PostgREST errors into machine-readable HTTP status codes and payloads.
 */
export function mapRpcErrorToHttpResponse(err: any): { status: number; body: Record<string, any> } {
  if (!err) {
    return {
      status: 500,
      body: { success: false, status: 'transient_error', error: 'Unknown database error' },
    };
  }

  // 57014 statement timeout -> 504 Gateway Timeout
  if (err.code === '57014' || err.message?.includes('timeout')) {
    return {
      status: 504,
      body: { success: false, status: 'transient_error', error: 'Statement timeout: server busy, retry required' },
    };
  }

  // 40001 serialization failure or 55P03 lock timeout -> 503 Service Unavailable
  if (err.code === '40001' || err.code === '55P03') {
    return {
      status: 503,
      body: { success: false, status: 'transient_error', error: 'Concurrent lock conflict, retry required' },
    };
  }

  // All other database/RLS errors -> 400 Bad Request
  return {
    status: 400,
    body: { success: false, status: 'rejected', code: 'database_error', error: err.message || String(err) },
  };
}

