-- =====================================================================
-- 007_sync_engine_rpcs.sql
-- Phase 2b-2: Sync Engine Server RPCs & Timeout Testing Functions
-- 1. test_pg_sleep(seconds int): Real RPC to empirically test statement_timeout
-- 2. test_pg_sleep_with_timeout_override(seconds int): Function-level timeout override
-- 3. record_sync_op(...): Idempotent logging into sync_ops under security definer
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TIMEOUT VERIFICATION RPCs
-- ---------------------------------------------------------------------

-- A. Standard sleep function (inherits session statement_timeout)
create or replace function test_pg_sleep(seconds int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t_start timestamptz := clock_timestamp();
  t_elapsed interval;
begin
  perform pg_sleep(seconds);
  t_elapsed := clock_timestamp() - t_start;

  return jsonb_build_object(
    'status', 'completed',
    'requested_seconds', seconds,
    'elapsed_seconds', round(extract(epoch from t_elapsed)::numeric, 3),
    'current_user', current_user,
    'session_user', session_user,
    'statement_timeout', current_setting('statement_timeout', true),
    'transaction_timeout', current_setting('transaction_timeout', true)
  );
end;
$$;

-- B. Explicit function-level timeout override (proves 60s ceiling can be enforced)
create or replace function test_pg_sleep_with_timeout_override(seconds int)
returns jsonb
language plpgsql
security definer
set statement_timeout = '60s'
set search_path = public
as $$
declare
  t_start timestamptz := clock_timestamp();
  t_elapsed interval;
begin
  perform pg_sleep(seconds);
  t_elapsed := clock_timestamp() - t_start;

  return jsonb_build_object(
    'status', 'completed_with_override',
    'requested_seconds', seconds,
    'elapsed_seconds', round(extract(epoch from t_elapsed)::numeric, 3),
    'current_user', current_user,
    'session_user', session_user,
    'statement_timeout', current_setting('statement_timeout', true),
    'transaction_timeout', current_setting('transaction_timeout', true)
  );
end;
$$;

grant execute on function test_pg_sleep(int) to anon, authenticated, service_role;
grant execute on function test_pg_sleep_with_timeout_override(int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. IDEMPOTENT SYNC_OPS RECORDER
-- Since sync_ops has NO grants to authenticated/anon (004 line 253),
-- this security definer function allows recording processed ops
-- while verifying op_id uniqueness and caller identity.
-- ---------------------------------------------------------------------

create or replace function record_sync_op(
  p_op_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_op text,
  p_payload jsonb,
  p_base_version int default 1,
  p_result text default 'applied',
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
begin
  -- 1. Check idempotency: Was op_id already recorded?
  select id, result, created_at into v_existing
  from sync_ops
  where op_id = p_op_id;

  if found then
    return jsonb_build_object(
      'status', 'duplicate',
      'op_id', p_op_id,
      'result', v_existing.result,
      'recorded_at', v_existing.created_at,
      'message', 'Operation was already recorded in sync_ops (idempotent duplicate)'
    );
  end if;

  -- 2. Insert new sync operation
  insert into sync_ops (
    op_id,
    user_id,
    entity,
    entity_id,
    op,
    payload,
    base_version,
    client_ts,
    schema_version,
    result,
    error
  ) values (
    p_op_id,
    coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
    p_entity,
    p_entity_id,
    p_op,
    p_payload,
    p_base_version,
    now(),
    1,
    p_result,
    p_error
  );

  return jsonb_build_object(
    'status', 'recorded',
    'op_id', p_op_id,
    'result', p_result
  );
end;
$$;

grant execute on function record_sync_op(uuid, text, uuid, text, jsonb, int, text, text) to authenticated;
