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
//    schema validation, payload normalization, and HTTP error code translation.
//
// CORS POLICY JUSTIFICATION:
// Access-Control-Allow-Origin: '*' is acceptable and deliberate here because:
// - This is an authenticated API gateway where every business operation requires
//   an explicit Bearer JWT (Authorization: Bearer <caller_jwt>).
// - Ambient browser credentials (cookies) are NOT used (credentials mode is not 'include').
// - Clients include mobile PWA apps, desktop browser instances, and local network
//   POS hardware terminals across varying local IP subnets and origins.
// =====================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { validateSyncPushBody, mapRpcErrorToHttpResponse } from './validator.ts';

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

    const validation = validateSyncPushBody(body);
    if (validation.kind === 'error') {
      return new Response(
        JSON.stringify(validation.body),
        { status: validation.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${callerJwt}` },
      },
    });

    const rpcResponse = await userClient.rpc(validation.rpcName, validation.rpcArgs);

    // 3. Map Database / PostgREST Errors to Machine-Readable HTTP Responses
    if (rpcResponse.error) {
      const mapped = mapRpcErrorToHttpResponse(rpcResponse.error);
      return new Response(
        JSON.stringify(mapped.body),
        { status: mapped.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = rpcResponse.data;

    // Success and structured business rejections returned as JSON
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
