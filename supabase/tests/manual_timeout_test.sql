-- =====================================================================
-- supabase/tests/manual_timeout_test.sql
-- Test-Only Manual Verification Script for PostgreSQL Role Timeouts
-- Run manually in Supabase SQL Editor as 'postgres' role.
-- 1. Creates temporary test function test_pg_sleep
-- 2. Strictly revokes access from PUBLIC, anon, authenticated
-- 3. Tests timeout behavior
-- 4. Cleans up by dropping the function at the end
-- =====================================================================

BEGIN;

-- 1. Create temporary testing function (SECURITY DEFINER, restricted to postgres)
create or replace function pg_temp.test_pg_sleep(seconds int)
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

-- 2. Strict Revocations: Ensure NO public, anon, or authenticated access
revoke all on function pg_temp.test_pg_sleep(int) from public, anon, authenticated;
grant execute on function pg_temp.test_pg_sleep(int) to postgres;

-- 3. Test execution under controlled timeout
do $$
declare
  res jsonb;
  t_start timestamptz := clock_timestamp();
begin
  -- Set local timeout for this test to 2 seconds
  perform set_config('statement_timeout', '2000', true);

  begin
    -- Attempting to sleep 4 seconds when timeout is 2 seconds
    select pg_temp.test_pg_sleep(4) into res;
    raise exception 'TEST FAILED: Statement was expected to timeout, but completed!';
  exception when query_canceled then
    raise notice '✓ VERIFIED: Statement timed out as expected after % (SQLSTATE 57014)', (clock_timestamp() - t_start);
  end;
end $$;

-- 4. Cleanup and rollback (leaves zero objects behind)
drop function if exists pg_temp.test_pg_sleep(int);

ROLLBACK;
