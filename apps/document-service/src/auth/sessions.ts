import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { PublicUser } from '@pagelingo/document-contracts';
import type { RuntimeConfig } from '../config.js';

export interface Actor {
  userId: string;
  role: 'admin' | 'user';
  authVersion: number;
  sessionHash: string;
}
export interface UserRow {
  id: string;
  username: string;
  role: 'admin' | 'user';
  active: boolean;
  auth_version: number;
  password_hash: string;
  created_at: Date;
}
export const sessionSeconds = 7 * 24 * 60 * 60;
export function cookieName(config: RuntimeConfig): string {
  return config.mode === 'production' ? '__Host-pgl_session' : 'pgl_session';
}
export function cookieOptions(config: RuntimeConfig) {
  return { httpOnly: true, secure: config.mode === 'production', sameSite: 'lax' as const, path: '/' };
}
export function publicUser(row: UserRow): PublicUser {
  return { id: row.id, username: row.username, role: row.role, active: row.active, createdAt: row.created_at.toISOString() };
}
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export async function createSession(client: PoolClient, user: UserRow) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await client.query(`INSERT INTO sessions (token_hash, user_id, auth_version, csrf_token, expires_at)
    VALUES ($1, $2, $3, $4, now() + interval '7 days')`, [tokenHash(token), user.id, user.auth_version, csrfToken]);
  return { token, view: { user: publicUser(user), csrfToken } };
}
export async function readSession(request: FastifyRequest) {
  // Authorization is an explicit credential choice. Never downgrade it to Cookie.
  if (request.headers.authorization !== undefined) return null;
  const { db, config } = request.server.authContext;
  const token = request.cookies[cookieName(config)];
  if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
  const sessionHash = tokenHash(token);
  const result = await db.pool.query<UserRow & { csrf_token: string }>(`SELECT u.*, s.csrf_token FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()
    AND u.active AND u.auth_version = s.auth_version`, [sessionHash]);
  const row = result.rows[0];
  if (!row) return null;
  return { actor: { userId: row.id, role: row.role, authVersion: row.auth_version, sessionHash } satisfies Actor,
    view: { user: publicUser(row), csrfToken: row.csrf_token } };
}
