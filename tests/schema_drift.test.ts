import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import 'fake-indexeddb/auto';
import { db } from '../src/db';

describe('DEXIE vs SQL Schema Drift Verification Test', () => {
  it('parses tables from 001 and 002 migrations and asserts 100% parity with Dexie schema', () => {
    const migration001Path = path.resolve(__dirname, '../supabase/migrations/001_core_schema.sql');
    const migration002Path = path.resolve(__dirname, '../supabase/migrations/002_extended_schema.sql');

    const sql001 = fs.readFileSync(migration001Path, 'utf-8');
    const sql002 = fs.readFileSync(migration002Path, 'utf-8');

    // Regex to match "create table <table_name>"
    const createTableRegex = /create\s+table\s+([a-zA-Z0-9_]+)/gi;

    const extractTables = (sql: string): string[] => {
      const tables: string[] = [];
      let match;
      while ((match = createTableRegex.exec(sql)) !== null) {
        const tableName = match[1].toLowerCase();
        // Ignore template table _row_base
        if (tableName !== '_row_base') {
          tables.push(tableName);
        }
      }
      return tables;
    };

    const tables001 = extractTables(sql001);
    const tables002 = extractTables(sql002);
    const allSqlTables = Array.from(new Set([...tables001, ...tables002]));

    // Server-only tables that must NOT be mirrored in client Dexie:
    const serverOnlyTables = ['sync_ops'];

    // Expected SQL tables that MUST be mirrored in Dexie:
    const expectedMirroredTables = allSqlTables
      .filter((t) => !serverOnlyTables.includes(t))
      .sort();

    // Client-only tables created specifically for Dexie offline engine:
    const clientOnlyTables = ['outbox', 'sync_meta'];

    // Actual tables defined in Dexie instance
    const actualDexieTables = db.tables
      .map((t) => t.name)
      .filter((t) => !clientOnlyTables.includes(t))
      .sort();

    // 1. Check exact table count
    expect(
      expectedMirroredTables.length,
      `Mismatch in table count between SQL contract and Dexie`
    ).toBe(actualDexieTables.length);

    // 2. Check for missing tables in Dexie (SQL tables not in Dexie)
    const missingInDexie = expectedMirroredTables.filter((t) => !actualDexieTables.includes(t));
    expect(
      missingInDexie,
      `These tables exist in SQL migrations but are MISSING in Dexie: ${missingInDexie.join(', ')}`
    ).toEqual([]);

    // 3. Check for extra/drift tables in Dexie (Dexie tables not in SQL contract)
    const extraInDexie = actualDexieTables.filter((t) => !expectedMirroredTables.includes(t));
    expect(
      extraInDexie,
      `These tables exist in Dexie but NOT in the SQL contract: ${extraInDexie.join(', ')}`
    ).toEqual([]);

    // 4. Verify client-only tables exist
    expect(db.tables.map((t) => t.name)).toContain('outbox');
    expect(db.tables.map((t) => t.name)).toContain('sync_meta');
  });
});
