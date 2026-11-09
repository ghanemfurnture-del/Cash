import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Pure TypeScript representation of the GFS Retention Algorithm implemented in daily_backup.ps1
 */
export function calculateGfsRetention(
  files: { name: string; date: Date }[]
): { keep: { name: string; category: string }[]; prune: string[] } {
  const sorted = [...files].sort((a, b) => b.date.getTime() - a.date.getTime());
  const keep: { name: string; category: string }[] = [];
  const prune: string[] = [];

  let dailyCount = 0;
  let weeklyCount = 0;
  let monthlyCount = 0;

  for (const file of sorted) {
    const isMonthly = file.date.getDate() === 1;
    const isWeekly = file.date.getDay() === 5; // Friday

    if (dailyCount < 14) {
      keep.push({ name: file.name, category: 'Daily' });
      dailyCount++;
      continue;
    }

    if (isWeekly && weeklyCount < 8) {
      keep.push({ name: file.name, category: 'Weekly' });
      weeklyCount++;
      continue;
    }

    if (isMonthly && monthlyCount < 12) {
      keep.push({ name: file.name, category: 'Monthly' });
      monthlyCount++;
      continue;
    }

    prune.push(file.name);
  }

  return { keep, prune };
}

/**
 * Pure health check evaluation logic from daily_backup.ps1
 */
export function evaluateBackupHealth(latestBackupDate: Date | null, currentDate: Date = new Date()): {
  isHealthy: boolean;
  ageHours: number;
} {
  if (!latestBackupDate) {
    return { isHealthy: false, ageHours: Infinity };
  }
  const ageHours = (currentDate.getTime() - latestBackupDate.getTime()) / (1000 * 60 * 60);
  return {
    isHealthy: ageHours <= 48,
    ageHours,
  };
}

describe('Phase 2b-3c: Daily External Cloud Backup Script Suite', () => {
  it('validates file naming format matches backup_YYYYMMDD_HHMMSS.dump.enc', () => {
    const regex = /^backup_\d{8}_\d{6}\.dump\.enc$/;
    expect(regex.test('backup_20261104_020000.dump.enc')).toBe(true);
    expect(regex.test('backup_20261231_235959.dump.enc')).toBe(true);
    expect(regex.test('backup_20261104.dump.enc')).toBe(false);
    expect(regex.test('backup.dump')).toBe(false);
  });

  it('verifies GFS retention policy: keeps at most 14 daily, 8 weekly, 12 monthly, and prunes older', () => {
    const mockFiles: { name: string; date: Date }[] = [];
    const baseDate = new Date('2026-11-04T02:00:00Z');

    // Generate 60 days of daily backups
    for (let i = 0; i < 60; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() - i);
      mockFiles.push({
        name: `backup_${d.toISOString().slice(0, 10)}.dump.enc`,
        date: d,
      });
    }

    const { keep, prune } = calculateGfsRetention(mockFiles);

    // Assert counts
    const dailyKept = keep.filter((k) => k.category === 'Daily');
    const weeklyKept = keep.filter((k) => k.category === 'Weekly');
    const monthlyKept = keep.filter((k) => k.category === 'Monthly');

    expect(dailyKept.length).toBe(14);
    expect(weeklyKept.length).toBeLessThanOrEqual(8);
    expect(monthlyKept.length).toBeLessThanOrEqual(12);
    expect(prune.length).toBeGreaterThan(0);
    expect(keep.length + prune.length).toBe(60);
  });

  it('triggers health check alert when last backup is older than 48 hours', () => {
    const now = new Date('2026-11-04T12:00:00Z');

    // Recent backup 24 hours ago -> Healthy
    const recent = new Date('2026-11-03T12:00:00Z');
    const health1 = evaluateBackupHealth(recent, now);
    expect(health1.isHealthy).toBe(true);
    expect(health1.ageHours).toBe(24);

    // Stale backup 50 hours ago -> Alert
    const stale = new Date('2026-11-02T10:00:00Z');
    const health2 = evaluateBackupHealth(stale, now);
    expect(health2.isHealthy).toBe(false);
    expect(health2.ageHours).toBe(50);

    // Missing backup -> Alert
    const health3 = evaluateBackupHealth(null, now);
    expect(health3.isHealthy).toBe(false);
  });

  it('INSPECTION: verifies daily_backup.ps1 contains ZERO hardcoded passwords or project secrets', () => {
    const psScriptPath = path.resolve(__dirname, '../scripts/backup/daily_backup.ps1');
    expect(fs.existsSync(psScriptPath)).toBe(true);

    const content = fs.readFileSync(psScriptPath, 'utf8');

    // Forbidden patterns that must NEVER appear in the script (hardcoded credentials)
    const hardcodedSecretsPatterns = [
      /password\s*=\s*['"][^'"]+['"]/i, // hardcoded string password assignment
      /postgresql:\/\//i,
      /postgres:\/\//i,
      /eyJhbGciOi/i, // Supabase JWT token prefix
      /sbp_[a-zA-Z0-9]+/i, // Supabase Personal Access Token prefix
      /service_role/i,
    ];

    for (const pat of hardcodedSecretsPatterns) {
      expect(pat.test(content)).toBe(false);
    }

    // Asserts password is read via env var or credential manager
    expect(content.includes('$env:CASH_BACKUP_DB_PASS')).toBe(true);
    expect(content.includes('$env:PGPASSWORD = $DbPassword')).toBe(true);
    expect(content.includes('$env:PGPASSWORD = $null')).toBe(true);
  });

  it('INSPECTION: verifies backup_task_scheduler.xml is valid Task Scheduler XML with start-when-available', () => {
    const xmlPath = path.resolve(__dirname, '../scripts/backup/backup_task_scheduler.xml');
    expect(fs.existsSync(xmlPath)).toBe(true);

    const xmlContent = fs.readFileSync(xmlPath, 'utf8');
    expect(xmlContent.includes('<StartWhenAvailable>true</StartWhenAvailable>')).toBe(true);
    expect(xmlContent.includes('daily_backup.ps1')).toBe(true);
    expect(xmlContent.includes('ExecutionPolicy Bypass')).toBe(true);
  });
});
