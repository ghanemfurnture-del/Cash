-- =====================================================================
-- 007_sync_engine.sql
-- Phase 2b-2: Authoritative Single-Transaction Sync Engine RPCs
-- 1. Atomic Idempotent Claim & Bookkeeping for sync_ops
-- 2. sync_push_op: Single-entity mutation under caller JWT (SECURITY INVOKER)
--    - Entity allowlist enforcement
--    - Server-controlled column stripping (jsonb - array[...])
--    - Optimistic concurrency control (base_version matching)
--    - Non-silent RLS denial detection (checks row_count > 0)
--    - Soft delete enforcement (deleted_at = now())
-- 3. sync_push_document: Atomic Header + Lines + Posting bundle in ONE transaction
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. INTERNAL ATOMIC BOOKKEEPING FUNCTIONS (SECURITY DEFINER)
-- ---------------------------------------------------------------------

-- A. Atomic Claim of op_id:
-- Uses INSERT ... ON CONFLICT (op_id) DO NOTHING to eliminate race conditions.
-- Guarantees caller-scoped duplicate checking.
create or replace function _internal_claim_sync_op(
  p_op_id uuid,
  p_user_id uuid,
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
set search_path = public
as $$
declare
  v_rec record;
begin
  -- 1. Atomic insert attempt
  insert into sync_ops (
    op_id, user_id, entity, entity_id, op, payload,
    base_version, client_ts, schema_version, result, error
  ) values (
    p_op_id, p_user_id, p_entity, p_entity_id, p_op, p_payload,
    p_base_version, coalesce(p_client_ts, now()), 1, 'in_progress', null
  )
  on conflict (op_id) do nothing;

  -- 2. Inspect the current record for this op_id
  select user_id, result, error into v_rec
  from sync_ops
  where op_id = p_op_id;

  if not found then
    raise exception 'Critical error: sync_ops record not found after claim';
  end if;

  -- Check if owned by another user
  if v_rec.user_id <> p_user_id then
    return query select false, v_rec.result, 'Collision: op_id already claimed by another user'::text, true;
    return;
  end if;

  -- If result is 'in_progress', this transaction claimed it!
  if v_rec.result = 'in_progress' then
    return query select true, null::text, null::text, false;
  else
    -- Already completed in a prior transaction (applied or rejected)
    return query select false, v_rec.result, v_rec.error, false;
  end if;
end;
$$;

-- B. Finalize sync_op result within the same transaction
create or replace function _internal_finalize_sync_op(
  p_op_id uuid,
  p_result text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update sync_ops
  set result = p_result,
      error = p_error
  where op_id = p_op_id;
end;
$$;

revoke all on function _internal_claim_sync_op from public, anon;
revoke all on function _internal_finalize_sync_op from public, anon;

-- ---------------------------------------------------------------------
-- 2. AUTHORITATIVE SINGLE-ENTITY SYNC PUSH RPC (SECURITY INVOKER)
-- Runs under the caller's JWT, strictly enforcing RLS and audit_row!
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
set search_path = public
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_claim record;
  v_allowed_entities text[] := array[
    'documents', 'document_lines', 'journal_entries', 'journal_lines',
    'payments', 'items', 'parties', 'accounts', 'cost_centers',
    'tax_codes', 'units', 'currencies', 'warehouses', 'branches',
    'fiscal_years', 'fiscal_periods'
  ];
  v_clean_payload jsonb;
  v_rows_affected int := 0;
  v_current_version int;
  v_col_list text;
  v_val_list text;
  v_set_clause text;
  v_key text;
begin
  -- 0. Authentication Check
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated';
  end if;

  -- 1. Operation Validation
  if p_op not in ('insert', 'update', 'delete', 'post', 'reverse') then
    return jsonb_build_object('success', false, 'status', 'rejected', 'error', 'Invalid operation: ' || coalesce(p_op, 'NULL'));
  end if;

  -- 2. Entity Allowlist Check
  if not (p_entity = any(v_allowed_entities)) then
    return jsonb_build_object('success', false, 'status', 'rejected', 'error', 'Entity not allowed for sync: ' || coalesce(p_entity, 'NULL'));
  end if;

  -- 3. Atomic Claim of op_id
  select * into v_claim from _internal_claim_sync_op(
    p_op_id, v_caller_uid, p_entity, p_entity_id, p_op, p_payload, p_base_version, p_client_ts
  );

  if v_claim.is_other_user then
    return jsonb_build_object('success', false, 'status', 'rejected', 'error', 'Operation ID collision: op_id belongs to another user');
  end if;

  if not v_claim.is_claimed then
    -- Idempotent Duplicate: Return original outcome (applied or rejected)
    return jsonb_build_object(
      'success', (v_claim.existing_result = 'applied'),
      'status', 'duplicate',
      'is_duplicate', true,
      'original_result', v_claim.existing_result,
      'error', v_claim.existing_error
    );
  end if;

  -- 4. Column Control: Strip server-controlled columns from client payload
  -- id, server_seq, version, created_at/by, updated_at/by, deleted_at, status, posted_at
  v_clean_payload := p_payload - array[
    'id', 'server_seq', 'version', 'created_at', 'created_by',
    'updated_at', 'updated_by', 'deleted_at', 'status', 'posted_at'
  ];

  -- 5. Business Operation Execution with Savepoint for Permanent Error Logging
  begin
    -- -----------------------------------------------------------------
    -- A. INSERT
    -- -----------------------------------------------------------------
    if p_op = 'insert' then
      -- Prepare columns and values dynamically
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
      -- Optimistic Concurrency Check
      if p_base_version is not null then
        execute format('select version from %I where id = $1', p_entity) into v_current_version using p_entity_id;
        if v_current_version is not null and v_current_version <> p_base_version then
          raise exception 'Optimistic concurrency conflict on % (%): server version % does not match base_version %',
            p_entity, p_entity_id, v_current_version, p_base_version;
        end if;
      end if;

      select string_agg(format('%I = %L', key, value #>> '{}'), ', ')
      into v_set_clause
      from jsonb_each(v_clean_payload);

      if v_set_clause is not null then
        execute format('update %I set %s where id = $1', p_entity, v_set_clause) using p_entity_id;
        get diagnostics v_rows_affected = row_count;
        if v_rows_affected = 0 then
          raise exception 'Update affected 0 rows on % (%): row not found or denied by RLS', p_entity, p_entity_id;
        end if;
      end if;

    -- -----------------------------------------------------------------
    -- C. DELETE -> SOFT DELETE (deleted_at = now())
    -- -----------------------------------------------------------------
    elsif p_op = 'delete' then
      if p_base_version is not null then
        execute format('select version from %I where id = $1', p_entity) into v_current_version using p_entity_id;
        if v_current_version is not null and v_current_version <> p_base_version then
          raise exception 'Optimistic concurrency conflict on delete % (%): server version % does not match base_version %',
            p_entity, p_entity_id, v_current_version, p_base_version;
        end if;
      end if;

      execute format('update %I set deleted_at = now() where id = $1 and deleted_at is null', p_entity) using p_entity_id;
      get diagnostics v_rows_affected = row_count;
      if v_rows_affected = 0 then
        raise exception 'Delete affected 0 rows on % (%): row not found, already deleted, or denied by RLS', p_entity, p_entity_id;
      end if;

    -- -----------------------------------------------------------------
    -- D. POST (Status strictly set to 'posted')
    -- -----------------------------------------------------------------
    elsif p_op = 'post' then
      select string_agg(format('%I = %L', key, value #>> '{}'), ', ')
      into v_set_clause
      from jsonb_each(v_clean_payload);

      if v_set_clause is not null then
        execute format('update %I set %s, status = ''posted'', posted_at = now() where id = $1', p_entity, v_set_clause) using p_entity_id;
      else
        execute format('update %I set status = ''posted'', posted_at = now() where id = $1', p_entity) using p_entity_id;
      end if;

      get diagnostics v_rows_affected = row_count;
      if v_rows_affected = 0 then
        raise exception 'Post affected 0 rows on % (%): row not found or denied by RLS', p_entity, p_entity_id;
      end if;

    -- -----------------------------------------------------------------
    -- E. REVERSE (Status strictly set to 'reversed')
    -- -----------------------------------------------------------------
    elsif p_op = 'reverse' then
      execute format('update %I set status = ''reversed'' where id = $1', p_entity) using p_entity_id;
      get diagnostics v_rows_affected = row_count;
      if v_rows_affected = 0 then
        raise exception 'Reverse affected 0 rows on % (%): row not found or denied by RLS', p_entity, p_entity_id;
      end if;
    end if;

    -- Finalize sync_op as applied
    perform _internal_finalize_sync_op(p_op_id, 'applied', null);

    return jsonb_build_object(
      'success', true,
      'status', 'applied',
      'op_id', p_op_id,
      'entity', p_entity,
      'entity_id', p_entity_id
    );

  exception when others then
    -- Check if error is transient (e.g. query_canceled 57014 / statement_timeout)
    if sqlstate = '57014' or sqlstate = '40P01' then
      -- Re-raise transient errors so the transaction aborts and allows clean retry!
      raise;
    end if;

    -- Permanent error (RLS denial, check constraint, unique violation, version conflict)
    -- Record as 'rejected' in sync_ops so subsequent retries return duplicate rejected
    perform _internal_finalize_sync_op(p_op_id, 'rejected', sqlerrm);

    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'op_id', p_op_id,
      'error', sqlerrm,
      'sqlstate', sqlstate
    );
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. AUTHORITATIVE ATOMIC DOCUMENT BUNDLE PUSH RPC (SECURITY INVOKER)
-- Inserts Header + Lines + Posts in ONE single transaction
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
set search_path = public
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_claim record;
  v_doc_id uuid := (p_header ->> 'id')::uuid;
  v_branch_id uuid := (p_header ->> 'branch_id')::uuid;
  v_doc_type text := p_header ->> 'doc_type';
  v_clean_header jsonb;
  v_line jsonb;
  v_line_no int;
  v_col_list text;
  v_val_list text;
begin
  if v_caller_uid is null then
    raise exception 'Unauthorized: caller must be authenticated';
  end if;

  if v_doc_id is null then
    v_doc_id := gen_random_uuid();
  end if;

  -- 1. Atomic Claim of op_id
  select * into v_claim from _internal_claim_sync_op(
    p_op_id, v_caller_uid, 'documents', v_doc_id, case when p_post_now then 'post' else 'insert' end,
    p_header, null, p_client_ts
  );

  if v_claim.is_other_user then
    return jsonb_build_object('success', false, 'status', 'rejected', 'error', 'Operation ID collision with another user');
  end if;

  if not v_claim.is_claimed then
    return jsonb_build_object(
      'success', (v_claim.existing_result = 'applied'),
      'status', 'duplicate',
      'is_duplicate', true,
      'original_result', v_claim.existing_result,
      'error', v_claim.existing_error
    );
  end if;

  -- 2. Strip server columns from header
  v_clean_header := p_header - array[
    'id', 'server_seq', 'version', 'created_at', 'created_by',
    'updated_at', 'updated_by', 'deleted_at', 'status', 'posted_at'
  ];

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
    perform _internal_finalize_sync_op(p_op_id, 'applied', null);

    return jsonb_build_object(
      'success', true,
      'status', 'applied',
      'op_id', p_op_id,
      'document_id', v_doc_id
    );

  exception when others then
    if sqlstate = '57014' or sqlstate = '40P01' then
      raise;
    end if;

    perform _internal_finalize_sync_op(p_op_id, 'rejected', sqlerrm);

    return jsonb_build_object(
      'success', false,
      'status', 'rejected',
      'op_id', p_op_id,
      'error', sqlerrm,
      'sqlstate', sqlstate
    );
  end;
end;
$$;

-- Grant execution to authenticated only (NO anon, NO public)
grant execute on function sync_push_op(uuid, text, uuid, text, jsonb, int, timestamptz) to authenticated;
grant execute on function sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz) to authenticated;
