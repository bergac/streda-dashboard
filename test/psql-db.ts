// Test-only database adapter: runs queries through the `psql` command line tool
// against a throwaway test database. Production uses the `pg` driver instead.

import { spawn, spawnSync } from 'node:child_process';
import type { Database } from '../server/db/db.ts';

const PSQL = process.env.PSQL ?? 'psql';

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return literal(value.toISOString());
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]::text[]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function inline(text: string, values: unknown[] = []): string {
  return text.replace(/\$(\d+)/g, (_, n) => literal(values[Number(n) - 1]));
}

function run(args: string[], sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(PSQL, [...args, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `psql exited ${code}`))));
    p.stdin.end(sql);
  });
}

export function createTestDatabase(base: { host: string; port: number; user: string }, name: string): Database & { drop(): void } {
  const conn = ['-h', base.host, '-p', String(base.port), '-U', base.user];
  spawnSync(PSQL, [...conn, '-X', '-q', '-c', `DROP DATABASE IF EXISTS ${name}`, 'postgres']);
  const created = spawnSync(PSQL, [...conn, '-X', '-q', '-c', `CREATE DATABASE ${name}`, 'postgres'], { encoding: 'utf8' });
  if (created.status !== 0) throw new Error(created.stderr);
  const args = [...conn, '-d', name];
  return {
    async query(text: string, values?: unknown[]) {
      const sql = inline(text, values).trim();
      const multi = !values?.length && /;\s*\S/.test(sql);
      const returnsRows = !multi && (/^\s*(SELECT|WITH|\()/i.test(sql) || /\bRETURNING\b/i.test(sql));
      // The pg driver sends parameters without a type, and Postgres infers each
      // one from the query. PREPARE does the same inference, so a parameter that
      // would get the wrong type with the real driver fails here too.
      const check = values?.length ? `PREPARE typecheck AS ${text.trim().replace(/;$/, '')};\nDEALLOCATE typecheck;\n` : '';
      if (!returnsRows) {
        await run(args, check + (sql.endsWith(';') ? sql : `${sql};`));
        return { rows: [] };
      }
      const out = await run(args, `${check}WITH t AS (${sql}) SELECT COALESCE(json_agg(t), '[]'::json) FROM t;`);
      return { rows: JSON.parse(out.trim() || '[]') };
    },
    async close() {},
    drop() {
      spawnSync(PSQL, [...conn, '-X', '-q', '-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, 'postgres']);
    },
  };
}

export const TEST_PG = {
  host: process.env.TEST_PGHOST ?? '/tmp/pgtest',
  port: Number(process.env.TEST_PGPORT ?? 55432),
  user: process.env.TEST_PGUSER ?? 'postgres',
};
