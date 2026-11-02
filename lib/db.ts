// Database access. Production uses node-postgres; tests use PGlite (Postgres in-process) through the same shape.

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export type Db = {
  query: Query;
  // Runs fn in one transaction; rolls back if it throws.
  transaction<T>(fn: (query: Query) => Promise<T>): Promise<T>;
};

type PgPool = {
  query: Query;
  connect(): Promise<{ query: Query; release(): void }>;
};

export function fromPgPool(pool: PgPool): Db {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn((sql, params) => client.query(sql, params));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

type PgliteLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  transaction<T>(fn: (tx: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }) => Promise<T>): Promise<T>;
};

export function fromPglite(pg: PgliteLike): Db {
  return {
    query: (sql, params) => pg.query(sql, params),
    transaction: (fn) => pg.transaction((tx) => fn((sql, params) => tx.query(sql, params))),
  };
}
