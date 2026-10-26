import type { PoolClient } from 'pg';
import type { UserRow } from '../auth/sessions.js';

/** Bootstrap and account management share this lock, always before any user row. */
export async function lockManagedAccounts(client: PoolClient, ids: string[]): Promise<UserRow[]> {
  await client.query('SELECT pg_advisory_xact_lock(204716, 1)');
  return (await client.query<UserRow>(
    'SELECT * FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids],
  )).rows;
}

export async function listUsers(client: PoolClient): Promise<UserRow[]> {
  return (await client.query<UserRow>('SELECT * FROM users ORDER BY created_at, id')).rows;
}

export async function insertUser(client: PoolClient, username: string, passwordHash: string): Promise<UserRow> {
  return (await client.query<UserRow>(`INSERT INTO users (username, password_hash, role)
    VALUES ($1, $2, 'user') RETURNING *`, [username, passwordHash])).rows[0]!;
}

export async function updateActive(client: PoolClient, userId: string, active: boolean): Promise<UserRow> {
  const row = (await client.query<UserRow>(`UPDATE users SET active = $2,
    auth_version = auth_version + CASE WHEN $2 THEN 0 ELSE 1 END, updated_at = now()
    WHERE id = $1 RETURNING *`, [userId, active])).rows[0]!;
  if (!active) await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return row;
}

export async function updatePassword(client: PoolClient, userId: string, passwordHash: string): Promise<void> {
  await client.query(`UPDATE users SET password_hash = $2, auth_version = auth_version + 1,
    updated_at = now() WHERE id = $1`, [userId, passwordHash]);
  await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function auditUserChange(
  client: PoolClient, actorId: string, targetId: string,
  action: 'create' | 'enable' | 'disable' | 'reset-password',
): Promise<void> {
  await client.query('INSERT INTO user_audit_events (actor_id, target_id, action) VALUES ($1, $2, $3)', [actorId, targetId, action]);
}
