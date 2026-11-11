-- =====================================================================
-- supabase/migrations_draft/012_seed_tax_defaults_draft.sql
-- DRAFT SEED SCRIPT ONLY - DO NOT APPLY TO DATABASE IN THIS PHASE
--
-- Inserts default Egyptian tax codes and withholding rates as configurable data.
-- Every rate has an explicit status, rate percentage, and ETA mapping.
-- Withholding tax rates (T4) are disabled by default (is_active = false)
-- and can be activated by management decision upon CPA review.
-- =====================================================================

INSERT INTO public.tax_codes (
  id, code, name, rate, kind, tax_type, sub_type, is_active, version, server_seq
) VALUES
  -- 1. VAT (T1) Rates
  (
    '00000000-0000-0000-0000-000000000014',
    'VAT-14',
    'ضريبة القيمة المضافة العامة 14%',
    0.1400,
    'vat',
    'T1',
    'V009',
    true, -- ACTIVE DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'VAT-0-EXP',
    'ضريبة القيمة المضافة 0% - مبيعات التصدير للخارج',
    0.0000,
    'vat',
    'T1',
    'V001',
    true, -- ACTIVE FOR EXPORT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000005',
    'VAT-5-MAC',
    'ضريبة القيمة المضافة 5% - الآلات وخطوط الإنتاج',
    0.0500,
    'vat',
    'T1',
    'V006',
    false, -- INACTIVE BY DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    'VAT-0-EXM',
    'ضريبة القيمة المضافة 0% - سلع معفاة بنص القانون',
    0.0000,
    'vat',
    'T1',
    'V007',
    false, -- INACTIVE BY DEFAULT
    1,
    1
  ),

  -- 2. Withholding Tax (T4 - الخصم تحت حساب الضريبة)
  -- Disabled by default (is_active = false) until activated by management / accountant
  (
    '00000000-0000-0000-0000-000000000041',
    'WHT-SUP-1',
    'خصم أرباح تجارية 1% - توريدات ومشتريات بضائع',
    0.0100,
    'withholding',
    'T4',
    'W002',
    false, -- DISABLED BY DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000042',
    'WHT-CON-1',
    'خصم أرباح تجارية 1% - مقاولات وأعمال تشييد',
    0.0100,
    'withholding',
    'T4',
    'W001',
    false, -- DISABLED BY DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000043',
    'WHT-SER-3',
    'خصم أرباح تجارية 3% - خدمات وصيانة واستشارات',
    0.0300,
    'withholding',
    'T4',
    'W004',
    false, -- DISABLED BY DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000044',
    'WHT-COM-5',
    'خصم أرباح تجارية 5% - عمولات ووكالات وسمسرة',
    0.0500,
    'withholding',
    'T4',
    'W006',
    false, -- DISABLED BY DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000045',
    'WHT-PRF-5',
    'خصم أرباح مهنية 5% - أتعاب مهن غير تجارية',
    0.0500,
    'withholding',
    'T4',
    'W010',
    false, -- DISABLED BY DEFAULT
    1,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000046',
    'WHT-FOR-20',
    'خصم جهات غير مقيمة 20% - مدفوعات الخارج وإتاوات',
    0.2000,
    'withholding',
    'T4',
    'W013',
    false, -- DISABLED BY DEFAULT
    1,
    1
  )
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  rate = EXCLUDED.rate,
  kind = EXCLUDED.kind,
  tax_type = EXCLUDED.tax_type,
  sub_type = EXCLUDED.sub_type,
  is_active = EXCLUDED.is_active;

