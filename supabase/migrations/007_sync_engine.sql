-- =====================================================================
-- 007_sync_engine.sql
-- Phase 2b-2: Authoritative Single-Transaction Sync Engine RPCs
-- 1. Private internal schema 'private' with no PostgREST exposure
-- 2. Atomic Idempotent Claim & Bookkeeping for sync_ops (no p_user_id, uses auth.uid())
-- 3. Per-table column allowlists & branch_id immutability on updates
-- 4. Optimistic concurrency with SELECT FOR UPDATE and required base_version
-- 5. Whitelist error classification: re-raises 40001, 55P03, 57xxx, 53xxx; records only 23xxx, 22xxx, 42501, P0001
-- 6. Machine-readable error codes ('conflict', 'denied_or_not_found', 'constraint', 'validation') and server_row
-- 7. Entity -> Allowed ops map (pull-only tables restricted)
-- 8. sync_push_document: Atomic Header + Lines + Posting in ONE transaction
-- 9. get_server_time(): Authoritative PostgreSQL server clock
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PRIVATE SCHEMA FOR INTERNAL BOOKKEEPING (Shielded from PostgREST)
-- ---------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- 2. INTERNAL ATOMIC BOOKKEEPING FUNCTIONS (In private schema)
-- ---------------------------------------------------------------------

-- A. Atomic Claim of op_id:
-- Uses auth.uid() directly (no p_user_id parameter to prevent spoofing).
-- Uses INSERT ... ON CONFLICT (op_id) DO NOTHING RETURNING id to eliminate race conditions.
--
-- Contractual constraints quoted directly from 001_core_schema.sql:
-- Line 286: op text not null check (op in ('insert','update','delete','post','reverse')),
-- Line 289: result text check (result in ('applied','duplicate','conflict','rejected')),
--
-- Chosen provisional result: 'conflict'.
-- Rationale:
-- 1. 'applied' cannot be used because the op has not executed yet and cannot falsely report success.
-- 2. 'duplicate' is a response-only status and is never stored in sync_ops.
-- 3. 'rejected' denotes terminal failure.
-- 4. 'conflict' is allowed by the CHECK constraint and represents contention/in-flight validation.
--
-- Protection against lingering provisional states:
-- Within this same transaction, the op is finalized to 'applied', 'conflict' (with explicit error message),
-- or 'rejected'. If any unhandled or transient error occurs (40001, 55P03, 57xxx), the exception
-- is re-raised and the entire transaction rolls back, undoing the INSERT completely so ZERO rows
-- are committed in the provisional state.
create or replace function private._internal_claim_sync_op(
  p_op_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_op text,
  p_payload jsonb,
  p_base_version int,
  p_client_ts timestamptz
)
returns table (
  is_claimed boolean,
  existing_result text,
  existing_error text,
  is_other_user boolean
)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_claimed_id uuid;
  v_rec record;
begin
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated' using errcode = '42501';
  end if;

  -- 1. Atomic claim attempt using RETURNING id
  insert into sync_ops (
    op_id, user_id, entity, entity_id, op, payload,
    base_version, client_ts, schema_version, result, error
  ) values (
    p_op_id, v_caller_uid, p_entity, p_entity_id, p_op, p_payload,
    p_base_version, coalesce(p_client_ts, now()), 1, 'conflict', null
  )
  on conflict (op_id) do nothing
  returning id into v_claimed_id;

  -- 2. If row was returned, this transaction successfully claimed ownership!
  if v_claimed_id is not null then
    return query select true, null::text, null::text, false;
    return;
  end if;

  -- 3. Row already exists: inspect previous execution
  select user_id, result, error into v_rec
  from sync_ops
  where op_id = p_op_id;

  if not found then
    raise exception 'Critical error: sync_ops record not found after claim conflict';
  end if;

  -- Check if owned by another user (caller-scoped duplicate check)
  if v_rec.user_id <> v_caller_uid then
    return query select false, v_rec.result, 'Operation ID collision: op_id belongs to another user'::text, true;
    return;
  end if;

  -- Already completed by same user in a prior transaction
  -- existing_result is one of 'applied', 'rejected', 'conflict'
  return query select false, v_rec.result, v_rec.error, false;
end;
$$;

