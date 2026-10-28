import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function database() {
  const test = await createTestDatabase();
  cleanup.push(test.dispose);
  return test.db;
}

describe('PostgreSQL persistence', () => {
  it('records seven migrations and does not replay them', async () => {
    const db = await database();
    await migrateDatabase(db);
    await db.pool.query("INSERT INTO users (username, password_hash, role) VALUES ('alice', 'hash', 'user')");
    await migrateDatabase(db);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(7);
    expect((await db.pool.query('SELECT username FROM users')).rows[0].username).toBe('alice');
  });
  it('rejects a changed checksum', async () => {
    const db = await database();
    await migrateDatabase(db);
    await db.pool.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE id = '001-accounts'");
    await expect(migrateDatabase(db)).rejects.toThrow(/checksum/i);
  });
  it('rejects an unknown newer schema version', async () => {
    const db = await database();
    await migrateDatabase(db);
    await db.pool.query("INSERT INTO schema_migrations (id, checksum) VALUES ('999-future', repeat('a', 64))");
    await expect(migrateDatabase(db)).rejects.toThrow(/unknown/i);
  });
  it('rolls back all statements in a failed transaction and releases its client', async () => {
    const db = await database();
    await db.pool.query('CREATE TABLE transaction_probe (id integer)');
    await expect(db.transaction(async (client: PoolClient) => {
      await client.query('INSERT INTO transaction_probe VALUES (1)');
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM transaction_probe')).rows[0].n).toBe(0);
    await db.transaction((client: PoolClient) => client.query('INSERT INTO transaction_probe VALUES (2)'));
    expect((await db.pool.query('SELECT id FROM transaction_probe')).rows).toEqual([{ id: 2 }]);
  });
  it('serializes concurrent migration attempts on the same schema', async () => {
    const db = await database();
    await Promise.all(Array.from({ length: 5 }, () => migrateDatabase(db)));
    expect((await db.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(7);
  });
  it('defaults new ingestions to receiving for stale-upload recovery', async () => {
    const db = await database();
    await migrateDatabase(db);
    const user = await db.pool.query("INSERT INTO users (username, password_hash) VALUES ('alice', 'hash') RETURNING id");
    await db.pool.query("INSERT INTO ingestions (owner_id, idempotency_key, request_hash) VALUES ($1, 'new-upload', repeat('a', 64))", [user.rows[0].id]);
    const receiving = await db.pool.query("SELECT idempotency_key FROM ingestions WHERE status = 'receiving'");
    expect(receiving.rows).toEqual([{ idempotency_key: 'new-upload' }]);
  });
  it('accepts receiving, completed and failed ingestion states with a document for completion', async () => {
    const db = await database();
    await migrateDatabase(db);
    const user = await db.pool.query("INSERT INTO users (username, password_hash) VALUES ('alice', 'hash') RETURNING id");
    const owner = user.rows[0].id;
    const document = await db.pool.query("INSERT INTO documents (owner_id, title, original_filename) VALUES ($1, 'PDF', 'file.pdf') RETURNING id", [owner]);
    await db.pool.query("INSERT INTO ingestions (owner_id, idempotency_key, request_hash, status) VALUES ($1, 'upload', repeat('a', 64), 'receiving')", [owner]);
    await db.pool.query("UPDATE ingestions SET status = 'completed', document_id = $2 WHERE owner_id = $1 AND idempotency_key = 'upload'", [owner, document.rows[0].id]);
    expect((await db.pool.query("SELECT status FROM ingestions WHERE owner_id = $1", [owner])).rows).toEqual([{ status: 'completed' }]);
    await db.pool.query("INSERT INTO ingestions (owner_id, idempotency_key, request_hash, status) VALUES ($1, 'failed-upload', repeat('b', 64), 'failed')", [owner]);
    expect((await db.pool.query("SELECT document_id FROM ingestions WHERE owner_id = $1 AND status = 'failed'", [owner])).rows).toEqual([{ document_id: null }]);
  });
  it('rejects marking an ingestion completed without its document', async () => {
    const db = await database();
    await migrateDatabase(db);
    const user = await db.pool.query("INSERT INTO users (username, password_hash) VALUES ('alice', 'hash') RETURNING id");
    const owner = user.rows[0].id;
    await db.pool.query("INSERT INTO ingestions (owner_id, idempotency_key, request_hash) VALUES ($1, 'upload', repeat('a', 64))", [owner]);
    await expect(db.pool.query("UPDATE ingestions SET status = 'completed' WHERE owner_id = $1", [owner])).rejects.toMatchObject({ code: '23514' });
    expect((await db.pool.query('SELECT status, document_id FROM ingestions WHERE owner_id = $1', [owner])).rows).toEqual([{ status: 'receiving', document_id: null }]);
  });
  it('rejects owner mismatches and a current source belonging to a different document', async () => {
    const db = await database();
    await migrateDatabase(db);
    const owner = randomUUID(), other = randomUUID(), doc = randomUUID(), otherDoc = randomUUID(), asset = randomUUID(), source = randomUUID();
    await db.pool.query("INSERT INTO users (id, username, password_hash) VALUES ($1, 'alice', 'hash'), ($2, 'bob', 'hash')", [owner, other]);
    await db.pool.query("INSERT INTO documents (id, owner_id, title, original_filename) VALUES ($1, $3, 'First', 'one.pdf'), ($2, $3, 'Second', 'two.pdf')", [doc, otherDoc, owner]);
    await expect(db.pool.query("INSERT INTO assets (owner_id, document_id, object_key, sha256, bytes, media_type) VALUES ($1, $2, 'key', repeat('a',64), 5, 'application/pdf')", [other, doc])).rejects.toMatchObject({ code: '23503' });
    await db.pool.query("INSERT INTO assets (id, owner_id, document_id, object_key, sha256, bytes, media_type) VALUES ($1, $2, $3, 'key', repeat('a',64), 5, 'application/pdf')", [asset, owner, doc]);
    await expect(db.pool.query('INSERT INTO source_versions (owner_id, document_id, asset_id, sha256, bytes) VALUES ($1, $2, $3, repeat(\'a\',64), 5)', [owner, otherDoc, asset])).rejects.toMatchObject({ code: '23503' });
    await db.pool.query("INSERT INTO source_versions (id, owner_id, document_id, asset_id, sha256, bytes) VALUES ($1, $2, $3, $4, repeat('a',64), 5)", [source, owner, doc, asset]);
    await expect(db.pool.query('UPDATE documents SET current_source_version_id = $1 WHERE id = $2', [source, otherDoc])).rejects.toMatchObject({ code: '23503' });
    await db.pool.query('UPDATE documents SET current_source_version_id = $1 WHERE id = $2', [source, doc]);
    expect((await db.pool.query('SELECT current_source_version_id FROM documents WHERE id = $1', [doc])).rows[0].current_source_version_id).toBe(source);
  });
});

it('provides health responses and fails readiness on an incomplete schema', async () => {
  const { createServiceTestApp } = await import('../helpers/app.js');
  const test = await createServiceTestApp();
  cleanup.push(test.close);
  const live = await test.app.inject('/health/live');
  expect(live.statusCode).toBe(200);
  expect(live.json()).toEqual({ status: 'ok' });
  expect(live.headers['x-pagelingo-api-version']).toBe('pagelingo-site-api/1');
  expect((await test.app.inject('/health/ready')).statusCode).toBe(200);
  await test.db.pool.query('DROP TABLE ingestions');
  const ready = await test.app.inject('/health/ready');
  expect(ready.statusCode).toBe(503);
  expect(ready.json().error.code).toBe('SERVICE_NOT_READY');
  expect(ready.body).not.toContain(test.config.databaseUrl);
  await test.app.close();
  expect((await test.db.pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);
});
