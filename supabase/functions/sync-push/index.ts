// =====================================================================
// supabase/functions/sync-push/index.ts
// Phase 2b-2: Authoritative Sync-Push Edge Function
// Delegates business mutations to atomic, single-transaction RPCs
// executed under the caller's JWT (Bearer <caller_jwt>).
// Guarantees zero out-of-transaction bookkeeping and 100% atomicity.
// =====================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

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
        JSON.stringify({ error: 'Unauthorized: Missing or invalid Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const callerJwt = authHeader.replace('Bearer ', '');

    // 2. Initialize Supabase client strictly with the caller's JWT
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${callerJwt}` },
      },
    });

    const body = await req.json();

    // 3. Dispatch to atomic, single-transaction PostgreSQL RPCs
    let rpcResponse: any;

    if (body.document_bundle) {
      // Document Bundle: Header + Lines + Optional Post
      const { op_id, header, lines, post_now, client_ts } = body.document_bundle;
      rpcResponse = await userClient.rpc('sync_push_document', {
        p_op_id: op_id,
        p_header: header,
        p_lines: lines,
        p_post_now: Boolean(post_now),
        p_client_ts: client_ts || new Date().toISOString(),
      });
    } else {
      // Single Entity Operation
      const { op_id, entity, entity_id, op, payload, base_version, client_ts } = body;
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

    if (rpcResponse.error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: rpcResponse.error.message,
          code: rpcResponse.error.code,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = rpcResponse.data;
    const httpStatus = result.success ? 200 : (result.status === 'duplicate' ? 200 : 403);

    return new Response(
      JSON.stringify(result),
      { status: httpStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', message: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