-- B. Finalize sync_op result within the same transaction
create or replace function private._internal_finalize_sync_op(
  p_op_id uuid,
  p_result text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  update sync_ops
  set result = p_result,
      error = p_error
  where op_id = p_op_id;
end;
$$;

-- Strict revocations: Never callable via public schema or by anon/public
revoke all on function private._internal_claim_sync_op from public, anon;
revoke all on function private._internal_finalize_sync_op from public, anon;
grant execute on function private._internal_claim_sync_op to authenticated;
grant execute on function private._internal_finalize_sync_op to authenticated;

-- ---------------------------------------------------------------------
-- 3. SERVER CLOCK RPC
-- ---------------------------------------------------------------------

create or replace function get_server_time() returns timestamptz
language sql stable set search_path = public as $$
  select clock_timestamp();
$$;

grant execute on function get_server_time() to authenticated;

-- ---------------------------------------------------------------------
-- 4. AUTHORITATIVE SINGLE-ENTITY SYNC PUSH RPC (SECURITY INVOKER)
-- ---------------------------------------------------------------------

create or replace function sync_push_op(
  p_op_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_op text,
  p_payload jsonb,
  p_base_version int default null,
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
  v_allowed_cols text[];
  v_clean_payload jsonb := '{}'::jsonb;
  v_key text;
  v_val text;
  v_current_row record;
  v_rows_affected int := 0;
  v_col_list text;
  v_val_list text;
  v_set_clause text;
  v_code text;
begin
  -- 0. Authentication Check
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated' using errcode = '42501';
  end if;

  -- 1. Operation Validation (contract allows 'insert','update','delete','post','reverse')
  if p_op not in ('insert', 'update', 'delete', 'post', 'reverse') then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Invalid operation: ' || coalesce(p_op, 'NULL')
    );
  end if;

  -- 2. Entity -> Allowed Operations Map & Pull-Only Restrictions
  if p_entity in ('fiscal_years', 'fiscal_periods', 'branches', 'accounts', 'tax_codes', 'units', 'currencies', 'cost_centers', 'warehouses') then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Entity ' || p_entity || ' is pull-only in v1'
    );
  elsif p_entity in ('documents', 'journal_entries', 'payments') then
    if p_op not in ('insert', 'update', 'post', 'reverse') then
      return jsonb_build_object(
        'success', false,
        'status', 'rejected',
        'code', 'validation',
        'error', 'Operation ' || p_op || ' is not allowed on ' || p_entity
      );
    end if;
  elsif p_entity in ('document_lines', 'journal_lines') then
    if p_op not in ('insert', 'update', 'delete') then
      return jsonb_build_object(
        'success', false,
        'status', 'rejected',
        'code', 'validation',
        'error', 'Operation ' || p_op || ' is not allowed on ' || p_entity
      );
    end if;
  elsif p_entity in ('items', 'parties') then
    if p_op not in ('insert', 'update', 'delete') then
      return jsonb_build_object(
        'success', false,
        'status', 'rejected',
        'code', 'validation',
        'error', 'Operation ' || p_op || ' is not allowed on ' || p_entity
      );
    end if;
  else
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Entity not allowed for sync: ' || coalesce(p_entity, 'NULL')
    );
  end if;

  -- 3. Atomic Claim of op_id in private schema
  select * into v_claim from private._internal_claim_sync_op(
    p_op_id, p_entity, p_entity_id, p_op, p_payload, p_base_version, p_client_ts
  );

  if v_claim.is_other_user then
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Operation ID collision: op_id belongs to another user'
    );
  end if;

  if not v_claim.is_claimed then
    -- Idempotent Duplicate
    return jsonb_build_object(
      'success', (v_claim.existing_result = 'applied'),
      'status', 'duplicate',
      'is_duplicate', true,
      'original_result', v_claim.existing_result,
      'code', case
        when v_claim.existing_result = 'applied' then 'ok'
        when v_claim.existing_result = 'conflict' then 'conflict'
        else 'constraint'
      end,
      'error', v_claim.existing_error
    );
  end if;

  -- Handle 'reverse' op (ADDENDUM c: contract valid op, explicit rejection explaining Phase 3/5 ledger engine)
  if p_op = 'reverse' then
    perform private._internal_finalize_sync_op(
      p_op_id,
      'rejected',
      'Accounting reversal requires counter journal entry generation and credit-note series, scheduled for Phase 3 (Core Ledger) and Phase 5 (Sales & Purchases Returns).'
    );
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'op_id', p_op_id,
      'error', 'Accounting reversal requires counter journal entry generation and credit-note series, scheduled for Phase 3 (Core Ledger) and Phase 5 (Sales & Purchases Returns). Status flipping is prohibited.'
    );
  end if;

  -- 4. Optimistic Concurrency Requirement:
  -- base_version is strictly REQUIRED on financial documents and lines
  if p_entity in ('documents', 'document_lines', 'journal_entries', 'journal_lines', 'payments')
     and p_op in ('update', 'delete', 'post')
     and p_base_version is null then
    perform private._internal_finalize_sync_op(p_op_id, 'rejected', 'base_version is required for ' || p_op || ' on ' || p_entity);
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'base_version is required for ' || p_op || ' on ' || p_entity
    );
  end if;

  -- 5. Empty Payload Check on Update
  if p_op = 'update' and (p_payload is null or p_payload = '{}'::jsonb) then
    perform private._internal_finalize_sync_op(p_op_id, 'rejected', 'Payload cannot be empty for update');
    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'code', 'validation',
      'error', 'Payload cannot be empty for update'
    );
  end if;

  -- 6. Per-Table Column Allowlists
  if p_entity = 'items' then
    v_allowed_cols := array['sku', 'barcode', 'name_ar', 'name_en', 'base_unit_id', 'category_id', 'is_stocked', 'sale_price', 'purchase_price', 'min_stock', 'tax_code_id', 'tracking', 'is_active'];
  elsif p_entity = 'parties' then
    v_allowed_cols := array['code', 'name_ar', 'name_en', 'kind', 'tax_id', 'commercial_reg', 'national_id', 'phone', 'email', 'address', 'credit_limit', 'payment_terms_days', 'is_active'];
  elsif p_entity = 'documents' then
    v_allowed_cols := array['doc_type', 'series_code', 'seq_no', 'doc_no', 'doc_date', 'due_date', 'party_id', 'warehouse_id', 'currency_code', 'exchange_rate', 'payment_method', 'subtotal', 'discount_total', 'tax_total', 'total', 'notes', 'branch_id', 'source', 'pos_shift_id'];
  elsif p_entity = 'document_lines' then
    v_allowed_cols := array['document_id', 'line_no', 'item_id', 'description', 'unit_id', 'qty', 'unit_factor', 'unit_price', 'discount_amount', 'tax_code_id', 'tax_rate', 'tax_amount', 'line_total', 'unit_cost', 'cost_center_id'];
  elsif p_entity = 'journal_entries' then
    v_allowed_cols := array['series_code', 'seq_no', 'entry_no', 'entry_date', 'description', 'source_type', 'source_id', 'branch_id'];
  elsif p_entity = 'journal_lines' then
    v_allowed_cols := array['entry_id', 'line_no', 'account_id', 'party_id', 'cost_center_id', 'debit', 'credit', 'currency_code', 'fx_amount', 'memo'];
  elsif p_entity = 'payments' then
    v_allowed_cols := array['payment_type', 'series_code', 'seq_no', 'voucher_no', 'voucher_date', 'party_id', 'treasury_account_id', 'currency_code', 'exchange_rate', 'amount', 'payment_method', 'reference_no', 'notes', 'branch_id'];
  end if;

  -- Build clean payload strictly from allowlist
  if p_payload is not null then
    for v_key in select * from jsonb_object_keys(p_payload) loop
      if v_key = any(v_allowed_cols) then
        v_clean_payload := v_clean_payload || jsonb_build_object(v_key, p_payload -> v_key);
      end if;
    end loop;
  end if;

  -- 7. Business Operation Execution
  begin
    -- -----------------------------------------------------------------
    -- A. INSERT
    -- -----------------------------------------------------------------
    if p_op = 'insert' then
      select
        string_agg(quote_ident(key), ', '),
        string_agg(quote_nullable(value #>> '{}'), ', ')
      into v_col_list, v_val_list
      from jsonb_each(v_clean_payload);

      if v_col_list is null then
        execute format('insert into %I (id) values ($1)', p_entity) using p_entity_id;
      else
        execute format('insert into %I (id, %s) values ($1, %s)', p_entity, v_col_list, v_val_list) using p_entity_id;
      end if;

    -- -----------------------------------------------------------------
    -- B. UPDATE
    -- -----------------------------------------------------------------
    elsif p_op = 'update' then
      -- Lock row and check existence / RLS / Concurrency
      execute format('select * from %I where id = $1 for update', p_entity)
      into v_current_row using p_entity_id;

      if v_current_row is null then
        raise exception 'Row % in % was not found or access was denied by row-level security', p_entity_id, p_entity
        using errcode = '42501';
      end if;

      -- Immutability of branch_id: payload cannot alter branch_id
      if (p_payload ? 'branch_id') and (p_entity in ('documents', 'journal_entries', 'payments')) then
        if (p_payload ->> 'branch_id')::uuid is distinct from v_current_row.branch_id then
          raise exception 'branch_id cannot be changed on an existing record' using errcode = '23514';
        end if;
      end if;

      -- Optimistic Concurrency Check
      if p_base_version is not null and v_current_row.version <> p_base_version then
        perform private._internal_finalize_sync_op(p_op_id, 'conflict', 'Optimistic concurrency conflict: server version has changed');
        return jsonb_build_object(
          'success', false,
          'status', 'conflict',
          'code', 'conflict',
          'op_id', p_op_id,
          'error', 'Optimistic concurrency conflict: server version has changed',
          'server_row', to_jsonb(v_current_row)
        );
      end if;

      select string_agg(format('%I = %L', key, value #>> '{}'), ', ')
      into v_set_clause
      from jsonb_each(v_clean_payload - array['branch_id']);

      if v_set_clause is not null then
        execute format('update %I set %s where id = $1', p_entity, v_set_clause) using p_entity_id;
        get diagnostics v_rows_affected = row_count;
        if v_rows_affected = 0 then
          raise exception 'Update affected 0 rows on % (%)', p_entity, p_entity_id using errcode = '42501';
        end if;
      else
        raise exception 'Payload contains no writable columns for %', p_entity using errcode = '22000';
      end if;

    -- -----------------------------------------------------------------
    -- C. DELETE -> SOFT DELETE (deleted_at = now())
    -- -----------------------------------------------------------------
    elsif p_op = 'delete' then
      execute format('select * from %I where id = $1 for update', p_entity)
      into v_current_row using p_entity_id;

      if v_current_row is null then
        raise exception 'Row % in % was not found or access was denied by row-level security', p_entity_id, p_entity
        using errcode = '42501';
      end if;

      if p_base_version is not null and v_current_row.version <> p_base_version then
        perform private._internal_finalize_sync_op(p_op_id, 'conflict', 'Optimistic concurrency conflict on delete');
        return jsonb_build_object(
          'success', false,
          'status', 'conflict',
          'code', 'conflict',
          'op_id', p_op_id,
          'error', 'Optimistic concurrency conflict on delete',
          'server_row', to_jsonb(v_current_row)
        );
      end if;

      execute format('update %I set deleted_at = now() where id = $1 and deleted_at is null', p_entity) using p_entity_id;
      get diagnostics v_rows_affected = row_count;
      if v_rows_affected = 0 then
        raise exception 'Delete affected 0 rows on % (%)', p_entity, p_entity_id using errcode = '42501';
      end if;

    -- -----------------------------------------------------------------
    -- D. POST (Status strictly set to 'posted')
    -- -----------------------------------------------------------------
    elsif p_op = 'post' then
      execute format('select * from %I where id = $1 for update', p_entity)
      into v_current_row using p_entity_id;

      if v_current_row is null then
        raise exception 'Row % in % was not found or access was denied by row-level security', p_entity_id, p_entity
        using errcode = '42501';
      end if;

      if p_base_version is not null and v_current_row.version <> p_base_version then
        perform private._internal_finalize_sync_op(p_op_id, 'conflict', 'Optimistic concurrency conflict on post');
        return jsonb_build_object(
          'success', false,
          'status', 'conflict',
          'code', 'conflict',
          'op_id', p_op_id,
          'error', 'Optimistic concurrency conflict on post',
          'server_row', to_jsonb(v_current_row)
        );
      end if;

      execute format('update %I set status = ''posted'', posted_at = now() where id = $1', p_entity) using p_entity_id;
      get diagnostics v_rows_affected = row_count;
      if v_rows_affected = 0 then
        raise exception 'Post affected 0 rows on % (%)', p_entity, p_entity_id using errcode = '42501';
      end if;
    end if;

    -- Finalize sync_op as applied
    perform private._internal_finalize_sync_op(p_op_id, 'applied', null);

    return jsonb_build_object(
      'success', true,
      'status', 'applied',
      'code', 'ok',
      'op_id', p_op_id,
      'entity', p_entity,
      'entity_id', p_entity_id
    );

  exception when others then
    -- Whitelist Permanent Errors:
    -- 23xxx (Integrity), 22xxx (Data Exception), 42501 (RLS/Privilege), P0001 (Business trigger exceptions)
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
      -- Re-raise ALL transient and unexpected errors (40001, 55P03, 53xxx, 57xxx, 08xxx)
      -- This aborts the transaction cleanly without recording 'rejected' in sync_ops!
      raise;
    end if;
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. AUTHORITATIVE ATOMIC DOCUMENT BUNDLE PUSH RPC (SECURITY INVOKER)
-- ---------------------------------------------------------------------

create or replace function sync_push_document(
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
  v_doc_id uuid := (p_header ->> 'id')::uuid;
  v_allowed_header_cols text[] := array['doc_type', 'series_code', 'seq_no', 'doc_no', 'doc_date', 'due_date', 'party_id', 'warehouse_id', 'currency_code', 'exchange_rate', 'payment_method', 'subtotal', 'discount_total', 'tax_total', 'total', 'notes', 'branch_id', 'source', 'pos_shift_id'];
  v_clean_header jsonb := '{}'::jsonb;
  v_line jsonb;
  v_line_no int;
  v_key text;
  v_col_list text;
  v_val_list text;
  v_code text;
begin
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated' using errcode = '42501';
  end if;

  if v_doc_id is null then
    v_doc_id := gen_random_uuid();
  end if;

  -- 1. Atomic Claim of op_id
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
    return jsonb_build_object(
      'success', (v_claim.existing_result = 'applied'),
      'status', 'duplicate',
      'is_duplicate', true,
      'original_result', v_claim.existing_result,
      'code', case
        when v_claim.existing_result = 'applied' then 'ok'
        when v_claim.existing_result = 'conflict' then 'conflict'
        else 'constraint'
      end,
      'error', v_claim.existing_error
    );
  end if;

  -- 2. Build clean header strictly from allowlist
  if p_header is not null then
    for v_key in select * from jsonb_object_keys(p_header) loop
      if v_key = any(v_allowed_header_cols) then
        v_clean_header := v_clean_header || jsonb_build_object(v_key, p_header -> v_key);
      end if;
    end loop;
  end if;

  begin
    -- 3. Insert Header (strictly as 'draft')
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

    -- 4. Insert Lines
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

    -- 5. Post Document (if requested)
    if p_post_now then
      update documents
      set status = 'posted',
          posted_at = now()
      where id = v_doc_id;
    end if;

    -- Finalize sync_ops as applied
    perform private._internal_finalize_sync_op(p_op_id, 'applied', null);

    return jsonb_build_object(
      'success', true,
      'status', 'applied',
      'code', 'ok',
      'op_id', p_op_id,
      'document_id', v_doc_id
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

grant execute on function sync_push_op(uuid, text, uuid, text, jsonb, int, timestamptz) to authenticated;
grant execute on function sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 6. RLS UPDATE POLICY HARDENING (WITH CHECK prevents branch relocation)
-- ---------------------------------------------------------------------

alter policy documents_update on documents with check (
  user_has_branch(branch_id) and (has_perm(doc_module(doc_type), 'edit') or has_perm(doc_module(doc_type), 'post') or is_admin())
);

alter policy journal_entries_update on journal_entries with check (
  user_has_branch(branch_id) and (has_perm('accounting', 'edit') or has_perm('accounting', 'post') or is_admin())
);

alter policy payments_update on payments with check (
  user_has_branch(branch_id) and (has_perm('treasury', 'edit') or has_perm('treasury', 'post') or is_admin())
);

