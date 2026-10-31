// =====================================================================
// supabase/functions/sync-push/index.ts
// Phase 2b-2: Authoritative Sync-Push Edge Function
// Acts as an API Gateway validating payload before delegating to atomic
// PostgreSQL RPCs under the caller's JWT (Bearer <caller_jwt>).
//
// WHY AN EDGE FUNCTION EXISTS WHEN CLIENTS CAN CALL THE RPC DIRECTLY:
// 1. Direct RPC: Used by the PWA for lowest latency and direct transaction control.
// 2. Edge Function: Gateway for external devices, POS hardware, ETA signing agent,
//    and webhook integrations that send raw HTTP JSON and require upfront
//    schema validation, rate limiting, and HTTP error code translation.
// =====================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Extract Bearer Token
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Missing or invalid Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const callerJwt = authHeader.replace('Bearer ', '');

    // 2. Parse & Validate Input Body Upfront
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Malformed JSON payload' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${callerJwt}` },
      },
    });

    let rpcResponse: any;

    if (body.document_bundle) {
      // Document Bundle validation
      const { op_id, header, lines, post_now, client_ts } = body.document_bundle;
      if (!op_id || !UUID_REGEX.test(op_id)) {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Invalid or missing op_id UUID' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (!header || typeof header !== 'object') {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Document header must be an object' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      rpcResponse = await userClient.rpc('sync_push_document', {
        p_op_id: op_id,
        p_header: header,
        p_lines: lines || [],
        p_post_now: Boolean(post_now),
        p_client_ts: client_ts || new Date().toISOString(),
      });
    } else {
      // Single Entity validation
      const { op_id, entity, entity_id, op, payload, base_version, client_ts } = body;
      if (!op_id || !UUID_REGEX.test(op_id)) {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Invalid or missing op_id UUID' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (!entity || typeof entity !== 'string') {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Missing or invalid entity string' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (!entity_id || !UUID_REGEX.test(entity_id)) {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Missing or invalid entity_id UUID' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (!['insert', 'update', 'delete', 'post'].includes(op)) {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Invalid op. Allowed: insert, update, delete, post' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (payload === null || typeof payload !== 'object') {
        return new Response(
          JSON.stringify({ success: false, status: 'rejected', code: 'validation', error: 'Payload must be an object' }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      rpcResponse = await userClient.rpc('sync_push_op', {
        p_op_id: op_id,
        p_entity: entity,
        p_entity_id: entity_id,
        p_op: op,
        p_payload: payload,
        p_base_version: base_version || null,
        p_client_ts: client_ts || new Date().toISOString(),
      });
    }

    // 3. Map Database / PostgREST Errors to Machine-Readable HTTP Responses
    if (rpcResponse.error) {
      const err = rpcResponse.error;
      // Check if transient error (57014 timeout, 40001 serialization, 55P03 lock)
      if (err.code === '57014' || err.message?.includes('timeout')) {
        return new Response(
          JSON.stringify({ success: false, status: 'transient_error', error: 'Statement timeout: server busy, retry required' }),
          { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (err.code === '40001' || err.code === '55P03') {
        return new Response(
          JSON.stringify({ success: false, status: 'transient_error', error: 'Concurrent lock conflict, retry required' }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, status: 'rejected', code: 'database_error', error: err.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = rpcResponse.data;

    // Permanent Rejections returned as structured 200 with success: false (or 422)
    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, status: 'transient_error', error: err.message || 'Internal Server Error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
