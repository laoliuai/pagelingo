import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Database } from './database.js';

const migrationsDir = new URL('../../migrations/', import.meta.url);

async function readMigrations() {
  const names = (await readdir(migrationsDir)).filter(name => /^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, migrationsDir), 'utf8');
    return { id: name.slice(0, -4), sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function migrateDatabase(db: Database): Promise<void> {
  const migrations = await readMigrations();
  await db.transaction(async client => {
    // Transaction-scoped lock, bookkeeping and DDL share the same client.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':pagelingo-migrations', 0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = await client.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations ORDER BY id');
    for (const row of applied.rows) {
      const expected = migrations.find(migration => migration.id === row.id);
      if (!expected) throw new Error(`Unknown migration ${row.id}`);
      if (expected.checksum !== row.checksum) throw new Error(`Migration checksum mismatch: ${row.id}`);
    }
    for (const migration of migrations) {
      if (applied.rows.some(row => row.id === migration.id)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [migration.id, migration.checksum]);
    }
  });
}

export async function verifyDatabaseSchema(db: Database): Promise<void> {
  const migrations = await readMigrations();
  const applied = await db.pool.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations ORDER BY id');
  if (applied.rows.length !== migrations.length || migrations.some((migration, index) =>
    migration.id !== applied.rows[index]?.id || migration.checksum !== applied.rows[index]?.checksum)) {
    throw new Error('Schema migration mismatch');
  }
  // Resolve every required table using this pool's search_path.
  await db.pool.query('SELECT 1 FROM users, sessions, auth_attempts, provider_profiles, documents, source_versions, assets, ingestions, user_audit_events, rate_limit_windows, bundle_imports, parse_runs, translation_runs, reader_versions, reader_chunks, bundle_files, reading_state, reading_positions, site_metadata, web_sources, web_source_files, web_parse_runs, web_provider_revisions, glossary_revisions, save_preferences, web_jobs, web_worker_slots, web_job_checkpoints, web_owner_cache, web_translation_runs, web_reader_versions, web_reader_chunks, web_reader_assets, web_reading_positions, web_reading_state, devices, device_pairings, web_captures, web_capture_files, collections, tags, document_organization, document_tags, document_relations, document_search_metadata, document_metadata_backfill_cursor, retired_document_identities, document_tombstones, retired_operations, document_purges, object_deletion_queue, web_cache_document_refs, document_cache_cleanup_state LIMIT 0');
}
