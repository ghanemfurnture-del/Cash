BEGIN;
-- =====================================================================
-- supabase/tests/migration_008_validation_test.sql
-- Validation Test Suite for Migration 008 (sync_push_document hardening)
--
-- TABLES AND COLUMNS REFERENCED:
-- 1. auth.users: id, aud, role, email, created_at, updated_at, instance_id
-- 2. roles: id, name, description
-- 3. profiles: id, full_name, role_id, is_active
-- 4. branches: id, code, name_ar, is_active
-- 5. user_branches: id, user_id, branch_id
-- 6. units: id, name_ar
-- 7. items: id, sku, name_ar, base_unit_id, sale_price, is_active
-- 8. documents: id, doc_type, series_code, seq_no, doc_no, doc_date, branch_id, total, notes, status, version, server_seq
-- 9. document_lines: id, document_id, line_no, item_id, description, unit_id, qty, unit_factor, unit_price, discount_amount, tax_rate, tax_amount, line_total
-- 10. sync_ops: op_id, user_id, entity, entity_id, op, result, error
-- 11. private functions: private._internal_claim_sync_op, private._internal_finalize_sync_op, private._internal_get_sync_op_entity
-- 12. test_results (temp table): test_no, test_name, status, details
-- =====================================================================

CREATE TEMP TABLE test_results (
  test_no int,
  test_name text,
  status text,
  details text
) ON COMMIT DROP;

GRANT ALL ON TABLE test_results TO authenticated;

DO $$
DECLARE
  v_admin_uid uuid := 'aaaaaaaa-0000-4000-a000-aaaaaaaaaaaa';
  v_branch_id uuid;
  v_role_admin uuid;

  v_doc_id_1line  uuid := '99999999-9999-4999-8999-999999999901';
  v_line_id_1     uuid := '99999999-9999-4999-8999-999999999902';
  v_doc_id_2lines uuid := '99999999-9999-4999-8999-999999999911';
  v_line_id_2a    uuid := '99999999-9999-4999-8999-999999999912';
  v_line_id_2b    uuid := '99999999-9999-4999-8999-999999999913';

  v_item_id1 uuid := '88888888-8888-4888-8888-888888888801';
  v_item_id2 uuid := '88888888-8888-4888-8888-888888888802';
  v_unit_id  uuid;

  v_op_id_missing uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001';
  v_op_id_invalid uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0002';
  v_op_id_valid1  uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0003';
  v_op_id_valid2  uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0004';
  v_op_id_nonreg  uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0005';

  v_res jsonb;
  v_res_dup jsonb;
  v_doc_count int;
  v_line_count int;
  v_anon_priv boolean;
  v_public_priv boolean;
  v_auth_priv boolean;
  v_sec_definer_auth boolean;
  v_sec_definer_anon boolean;
