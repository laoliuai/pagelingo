import pg from 'pg';
import type { PoolClient } from 'pg';

export interface Database {
  pool: pg.Pool;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function openDatabase(url: string, schema?: string): Database {
  if (schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema');
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  return {
    pool,
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
