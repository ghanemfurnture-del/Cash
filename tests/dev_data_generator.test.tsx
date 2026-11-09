// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { db } from '../src/db';
import { DevDataGenerator } from '../src/modules/dev/DevDataGenerator';

describe('Phase 2b-3b Stage A Item 6: Dev-Only Mock Data Generator Suite', () => {
  beforeEach(async () => {
    await db.documents.clear();
    await db.document_lines.clear();
    await db.items.clear();
    await db.parties.clear();
    await db.accounts.clear();
    await db.branches.clear();
    await db.outbox.clear();
    await db.sync_meta.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('PRODUCTION SAFETY: does not render anything if import.meta.env.DEV is false', () => {
    // Temporarily mock import.meta.env.DEV as false
    const originalDev = import.meta.env.DEV;
    (import.meta.env as any).DEV = false;

    try {
      const { container } = render(<DevDataGenerator />);
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('dev-data-generator')).toBeNull();
    } finally {
      (import.meta.env as any).DEV = originalDev;
    }
  });

  it('DEV ENVIRONMENT: generates exactly 10 mock documents (INV-D1-000001 to INV-D1-000010), outbox items, and tags with is_mock', async () => {
    render(<DevDataGenerator />);

    const generateBtn = screen.getByRole('button', { name: /توليد 10 فواتير وبيانات تجريبية/i });
    expect(generateBtn).toBeDefined();

    fireEvent.click(generateBtn);

    await waitFor(async () => {
      const docsCount = await db.documents.count();
      expect(docsCount).toBe(10);
    });

    // Verify 10 documents
    const allDocs = await db.documents.toArray();
    const docs = allDocs.sort((a, b) => a.seq_no - b.seq_no);
    expect(docs.length).toBe(10);
    expect(docs[0].doc_no).toBe('INV-D1-000001');
    expect(docs[9].doc_no).toBe('INV-D1-000010');

    for (const doc of docs) {
      expect((doc as any).is_mock).toBe(true);
      expect((doc as any).series_code).toBe('D1');
    }

    // Verify document lines
    const linesCount = await db.document_lines.count();
    expect(linesCount).toBe(10);

    // Verify Outbox pending operations
    const outboxOps = await db.outbox.toArray();
    expect(outboxOps.length).toBe(3);
    for (const op of outboxOps) {
      expect((op.payload as any).is_mock).toBe(true);
    }

    // Verify counter
    const counter = await db.sync_meta.get('counter:sale_invoice:D1');
    expect(counter?.value).toBe(10);

    // Verify parties, items, branches, accounts
    expect(await db.branches.count()).toBe(1);
    expect(await db.items.count()).toBe(2);
    expect(await db.parties.count()).toBe(2);
    expect(await db.accounts.count()).toBe(4);
  });

  it('PROTECTION: requires explicit confirmation phrase if real (non-mock) data exists', async () => {
    // Insert a real non-mock document
    await db.documents.put({
      id: crypto.randomUUID(),
      doc_type: 'sale_invoice',
      series_code: 'D1',
      seq_no: 100,
      doc_no: 'INV-D1-000100',
      total: 5000,
      status: 'draft',
      version: 1,
      server_seq: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // NOT tagged as mock!
    });

    render(<DevDataGenerator />);

    await waitFor(() => {
      expect(screen.getByText(/توجد بيانات غير تجريبية في النظام/i)).toBeDefined();
    });

    const generateBtn = screen.getByRole('button', { name: /توليد 10 فواتير وبيانات تجريبية/i });
    expect((generateBtn as HTMLButtonElement).disabled).toBe(true);

    // Type the exact confirmation phrase
    const input = screen.getByPlaceholderText(/اكتب العبارة هنا للمتابعة/i);
    fireEvent.change(input, { target: { value: 'تأكيد توليد بيانات تجريبية' } });

    expect((generateBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('PURGE: clears only mock records and preserves non-mock records', async () => {
    // 1. Seed real document
    const realDocId = crypto.randomUUID();
    await db.documents.put({
      id: realDocId,
      doc_type: 'sale_invoice',
      series_code: 'D1',
      seq_no: 500,
      doc_no: 'INV-D1-000500',
      total: 9000,
      status: 'posted',
      version: 1,
      server_seq: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // real!
    });

    // 2. Seed mock documents
    await db.documents.put({
      id: 'mock-1',
      doc_type: 'sale_invoice',
      series_code: 'D1',
      seq_no: 1,
      doc_no: 'INV-D1-000001',
      total: 1000,
      status: 'draft',
      is_mock: true,
      version: 1,
      server_seq: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    render(<DevDataGenerator />);

    const clearBtn = screen.getByRole('button', { name: /مسح البيانات التجريبية فقط/i });
    fireEvent.click(clearBtn);

    await waitFor(async () => {
      const remainingDocs = await db.documents.toArray();
      expect(remainingDocs.length).toBe(1);
      expect(remainingDocs[0].id).toBe(realDocId);
    });
  });
});