BEGIN
  -- 0. FIXTURES SETUP
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT id INTO v_role_admin FROM roles WHERE name = 'Admin';
  IF v_role_admin IS NULL THEN
    INSERT INTO roles (name, description) VALUES ('Admin', 'مدير النظام') RETURNING id INTO v_role_admin;
  END IF;

  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
    VALUES (v_admin_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test_admin_008@cash.local', now(), now())
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
    VALUES (v_admin_uid, 'authenticated', 'authenticated', 'test_admin_008@cash.local', now(), now())
    ON CONFLICT (id) DO NOTHING;
  END;

  INSERT INTO profiles (id, full_name, role_id, is_active)
  VALUES (v_admin_uid, 'مدير اختبار هجرة 008', v_role_admin, true)
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, role_id = EXCLUDED.role_id, is_active = EXCLUDED.is_active;

  SELECT id INTO v_branch_id FROM branches WHERE code = 'B008';
  IF v_branch_id IS NULL THEN
    INSERT INTO branches (code, name_ar, is_active) VALUES ('B008', 'فرع اختبار 008', true) RETURNING id INTO v_branch_id;
  END IF;

  INSERT INTO user_branches (user_id, branch_id) VALUES (v_admin_uid, v_branch_id) ON CONFLICT (user_id, branch_id) DO NOTHING;

  SELECT id INTO v_unit_id FROM units LIMIT 1;
  IF v_unit_id IS NULL THEN
    INSERT INTO units (name_ar) VALUES ('قطعة اختبار 008') RETURNING id INTO v_unit_id;
  END IF;

  INSERT INTO items (id, sku, name_ar, base_unit_id, sale_price, is_active)
  VALUES (v_item_id1, 'SKU-008-ITEM1', 'صنف تجريبي 1', v_unit_id, 125, true)
  ON CONFLICT (id) DO UPDATE SET name_ar = EXCLUDED.name_ar, base_unit_id = EXCLUDED.base_unit_id;

  INSERT INTO items (id, sku, name_ar, base_unit_id, sale_price, is_active)
  VALUES (v_item_id2, 'SKU-008-ITEM2', 'صنف تجريبي 2', v_unit_id, 50, true)
  ON CONFLICT (id) DO UPDATE SET name_ar = EXCLUDED.name_ar, base_unit_id = EXCLUDED.base_unit_id;

  -- TEST 1: Missing header.id -> REJECTED (validation, 22000)
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    SELECT sync_push_document(
      v_op_id_missing,
      jsonb_build_object('doc_type','sales_invoice','series_code','INV','seq_no',991,'doc_no','INV-991','branch_id',v_branch_id,'doc_date',current_date,'total',500),
      '[]'::jsonb, false, now()
    ) INTO v_res;
    RESET ROLE;

    IF (v_res ->> 'success')::boolean = false AND (v_res ->> 'status') = 'rejected' AND (v_res ->> 'code') = 'validation' AND (v_res ->> 'sqlstate') = '22000' THEN
      INSERT INTO test_results VALUES (1, 'sync_push_document missing header.id is rejected', 'PASS', format('code=validation, sqlstate=22000: %s', v_res ->> 'error'));
    ELSE
      INSERT INTO test_results VALUES (1, 'sync_push_document missing header.id is rejected', 'FAIL', format('Unexpected: %s', v_res::text));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO test_results VALUES (1, 'sync_push_document missing header.id is rejected', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

  -- TEST 2: Invalid UUID format in header.id -> REJECTED (validation, 22000)
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    SELECT sync_push_document(
      v_op_id_invalid,
      jsonb_build_object('id','not-a-valid-uuid-value','doc_type','sales_invoice','series_code','INV','seq_no',992,'doc_no','INV-992','branch_id',v_branch_id,'doc_date',current_date,'total',500),
      '[]'::jsonb, false, now()
    ) INTO v_res;
    RESET ROLE;

    IF (v_res ->> 'success')::boolean = false AND (v_res ->> 'status') = 'rejected' AND (v_res ->> 'code') = 'validation' AND (v_res ->> 'sqlstate') = '22000' THEN
      INSERT INTO test_results VALUES (2, 'sync_push_document invalid UUID header.id is rejected', 'PASS', format('code=validation, sqlstate=22000: %s', v_res ->> 'error'));
    ELSE
      INSERT INTO test_results VALUES (2, 'sync_push_document invalid UUID header.id is rejected', 'FAIL', format('Unexpected: %s', v_res::text));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO test_results VALUES (2, 'sync_push_document invalid UUID header.id is rejected', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

  -- TEST 3: Valid 1-line bundle -> APPLIED
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    SELECT sync_push_document(
      v_op_id_valid1,
      jsonb_build_object('id',v_doc_id_1line,'doc_type','sales_invoice','series_code','INV','seq_no',993,'doc_no','INV-993','branch_id',v_branch_id,'doc_date',current_date,'total',250,'notes','فاتورة 1'),
      jsonb_build_array(jsonb_build_object('id',v_line_id_1,'line_no',1,'item_id',v_item_id1,'description','بند 1','unit_id',v_unit_id,'qty',2,'unit_factor',1,'unit_price',125,'line_total',250)),
      false, now()
    ) INTO v_res;
    RESET ROLE;

    SELECT count(*) INTO v_doc_count FROM documents WHERE id = v_doc_id_1line;
    SELECT count(*) INTO v_line_count FROM document_lines WHERE document_id = v_doc_id_1line;

    IF (v_res ->> 'success')::boolean = true AND (v_res ->> 'status') = 'applied' AND (v_res -> 'server_row' ->> 'id') = v_doc_id_1line::text AND jsonb_array_length(v_res -> 'lines') = 1 AND v_doc_count = 1 AND v_line_count = 1 THEN
      INSERT INTO test_results VALUES (3, 'sync_push_document valid 1-line bundle applied successfully', 'PASS', format('doc_id=%s, lines=1', v_doc_id_1line));
    ELSE
      INSERT INTO test_results VALUES (3, 'sync_push_document valid 1-line bundle applied successfully', 'FAIL', format('res=%s, docs=%s, lines=%s', v_res::text, v_doc_count, v_line_count));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO test_results VALUES (3, 'sync_push_document valid 1-line bundle applied successfully', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

  -- TEST 4: Valid bundle with >= 2 lines -> APPLIED & VERIFIED IN DB
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    SELECT sync_push_document(
      v_op_id_valid2,
      jsonb_build_object('id',v_doc_id_2lines,'doc_type','sales_invoice','series_code','INV','seq_no',994,'doc_no','INV-994','branch_id',v_branch_id,'doc_date',current_date,'total',350,'notes','فاتورة سطرين'),
      jsonb_build_array(
        jsonb_build_object('id',v_line_id_2a,'line_no',1,'item_id',v_item_id1,'description','بند 1','unit_id',v_unit_id,'qty',2,'unit_factor',1,'unit_price',100,'line_total',200),
        jsonb_build_object('id',v_line_id_2b,'line_no',2,'item_id',v_item_id2,'description','بند 2','unit_id',v_unit_id,'qty',3,'unit_factor',1,'unit_price',50,'line_total',150)
      ),
      false, now()
    ) INTO v_res;
    RESET ROLE;

    SELECT count(*) INTO v_doc_count FROM documents WHERE id = v_doc_id_2lines;
    SELECT count(*) INTO v_line_count FROM document_lines WHERE document_id = v_doc_id_2lines;

    IF (v_res ->> 'success')::boolean = true AND (v_res ->> 'status') = 'applied' AND (v_res -> 'server_row' ->> 'id') = v_doc_id_2lines::text AND jsonb_array_length(v_res -> 'lines') = 2 AND v_doc_count = 1 AND v_line_count = 2 THEN
      INSERT INTO test_results VALUES (4, 'sync_push_document multi-line bundle (>= 2 lines) recorded', 'PASS', format('doc_id=%s, db lines=%s', v_doc_id_2lines, v_line_count));
    ELSE
      INSERT INTO test_results VALUES (4, 'sync_push_document multi-line bundle (>= 2 lines) recorded', 'FAIL', format('res=%s, docs=%s, lines=%s', v_res::text, v_doc_count, v_line_count));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO test_results VALUES (4, 'sync_push_document multi-line bundle (>= 2 lines) recorded', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

  -- TEST 5: Duplicate retry with same op_id -> DUPLICATE (authoritative entity_id via security definer helper)
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    -- Call with identical op_id and omitted header.id on retry to test authoritative lookup
    SELECT sync_push_document(
      v_op_id_valid1,
      jsonb_build_object('doc_type','sales_invoice','series_code','INV','seq_no',993,'doc_no','INV-993','branch_id',v_branch_id,'doc_date',current_date,'total',250),
      '[]'::jsonb, false, now()
    ) INTO v_res_dup;
    RESET ROLE;

    IF (v_res_dup ->> 'success')::boolean = true AND (v_res_dup ->> 'status') = 'duplicate' AND (v_res_dup ->> 'is_duplicate')::boolean = true AND (v_res_dup ->> 'original_result') = 'applied' AND (v_res_dup ->> 'document_id') = v_doc_id_1line::text AND (v_res_dup -> 'server_row' ->> 'id') = v_doc_id_1line::text AND jsonb_array_length(v_res_dup -> 'lines') = 1 THEN
      INSERT INTO test_results VALUES (5, 'Duplicate retry returns authoritative entity_id and lines', 'PASS', format('document_id=%s recovered via helper', v_res_dup ->> 'document_id'));
    ELSE
      INSERT INTO test_results VALUES (5, 'Duplicate retry returns authoritative entity_id and lines', 'FAIL', format('Unexpected: %s', v_res_dup::text));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO test_results VALUES (5, 'Duplicate retry returns authoritative entity_id and lines', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

  -- TEST 6: Privilege isolation: anon/public revoked, authenticated granted
  BEGIN
    EXECUTE 'RESET ROLE';

    SELECT has_function_privilege('anon', 'public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz)', 'EXECUTE') INTO v_anon_priv;
    SELECT has_function_privilege('public', 'public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz)', 'EXECUTE') INTO v_public_priv;
    SELECT has_function_privilege('authenticated', 'public.sync_push_document(uuid, jsonb, jsonb, boolean, timestamptz)', 'EXECUTE') INTO v_auth_priv;

    SELECT has_function_privilege('authenticated', 'private._internal_get_sync_op_entity(uuid)', 'EXECUTE') INTO v_sec_definer_auth;
    SELECT has_function_privilege('anon', 'private._internal_get_sync_op_entity(uuid)', 'EXECUTE') INTO v_sec_definer_anon;

    IF v_anon_priv = false AND v_public_priv = false AND v_auth_priv = true AND v_sec_definer_auth = true AND v_sec_definer_anon = false THEN
      INSERT INTO test_results VALUES (6, 'Permission checks: public/anon revoked, authenticated granted', 'PASS', 'sync_push_document & _internal_get_sync_op_entity permissions verified');
    ELSE
      INSERT INTO test_results VALUES (6, 'Permission checks: public/anon revoked, authenticated granted', 'FAIL', format('Mismatch: anon=%s, pub=%s, auth=%s, helper_auth=%s, helper_anon=%s', v_anon_priv, v_public_priv, v_auth_priv, v_sec_definer_auth, v_sec_definer_anon));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO test_results VALUES (6, 'Permission checks: public/anon revoked, authenticated granted', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

  -- TEST 7: Non-regression check on sync_push_op
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

    SELECT sync_push_op(v_op_id_nonreg, 'items', v_item_id1, 'update', jsonb_build_object('sale_price', 150), 1, now()) INTO v_res;
    RESET ROLE;

    IF (v_res ->> 'success')::boolean = true AND (v_res ->> 'status') = 'applied' AND (v_res -> 'server_row' ->> 'id') = v_item_id1::text AND (v_res -> 'server_row' ->> 'sale_price')::numeric = 150 THEN
      INSERT INTO test_results VALUES (7, 'sync_push_op non-regression check', 'PASS', format('price=%s, version=%s', v_res -> 'server_row' ->> 'sale_price', v_res -> 'server_row' ->> 'version'));
    ELSE
      INSERT INTO test_results VALUES (7, 'sync_push_op non-regression check', 'FAIL', format('Unexpected: %s', v_res::text));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO test_results VALUES (7, 'sync_push_op non-regression check', 'FAIL', format('Exception: %s (%s)', SQLERRM, SQLSTATE));
  END;

END $$;

SELECT test_no, test_name, status, details FROM test_results ORDER BY test_no;

ROLLBACK;
