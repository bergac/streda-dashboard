// The database connection. The rest of the app only depends on `Queryable`,
// which a pg Pool satisfies.

export interface QueryResult<T = any> {
  rows: T[];
}

export interface Queryable {
  query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  close(): Promise<void>;
}

export async function connectPostgres(url: string): Promise<Database> {
  const pg = (await import('pg')).default;
  // Return numeric/bigint columns as JS numbers (values here are far below 2^53).
  pg.types.setTypeParser(20, (v: string) => Number(v)); // int8
  pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err: Error) => console.error('[db] idle client error:', err.message));
  return {
    query: (text, values) => pool.query(text, values as any[]) as any,
    close: () => pool.end(),
  };
}

/** Waits for Postgres to accept connections (the container can start before the database). */
export async function waitForDatabase(db: Queryable, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`[db] waiting for database (${(err as Error).message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
