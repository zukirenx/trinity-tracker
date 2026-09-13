import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Creates a D1Database-compatible mock backed by real SQLite (better-sqlite3).
 * Each call returns a fresh in-memory database with the schema applied.
 */
export function createD1Mock(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Apply schema
  const schema = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');
  sqlite.exec(schema);

  function wrapStatement(sql: string, params: unknown[]) {
    // Used by batch() to decide whether to call all() or run().
    // CTE-prefixed writes (WITH … UPDATE/INSERT) are NOT read-only.
    const isSelect = /^\s*SELECT\s/i.test(sql);
    return {
      _isSelect: isSelect,
      run() {
        const stmt = sqlite.prepare(sql);
        const result = params.length > 0 ? stmt.run(...params) : stmt.run();
        return { meta: { changes: result.changes }, success: true, results: [] };
      },
      all<T>() {
        const stmt = sqlite.prepare(sql);
        const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
        return { results: rows as T[], success: true };
      },
      first<T>(colName?: string) {
        const stmt = sqlite.prepare(sql);
        const row = params.length > 0 ? stmt.get(...params) : stmt.get();
        if (!row) return colName ? null : null;
        if (colName) return (row as Record<string, unknown>)[colName] as T;
        return row as T;
      },
    };
  }

  return {
    prepare(sql: string) {
      const bound = wrapStatement(sql, []);
      return {
        _isSelect: bound._isSelect,
        bind(...params: unknown[]) {
          return wrapStatement(sql, params);
        },
        run: bound.run,
        all: bound.all,
        first: bound.first,
      };
    },
    batch: async (stmts: any[]) => {
      // Run as a real SQLite transaction so any failure rolls back
      // every statement in the group — matches D1 batch semantics.
      // SELECT statements use all() to return rows; writes use run().
      const tx = sqlite.transaction((items: any[]) =>
        items.map(s => (s._isSelect ? s.all() : s.run()))
      );
      return tx(stmts);
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => {
      throw new Error('dump not implemented');
    },
  } as unknown as D1Database;
}
