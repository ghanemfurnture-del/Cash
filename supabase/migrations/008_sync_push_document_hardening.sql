-- =====================================================================
-- 008_sync_push_document_hardening.sql
-- Hardening of sync_push_document: Mandatory Header UUID & Authoritative Duplicate Retrieval
--
-- TABLES AND COLUMNS REFERENCED:
-- 1. documents:
--    - id (uuid, PK)
--    - status (text, check in 'draft','posted','reversed','cancelled')
--    - posted_at (timestamptz)
--    - Allowlist columns inserted dynamically:
--      doc_type (text), series_code (text), seq_no (int), doc_no (text),
--      doc_date (date), due_date (date), party_id (uuid), warehouse_id (uuid),
--      currency_code (char(3)), exchange_rate (numeric(18,6)), payment_method (text),
--      subtotal (numeric(18,4)), discount_total (numeric(18,4)), tax_total (numeric(18,4)),
--      total (numeric(18,4)), notes (text), branch_id (uuid), source (text), pos_shift_id (uuid)
-- 2. document_lines:
--    - id (uuid, PK)
--    - document_id (uuid, FK documents.id)
--    - line_no (int)
--    - item_id (uuid, FK items.id)
--    - description (text)
--    - unit_id (uuid, FK units.id)
--    - qty (numeric(18,4))
--    - unit_factor (numeric(18,6), NOT NULL default 1)
--    - unit_price (numeric(18,4))
--    - discount_amount (numeric(18,4))
--    - tax_code_id (uuid, FK tax_codes.id)
--    - tax_rate (numeric(6,4))
--    - tax_amount (numeric(18,4))
--    - line_total (numeric(18,4))
--    - cost_center_id (uuid, FK cost_centers.id)
-- 3. sync_ops:
--    - op_id (uuid, unique)
--    - user_id (uuid)
--    - entity_id (uuid)
--    - result (text)
--    - error (text)
-- 4. Internal schema functions:
--    - private._internal_claim_sync_op(uuid, text, uuid, text, jsonb, int, timestamptz)
--    - private._internal_finalize_sync_op(uuid, text, text)
--    - private._internal_get_sync_op_entity(uuid)
--
-- CONTRACTUAL FIXES:
-- 1. Enforces mandatory, valid RFC 4122 UUID format (versions 1-5) on p_header ->> 'id'.
--    Directly returns machine-readable rejection JSON (success: false, status: 'rejected',
--    code: 'validation', sqlstate: '22000') on missing, empty, or malformed UUID strings.
--    This prevents infinite client retries, avoids uncaught PL/pgSQL exceptions, and guarantees
--    consistent behavior matching sync_push_op.
-- 2. On duplicate retries (is_claimed = false AND existing_result = 'applied'),
--    authoritatively reads entity_id via private._internal_get_sync_op_entity(p_op_id).
--    This security definer function avoids direct table SELECT on sync_ops from security invoker,
--    preventing permission denied errors (42501) without granting table rights to authenticated.
-- 3. Eliminates gen_random_uuid() fallback that caused duplicate retry mismatches.
-- 4. Reverts line insertion logic strictly to 007's canonical schema columns.
-- 5. Preserves two-phase document insertion (insert as 'draft', then update to 'posted')
--    to ensure compliance with block_posted_children triggers.
-- 6. Fully idempotent (CREATE OR REPLACE FUNCTION); grants EXECUTE to authenticated, revokes from public and anon.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CLEANUP EXISTING FUNCTION SIGNATURES
-- ---------------------------------------------------------------------
drop function if exists public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz);
drop function if exists private._internal_get_sync_op_entity(uuid);

-- ---------------------------------------------------------------------
-- 2. SECURITY DEFINER HELPER TO RETRIEVE ENTITY_ID FROM SYNC_OPS
-- ---------------------------------------------------------------------
-- Reads entity_id safely under elevated definition without granting SELECT on sync_ops to authenticated.
-- Strictly filtered by user_id = auth.uid() to prevent reading other users' ops.
create or replace function private._internal_get_sync_op_entity(p_op_id uuid)
returns uuid
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_entity_id uuid;
begin
  select entity_id into v_entity_id
  from sync_ops
  where op_id = p_op_id
    and user_id = auth.uid();

  return v_entity_id;
