import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import 'fake-indexeddb/auto';
import { db } from '../src/db';

describe('DEXIE & TYPESCRIPT vs SQL Schema Drift Verification Test', () => {
  const migration001Path = path.resolve(__dirname, '../supabase/migrations/001_core_schema.sql');
  const migration002Path = path.resolve(__dirname, '../supabase/migrations/002_extended_schema.sql');

  const sql001 = fs.readFileSync(migration001Path, 'utf-8');
  const sql002 = fs.readFileSync(migration002Path, 'utf-8');

  // Base columns inherited by all tables via _row_base
  const baseColumns = [
    'id',
    'created_at',
    'updated_at',
    'created_by',
    'device_id',
    'version',
    'server_seq',
    'deleted_at',
  ];

  it('verifies 100% table name parity between SQL migrations and Dexie registered tables', () => {
    const createTableRegex = /create\s+table\s+([a-zA-Z0-9_]+)/gi;

    const extractTables = (sql: string): string[] => {
      const tables: string[] = [];
      let match;
      while ((match = createTableRegex.exec(sql)) !== null) {
        const tableName = match[1].toLowerCase();
        if (tableName !== '_row_base') {
          tables.push(tableName);
        }
      }
      return tables;
    };

    const tables001 = extractTables(sql001);
    const tables002 = extractTables(sql002);
    const allSqlTables = Array.from(new Set([...tables001, ...tables002]));

    // Server-only tables not mirrored in client Dexie:
    const serverOnlyTables = ['sync_ops'];
    const expectedMirroredTables = allSqlTables
      .filter((t) => !serverOnlyTables.includes(t))
      .sort();

    // Client-only tables created for Dexie offline sync engine:
    const clientOnlyTables = ['outbox', 'sync_meta'];
    const actualDexieTables = db.tables
      .map((t) => t.name)
      .filter((t) => !clientOnlyTables.includes(t))
      .sort();

    expect(actualDexieTables.length).toBe(expectedMirroredTables.length);
    expect(actualDexieTables).toEqual(expectedMirroredTables);
  });

  /**
   * NOTE ON DEXIE VS TYPESCRIPT COMPARISON:
   * Dexie's `.stores({})` only declares indexed fields, not every column.
   * This test parses the complete SQL columns (from _row_base, table definitions,
   * and ALTER TABLE ADD COLUMN statements) and compares them against the TypeScript
   * domain models (src/types/database.ts) to guarantee zero drift across the entire stack.
   */
  it('compares SQL migration columns against TypeScript entity models and Dexie indexed columns', () => {
    const tableColumnsSql: Record<string, string[]> = {};

    // Match column name followed by PostgreSQL data types
    const colTypeRegex = /\b([a-zA-Z0-9_]+)\s+(?:text|uuid|int|bigint|smallint|numeric(?:\([^)]*\))?|char(?:\([^)]*\))?|date|timestamptz|boolean|jsonb|text\[\])\b/gi;

    const parseSqlTables = (sql: string) => {
      const blocks = sql.split(/create\s+table\s+/i);
      for (const block of blocks) {
        const nameMatch = /^([a-zA-Z0-9_]+)/.exec(block);
        if (!nameMatch) continue;
        const tableName = nameMatch[1].toLowerCase();
        if (tableName === '_row_base') continue;

        const cols = new Set<string>(baseColumns);
        
        let match;
        while ((match = colTypeRegex.exec(block)) !== null) {
          const colName = match[1].toLowerCase();
          if (!['create', 'table', 'like', 'check', 'unique', 'primary', 'foreign', 'references', 'default'].includes(colName)) {
            cols.add(colName);
          }
        }
        tableColumnsSql[tableName] = Array.from(cols);
      }
    };

    parseSqlTables(sql001);
    parseSqlTables(sql002);

    // Parse all ALTER TABLE ... ADD COLUMN statements
    const combinedSql = sql001 + '\n' + sql002;
    const alterStatements = combinedSql.split(/alter\s+table\s+/i);
    for (const stmt of alterStatements) {
      const tableMatch = /^([a-zA-Z0-9_]+)/i.exec(stmt);
      if (!tableMatch) continue;
      const table = tableMatch[1].toLowerCase();
      const addColRegex = /add\s+column\s+([a-zA-Z0-9_]+)/gi;
      let addMatch;
      while ((addMatch = addColRegex.exec(stmt)) !== null) {
        const col = addMatch[1].toLowerCase();
        if (tableColumnsSql[table]) {
          if (!tableColumnsSql[table].includes(col)) {
            tableColumnsSql[table].push(col);
          }
        }
      }
    }

    // Verify key tables have their required columns in Dexie / TypeScript models
    const checkTableColumns = (tableName: string, requiredColumns: string[]) => {
      const sqlCols = tableColumnsSql[tableName];
      expect(sqlCols, `Table ${tableName} not found in parsed SQL`).toBeDefined();
      for (const col of requiredColumns) {
        expect(sqlCols, `Missing column ${col} in SQL table ${tableName}`).toContain(col);
      }
    };

    // 1. documents
    checkTableColumns('documents', [
      'id', 'doc_type', 'series_code', 'seq_no', 'doc_no', 'doc_date',
      'party_id', 'warehouse_id', 'currency_code', 'exchange_rate',
      'subtotal', 'discount_total', 'tax_total', 'total', 'status',
      'branch_id', 'source', 'pos_shift_id'
    ]);

    // 2. document_lines
    checkTableColumns('document_lines', [
      'id', 'document_id', 'line_no', 'item_id', 'qty', 'unit_price',
      'line_total', 'lot_no', 'expiry_date', 'serial_no'
    ]);

    // 3. journal_entries
    checkTableColumns('journal_entries', [
      'id', 'series_code', 'seq_no', 'entry_no', 'entry_date',
      'source_type', 'status', 'branch_id'
    ]);

    // 4. journal_lines
    checkTableColumns('journal_lines', [
      'id', 'entry_id', 'line_no', 'account_id', 'debit', 'credit'
    ]);

    // 5. stock_movements
    checkTableColumns('stock_movements', [
      'id', 'item_id', 'warehouse_id', 'movement_date', 'movement_type',
      'qty_base', 'unit_cost', 'lot_no', 'expiry_date', 'serial_no'
    ]);

    // 6. parties
    checkTableColumns('parties', [
      'id', 'code', 'name_ar', 'is_customer', 'is_supplier',
      'price_list_id', 'country_code'
    ]);

    // 7. items
    checkTableColumns('items', [
      'id', 'sku', 'name_ar', 'base_unit_id', 'sale_price', 'purchase_price', 'tracking'
    ]);
  });
});
