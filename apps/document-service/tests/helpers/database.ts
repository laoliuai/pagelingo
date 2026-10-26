import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/db/database.js';

export async function createTestDatabase() {
  const url = process.env.PAGELINGO_TEST_DATABASE_URL;
  if (!url) throw new Error('PAGELINGO_TEST_DATABASE_URL must identify an isolated test database');
  const schema = `pgl_test_${randomUUID().replaceAll('-', '')}`;
  const admin = openDatabase(url);
  try {
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const db = openDatabase(url, schema);
    return {
      db,
      async dispose() {
        try { await db.close(); }
        finally {
          try { await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
          finally { await admin.close(); }
        }
      },
    };
  } catch (error) {
    await admin.close();
    throw error;
  }
}