end;
$$;

revoke all on function private._internal_get_sync_op_entity(uuid) from public, anon;
grant execute on function private._internal_get_sync_op_entity(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. AUTHORITATIVE HARDENED SYNC_PUSH_DOCUMENT RPC
-- ---------------------------------------------------------------------
create or replace function public.sync_push_document(
  p_op_id uuid,
  p_header jsonb,
  p_lines jsonb,
  p_post_now boolean default false,
  p_client_ts timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_claim record;
  v_doc_id uuid;
  v_allowed_header_cols text[] := array[
    'doc_type', 'series_code', 'seq_no', 'doc_no', 'doc_date', 'due_date',
    'party_id', 'warehouse_id', 'currency_code', 'exchange_rate', 'payment_method',
    'subtotal', 'discount_total', 'tax_total', 'total', 'notes', 'branch_id',
    'source', 'pos_shift_id'
  ];
  v_clean_header jsonb := '{}'::jsonb;
  v_line jsonb;
  v_line_no int;
  v_key text;
  v_col_list text;
  v_val_list text;
  v_code text;
  v_doc_row record;
  v_lines_data jsonb;
  -- RFC 4122 compliant UUID regex (versions 1 through 5, case-insensitive)
  v_uuid_regex text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated' using errcode = '42501';
  end if;

  if p_op_id is null then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Operation ID (op_id) is required',
      'sqlstate', '22000'
    );
  end if;

  -- 1. Strict Validation of Document Header ID (Returns machine-readable rejection)
  if p_header is null or (p_header ->> 'id') is null or trim(p_header ->> 'id') = '' then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'op_id', p_op_id,
      'error', 'Document header id is required',
      'sqlstate', '22000'
    );
  end if;

  if not (p_header ->> 'id' ~* v_uuid_regex) then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'op_id', p_op_id,
      'error', format('Invalid document header id UUID format: %s', (p_header ->> 'id')),
      'sqlstate', '22000'
    );
  end if;

  v_doc_id := (p_header ->> 'id')::uuid;

  -- 2. Atomic Claim of op_id in private schema
  select * into v_claim from private._internal_claim_sync_op(
    p_op_id, 'documents', v_doc_id, case when p_post_now then 'post' else 'insert' end,
    p_header, null, p_client_ts
  );

  if v_claim.is_other_user then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Operation ID collision with another user'
    );
  end if;

  if not v_claim.is_claimed then
    -- Duplicate retry: authoritatively retrieve entity_id via security definer helper
    v_doc_id := private._internal_get_sync_op_entity(p_op_id);
    if v_doc_id is null and (p_header ->> 'id') is not null then
      v_doc_id := (p_header ->> 'id')::uuid;
    end if;

    if v_claim.existing_result = 'applied' then
      execute 'select * from documents where id = $1' into v_doc_row using v_doc_id;
      select coalesce(jsonb_agg(to_jsonb(l) order by l.line_no), '[]'::jsonb)
      into v_lines_data
      from document_lines l
      where l.document_id = v_doc_id;

      return jsonb_build_object(
        'success', true,
        'status', 'duplicate',
        'is_duplicate', true,
        'original_result', 'applied',
        'code', 'ok',
        'op_id', p_op_id,
        'document_id', v_doc_id,
        'server_row', to_jsonb(v_doc_row),
        'lines', v_lines_data
      );
    else
      return jsonb_build_object(
        'success', false,
        'status', 'duplicate',
        'is_duplicate', true,
        'original_result', v_claim.existing_result,
        'code', case
          when v_claim.existing_result = 'conflict' then 'conflict'
          else 'constraint'
        end,
        'op_id', p_op_id,
        'error', v_claim.existing_error
      );
    end if;
  end if;

  -- 3. Build clean header strictly from allowlist (identical to 007)
  if p_header is not null then
    for v_key in select * from jsonb_object_keys(p_header) loop
      if v_key = any(v_allowed_header_cols) then
        v_clean_header := v_clean_header || jsonb_build_object(v_key, p_header -> v_key);
      end if;
    end loop;
  end if;

  begin
    -- 4. Insert Header (strictly as 'draft', identical to 007)
    select
      string_agg(quote_ident(key), ', '),
      string_agg(quote_nullable(value #>> '{}'), ', ')
    into v_col_list, v_val_list
    from jsonb_each(v_clean_header);

    if v_col_list is not null then
      execute format('insert into documents (id, status, %s) values ($1, ''draft'', %s)', v_col_list, v_val_list)
      using v_doc_id;
    else
      insert into documents (id, status) values (v_doc_id, 'draft');
    end if;

    -- 5. Insert Lines (reverted exactly to 007 canonical schema and logic)
    if p_lines is not null and jsonb_array_length(p_lines) > 0 then
      for v_line in select * from jsonb_array_elements(p_lines) loop
        v_line_no := coalesce((v_line ->> 'line_no')::int, 1);

        insert into document_lines (
          id, document_id, line_no, item_id, description, unit_id,
          qty, unit_factor, unit_price, discount_amount, tax_code_id,
          tax_rate, tax_amount, line_total, cost_center_id
        ) values (
          coalesce((v_line ->> 'id')::uuid, gen_random_uuid()),
          v_doc_id,
          v_line_no,
          (v_line ->> 'item_id')::uuid,
          v_line ->> 'description',
          (v_line ->> 'unit_id')::uuid,
          coalesce((v_line ->> 'qty')::numeric, 1),
          coalesce((v_line ->> 'unit_factor')::numeric, 1),
          coalesce((v_line ->> 'unit_price')::numeric, 0),
          coalesce((v_line ->> 'discount_amount')::numeric, 0),
          (v_line ->> 'tax_code_id')::uuid,
          coalesce((v_line ->> 'tax_rate')::numeric, 0),
          coalesce((v_line ->> 'tax_amount')::numeric, 0),
          coalesce((v_line ->> 'line_total')::numeric, 0),
          (v_line ->> 'cost_center_id')::uuid
        );
      end loop;
    end if;

    -- 6. Post Document (if requested, identical to 007)
    if p_post_now then
      update documents
      set status = 'posted',
          posted_at = now()
      where id = v_doc_id;
    end if;

    -- Fetch authoritative header and lines
    execute 'select * from documents where id = $1' into v_doc_row using v_doc_id;
    select coalesce(jsonb_agg(to_jsonb(l) order by l.line_no), '[]'::jsonb)
    into v_lines_data
    from document_lines l
    where l.document_id = v_doc_id;

    -- Finalize sync_ops as applied
    perform private._internal_finalize_sync_op(p_op_id, 'applied', null);

    return jsonb_build_object(
      'success', true,
      'status', 'applied',
      'code', 'ok',
      'op_id', p_op_id,
      'document_id', v_doc_id,
      'server_row', to_jsonb(v_doc_row),
      'lines', v_lines_data
    );

  exception when others then
    if sqlstate like '23%' or sqlstate like '22%' or sqlstate = '42501' or sqlstate = 'P0001' then
      v_code := case
        when sqlstate = '42501' then 'denied_or_not_found'
        when sqlstate like '23%' then 'constraint'
        else 'validation'
      end;

      perform private._internal_finalize_sync_op(p_op_id, 'rejected', sqlerrm);

      return jsonb_build_object(
        'success', false,
        'status', 'rejected',
        'code', v_code,
        'op_id', p_op_id,
        'error', sqlerrm,
        'sqlstate', sqlstate
      );
    else
      raise;
    end if;
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. PERMISSIONS: REVOKE ALL FROM PUBLIC/ANON, GRANT TO AUTHENTICATED
-- ---------------------------------------------------------------------
revoke all on function public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz) from public, anon;
grant execute on function public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz) to authenticated;
