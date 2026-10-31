// =====================================================================
// supabase/functions/sync-push/index.ts
// Phase 2b-2: Authoritative Sync-Push Edge Function
// MANDATORY ARCHITECTURAL REQUIREMENT:
// 1. Validates caller JWT from Authorization header (Bearer <caller_jwt>).
// 2. Executes ALL business operations (insert, update, delete, post)
//    exclusively under a client initialized with the caller's JWT.
//    (Guarantees RLS branch scoping, permission enforcement, and audit_row logging).
// 3. service_role client is used ONLY for internal sync_ops logging.
// =====================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

interface PushPayload {
  op_id: string;
  entity: string;
  entity_id: string;
  op: 'insert' | 'update' | 'delete' | 'post' | 'reverse';
  payload: Record<string, any>;
  base_version?: number;
  client_ts?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // -----------------------------------------------------------------
    // 1. EXTRACT & VERIFY CALLER JWT
    // -----------------------------------------------------------------
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: Missing or invalid Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const callerJwt = authHeader.replace('Bearer ', '');

    // Internal admin client (USED ONLY for sync_ops bookkeeping)
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Verify caller identity with Supabase Auth
    const { data: userData, error: userError } = await adminClient.auth.getUser(callerJwt);
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: Invalid caller token', details: userError?.message }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = userData.user.id;

    // -----------------------------------------------------------------
    // 2. PARSE PAYLOAD & CHECK IDEMPOTENCY
    // -----------------------------------------------------------------
    const body: PushPayload = await req.json();
    const { op_id, entity, entity_id, op, payload, base_version } = body;

    if (!op_id || !entity || !entity_id || !op) {
      return new Response(
        JSON.stringify({ error: 'Bad Request: op_id, entity, entity_id, and op are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if op_id was already processed in sync_ops (Idempotency)
    const { data: existingOp } = await adminClient
      .from('sync_ops')
      .select('id, result, created_at')
      .eq('op_id', op_id)
      .maybeSingle();

    if (existingOp) {
      return new Response(
        JSON.stringify({
          status: 'duplicate',
          op_id,
          result: existingOp.result,
          message: 'Operation was already applied (idempotent retry)',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // -----------------------------------------------------------------
    // 3. EXECUTE BUSINESS OPERATION UNDER CALLER JWT (RLS ENFORCED)
    // -----------------------------------------------------------------
    // Client configured with caller's JWT token:
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${callerJwt}` },
      },
    });

    let opResult: any = null;
    let opError: any = null;

    if (op === 'insert') {
      const { data, error } = await userClient.from(entity).insert(payload).select().maybeSingle();
      opResult = data;
      opError = error;
    } else if (op === 'update') {
      const { data, error } = await userClient.from(entity).update(payload).eq('id', entity_id).select().maybeSingle();
      opResult = data;
      opError = error;
    } else if (op === 'delete') {
      const { data, error } = await userClient.from(entity).delete().eq('id', entity_id).select().maybeSingle();
      opResult = data;
      opError = error;
    } else if (op === 'post') {
      // Posting a document or journal entry: updates status to 'posted' under RLS
      const { data, error } = await userClient.from(entity).update({
        status: 'posted',
        posted_at: new Date().toISOString(),
        ...payload,
      }).eq('id', entity_id).select().maybeSingle();
      opResult = data;
      opError = error;
    } else if (op === 'reverse') {
      const { data, error } = await userClient.from(entity).update({
        status: 'reversed',
        ...payload,
      }).eq('id', entity_id).select().maybeSingle();
      opResult = data;
      opError = error;
    }

    // -----------------------------------------------------------------
    // 4. RECORD AUDIT RESULT IN SYNC_OPS VIA ADMIN CLIENT
    // -----------------------------------------------------------------
    if (opError) {
      // Record rejected/failed op
      await adminClient.from('sync_ops').insert({
        op_id,
        user_id: userId,
        entity,
        entity_id,
        op,
        payload,
        base_version: base_version || 1,
        client_ts: body.client_ts || new Date().toISOString(),
        schema_version: 1,
        result: 'rejected',
        error: opError.message,
      });

      return new Response(
        JSON.stringify({
          success: false,
          op_id,
          error: opError.message,
          code: opError.code,
        }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Record applied op
    await adminClient.from('sync_ops').insert({
      op_id,
      user_id: userId,
      entity,
      entity_id,
      op,
      payload,
      base_version: base_version || 1,
      client_ts: body.client_ts || new Date().toISOString(),
      schema_version: 1,
      result: 'applied',
    });

    return new Response(
      JSON.stringify({
        success: true,
        status: 'applied',
        op_id,
        data: opResult,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', message: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
