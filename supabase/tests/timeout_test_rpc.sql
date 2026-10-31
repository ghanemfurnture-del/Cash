-- =====================================================================
-- supabase/tests/timeout_test_rpc.sql
-- Temporary Test-Only RPC for Empirical Timeout Measurement via PostgREST
-- =====================================================================

-- ---------------------------------------------------------------------
-- STEP 1: SETUP TEST SCHEMA AND RPC (Run in Supabase SQL Editor as postgres)
-- ---------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS test_timeout;

CREATE OR REPLACE FUNCTION test_timeout.pg_sleep_test(seconds int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_start timestamptz := clock_timestamp();
  t_elapsed interval;
BEGIN
  PERFORM pg_sleep(seconds);
  t_elapsed := clock_timestamp() - t_start;

  RETURN jsonb_build_object(
    'status', 'completed',
    'requested_seconds', seconds,
    'elapsed_seconds', round(extract(epoch from t_elapsed)::numeric, 3),
    'current_user', current_user,
    'session_user', session_user,
    'statement_timeout', current_setting('statement_timeout', true),
    'transaction_timeout', current_setting('transaction_timeout', true)
  );
END;
$$;

GRANT USAGE ON SCHEMA test_timeout TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION test_timeout.pg_sleep_test(int) TO authenticated, service_role;
REVOKE ALL ON SCHEMA test_timeout FROM public, anon;
REVOKE ALL ON FUNCTION test_timeout.pg_sleep_test(int) FROM public, anon;

-- Proxy in public schema so PostgREST route /rpc/pg_sleep_test is callable
CREATE OR REPLACE FUNCTION public.pg_sleep_test(seconds int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = test_timeout, public
AS $$
BEGIN
  RETURN test_timeout.pg_sleep_test(seconds);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pg_sleep_test(int) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.pg_sleep_test(int) FROM public, anon;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- STEP 2: REST CALLS FROM POWERSHELL (Provided in Report)
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- STEP 3: CLEANUP SCRIPT (Run after testing to remove all test objects)
-- ---------------------------------------------------------------------
/*
DROP FUNCTION IF EXISTS public.pg_sleep_test(int);
DROP SCHEMA IF EXISTS test_timeout CASCADE;
NOTIFY pgrst, 'reload schema';
*/
