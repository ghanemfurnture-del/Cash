-- =====================================================================
-- supabase/migrations_draft/009_eta_readiness.sql
-- DRAFT ONLY - DO NOT APPLY TO DATABASE IN THIS PHASE
--
-- Phase 3+ Preparation: Egyptian Tax Authority (ETA) E-Invoicing Schema Readiness
--
-- Core Principles:
-- 1. Offline-First Decoupling: Local document posting (draft -> posted) is completely
--    independent of ETA submission. A cashier/accountant posts an invoice offline;
--    it becomes financially final and immutable locally without requiring internet or ETA approval.
-- 2. Async ETA Lifecycle Overlay: ETA synchronization runs asynchronously via a separate
--    overlay lifecycle (not_configured -> pending -> submitted -> valid / rejected / cancelled).
-- 3. Strict Accounting Immutability: Once a document is posted, financial columns
--    (total, tax, items, quantities) can NEVER be edited in place. Any correction
--    MUST be done via an official Credit Note ('c' / 'ec') or Debit Note ('d' / 'ed').
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. EXTEND PARTIES (Customers / Vendors) WITH ETA FIELDS
-- ---------------------------------------------------------------------
alter table public.parties
  add column if not exists party_type text not null default 'B'
    check (party_type in ('B', 'P', 'F')), -- B = Business (Company), P = Person (Consumer), F = Foreigner
  add column if not exists national_id varchar(14),
  add column if not exists country_code char(2) not null default 'EG',
  add column if not exists governorate text,
  add column if not exists city text,
  add column if not exists street text,
  add column if not exists building_no text,
  add column if not exists postal_code text;

comment on column public.parties.party_type is 'ETA Receiver Type: B (Company with Tax ID), P (Consumer/Individual with National ID), F (Foreign Entity)';
comment on column public.parties.national_id is 'Egyptian 14-digit National ID required for individual consumer invoices over statutory limits';

-- ---------------------------------------------------------------------
-- 2. EXTEND BRANCHES WITH ETA TAXPAYER ACTIVITY CODE
-- ---------------------------------------------------------------------
alter table public.branches
  add column if not exists activity_code text default '4690'; -- Default general wholesale/retail trade

comment on column public.branches.activity_code is 'Egyptian Tax Authority 4-digit activity code (e.g. 4690 for general wholesale/retail)';

-- ---------------------------------------------------------------------
-- 3. EXTEND ITEMS WITH ETA CODING STANDARDS
-- ---------------------------------------------------------------------
alter table public.items
  add column if not exists item_code_type text not null default 'EGS'
    check (item_code_type in ('GS1', 'EGS')),
  add column if not exists eta_item_code text;

comment on column public.items.item_code_type is 'Coding standard: GS1 (Global GTIN) or EGS (Egyptian Tax Authority standard EG-<TaxID>-<ItemCode>)';

-- ---------------------------------------------------------------------
-- 4. EXTEND UNITS WITH STANDARD ISO/ETA UNIT CODES
-- ---------------------------------------------------------------------
alter table public.units
  add column if not exists eta_unit_code text not null default 'EA'; -- EA = Each/Piece, KGM = Kilogram

comment on column public.units.eta_unit_code is 'UN/ECE & ETA standard measurement unit code (e.g. EA, C62, KGM, LTR)';

-- ---------------------------------------------------------------------
-- 5. EXTEND TAX CODES WITH OFFICIAL ETA TAX CODES
-- ---------------------------------------------------------------------
alter table public.tax_codes
  add column if not exists tax_type text not null default 'T1',
  add column if not exists sub_type text not null default 'V009';

comment on column public.tax_codes.tax_type is 'ETA Primary Tax Type: T1 (VAT), T2 (Table % ), T3 (Table fixed), T4 (Withholding)';
comment on column public.tax_codes.sub_type is 'ETA Subtype: V009 (General 14%), V001 (Export 0%), W002 (Supplies 1%), W004 (Services 3%)';

-- ---------------------------------------------------------------------
-- 6. EXTEND DOCUMENTS WITH ETA TRACKING OVERLAY
-- ---------------------------------------------------------------------
alter table public.documents
  add column if not exists eta_uuid text,
  add column if not exists eta_submission_uuid text,
  add column if not exists eta_status text not null default 'not_configured'
    check (eta_status in ('not_configured', 'pending', 'submitted', 'valid', 'invalid', 'cancelled', 'rejected')),
  add column if not exists eta_errors jsonb,
  add column if not exists service_delivery_date date,
  add column if not exists eta_synced_at timestamptz;

comment on column public.documents.eta_status is 'Asynchronous ETA lifecycle: not_configured -> pending -> submitted -> valid / invalid / cancelled';

-- ---------------------------------------------------------------------
-- 7. EXTEND DOCUMENT LINES FOR MULTI-TAX SUPPORT
-- ---------------------------------------------------------------------
alter table public.document_lines
  add column if not exists sales_total numeric(18,4),
  add column if not exists taxable_items jsonb; -- Array of {taxType, subType, rate, amount}

comment on column public.document_lines.taxable_items is 'JSONB array of multiple statutory taxes applied to a single line item (e.g. T1 VAT and T4 Withholding)';

-- ---------------------------------------------------------------------
-- 8. ARCHITECTURAL EXPLANATION: DECOUPLING & IMMUTABILITY COEXISTENCE
-- ---------------------------------------------------------------------
--
-- HOW LOCAL POSTING AND ETA SUBMISSION COEXIST:
--
-- 1. Phase 1 - Local Creation & Finalization:
--    The user creates an invoice offline in Dexie.
--    The invoice status is 'draft'. The user clicks 'Post' (ترحيل).
--    The status changes to 'posted' and posted_at = now().
--    Financial ledger entries and inventory movements are committed.
--    Trigger block_posted_changes locks all financial columns forever.
--
-- 2. Phase 2 - Asynchronous ETA Transmission:
--    When internet is available and ETA integration is enabled:
--    A background worker queries documents where status = 'posted' and eta_status in ('pending', 'invalid').
--    The worker generates the ETA v1.0 JSON, executes digital signing via local hardware token,
--    and submits to ETA API.
--    The ETA response returns submissionId and longUUID.
--    The system updates ONLY eta_submission_uuid, eta_uuid, and eta_status via a dedicated
--    metadata update routine that bypasses financial columns.
--
-- 3. Phase 3 - Corrections and Reversals:
--    Because posted documents are immutable, an error in an already-posted invoice
--    can NEVER be fixed by updating the original row.
--    If an error occurs or the customer returns goods:
--    - An official Credit Note ('c' or 'ec') is issued referencing the original document.
--    - The Credit Note posts its own offsetting journal entry.
--    - Both documents remain preserved in the audit trail, perfectly complying with
--      both Egyptian tax law and international GAAP/IFRS standards.
-- =====================================================================

