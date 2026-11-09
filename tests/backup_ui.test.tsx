// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { BackupPage } from '../src/modules/backup/BackupPage';
import * as backupService from '../src/services/backup/backupService';
import * as restoreService from '../src/services/backup/restoreService';
import * as persistenceService from '../src/services/backup/persistenceService';
import type { RestorePreview } from '../src/services/backup/types';

describe('Phase 2b-3b Stage A: BackupPage UI Components', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default persistence status
    vi.spyOn(persistenceService, 'getPersistenceStatus').mockResolvedValue({
      isPersisted: false,
      isStandalone: false,
      isIosSafari: true,
      usageBytes: 15 * 1024 * 1024,
      quotaBytes: 2 * 1024 * 1024 * 1024,
      warningMessage: 'التخزين المحلي مؤقت؛ قد يقوم متصفح Safari بمسح البيانات بعد 7 أيام.',
    });

    vi.spyOn(persistenceService, 'requestPersistentStorage').mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders persistence status and warning for iOS Safari', async () => {
    render(<BackupPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/حالة استدامة التخزين المحلي/i)
      ).toBeTruthy();
    });

    expect(screen.getByText(/تنبيه لأجهزة iOS و Safari:/i)).toBeTruthy();
    expect(screen.getByText(/تثبيت التخزين/i)).toBeTruthy();
  });

  it('shows loading indicator with PBKDF2 iterations during export', async () => {
    // Mock exportEncryptedBackup with a slight delay
    vi.spyOn(backupService, 'exportEncryptedBackup').mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Uint8Array([1, 2, 3])), 100)
        )
    );
    vi.spyOn(backupService, 'downloadBackupFile').mockImplementation(() => {});

    render(<BackupPage />);

    // Fill password
    const passwordInputs = screen.getAllByPlaceholderText(/كلمة مرور/i);
    fireEvent.change(passwordInputs[0], { target: { value: 'Secret123!' } });
    fireEvent.change(screen.getByPlaceholderText(/أعد كتابة كلمة المرور/i), {
      target: { value: 'Secret123!' },
    });

    // Click Export
    const exportBtn = screen.getByRole('button', {
      name: /تصدير وتحميل ملف النسخة الاحتياطية/i,
    });
    fireEvent.click(exportBtn);

    // Assert waiting indicator with PBKDF2 mention appears
    await waitFor(() => {
      expect(screen.getByText(/600,000 دورة/i)).toBeTruthy();
    });
  });

  it('opens preview modal, displays unsynced work alert, "Sync first", "Export safety backup", and requires exact confirmation phrase', async () => {
    const mockPreview: RestorePreview = {
      metadata: {
        backup_created_at: '2026-11-04T10:00:00.000Z',
        source_device_id: 'DEV-1',
        source_device_code: 'D1',
        source_branch_id: 'BRANCH-1',
        app_version: '1.0.0',
        schema_version: 7,
        format_version: 1,
        record_counts: { documents: 10, parties: 5 },
      },
      tableComparisons: [
        { table: 'documents', localCount: 15, backupCount: 10 },
        { table: 'outbox', localCount: 2, backupCount: 0 },
      ],
      unsyncedWork: {
        outboxCount: 2,
        unsyncedDocCount: 5,
        items: ['عملية غير مرفوعة 1', 'مستند محلي 101'],
      },
      requiresExplicitConfirmation: true,
      payload: {
        metadata: {} as any,
        data: {},
        outbox: [],
        sync_meta: [],
      },
    };

    vi.spyOn(restoreService, 'inspectBackupFile').mockResolvedValue(mockPreview);
    const executeRestoreSpy = vi.spyOn(restoreService, 'executeRestore').mockResolvedValue(undefined);

    render(<BackupPage />);

    // Select file & password
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['dummy-content'], 'test.cashbak', {
      type: 'application/octet-stream',
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const restorePasswordInput = screen.getByPlaceholderText(
      /أدخل كلمة المرور الخاصة بالملف/i
    );
    fireEvent.change(restorePasswordInput, { target: { value: 'Password123!' } });

    // Click inspect
    const inspectBtn = screen.getByRole('button', {
      name: /فحص ومعاينة النسخة الاحتياطية/i,
    });
    fireEvent.click(inspectBtn);

    // Modal opens
    await waitFor(() => {
      expect(
        screen.getByText(/معاينة محتويات النسخة الاحتياطية قبل التطبيق/i)
      ).toBeTruthy();
    });

    // 1. Unsynced work alert is displayed with counts
    expect(screen.getByText(/تنبيه أمان حرج/i)).toBeTruthy();
    expect(
      screen.getByText(/عملية معلقة في صندوق الصادر/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/مستند محلي لم يتم رفعها للسيرفر/i)
    ).toBeTruthy();

    // 2. Action buttons exist: "1. مزامنة أولاً" and "2. تصدير نسخة أمان"
    const syncFirstBtn = screen.getByText(/1\. مزامنة أولاً مع السيرفر/i);
    const safetyExportBtn = screen.getByText(
      /2\. تصدير نسخة أمان من البيانات المحلية الحالية فوراً/i
    );
    expect(syncFirstBtn).toBeTruthy();
    expect(safetyExportBtn).toBeTruthy();

    // 3. Confirm restore button should be disabled until confirmation phrase is typed
    const confirmRestoreBtn = screen.getByRole('button', {
      name: /تأكيد وتنفيذ الاستعادة/i,
    });
    expect(confirmRestoreBtn.hasAttribute('disabled')).toBe(true);

    // Type wrong phrase
    const confirmationInput = screen.getByPlaceholderText(/اكتب العبارة بدقة هنا/i);
    fireEvent.change(confirmationInput, { target: { value: 'نعم متأكد' } });
    expect(confirmRestoreBtn.hasAttribute('disabled')).toBe(true);

    // Type exact phrase
    fireEvent.change(confirmationInput, {
      target: { value: 'استبدال ومسح العمليات غير المزامنة' },
    });
    expect(confirmRestoreBtn.hasAttribute('disabled')).toBe(false);

    // Click confirm restore
    fireEvent.click(confirmRestoreBtn);

    await waitFor(() => {
      expect(executeRestoreSpy).toHaveBeenCalledWith(mockPreview);
    });
  });
});
