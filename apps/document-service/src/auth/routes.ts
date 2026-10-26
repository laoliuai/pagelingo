import type { FastifyInstance, FastifyRequest } from 'fastify';
import { changePasswordRequestSchema, loginRequestSchema, logoutRequestSchema } from '@pagelingo/document-contracts';
import type { z } from 'zod';
import { ServiceError } from '../errors.js';
import { assertActorCurrent, requireJson, requireOrigin, requireSession, requireWriteRequest } from './guards.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import { cookieName, cookieOptions, createSession, readSession, sessionSeconds } from './sessions.js';
import type { UserRow } from './sessions.js';
import { lockLoginWindow } from './rate-limit.js';

function body<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  requireJson(request);
  const result = schema.safeParse(request.body);
  if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
  return result.data;
}
export function registerAuthRoutes(app: FastifyInstance): void {
  const { db, config } = app.authContext;
  app.get('/api/v1/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return (await readSession(request))?.view ?? { user: null, csrfToken: null };
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    requireOrigin(request);
    const input = body(loginRequestSchema, request);
    const result = await db.transaction(async client => {
      const fail = await lockLoginWindow(client, request.ip, input.username);
      const user = (await client.query<UserRow>('SELECT * FROM users WHERE username = $1 FOR UPDATE', [input.username])).rows[0];
      const valid = await verifyPassword(input.password, user?.password_hash ?? dummyPasswordHash);
      if (!valid || !user?.active) { await fail(); return null; }
      return createSession(client, user);
    });
    if (!result) throw new ServiceError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    reply.header('Cache-Control', 'no-store');
    reply.setCookie(cookieName(config), result.token, { ...cookieOptions(config), maxAge: sessionSeconds });
    return result.view;
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    requireOrigin(request);
    // A request without a CSRF header must never be treated as a valid logout.
    if (!request.headers['x-csrf-token']) throw new ServiceError(403, 'FORBIDDEN', 'Invalid CSRF token');
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    const input = body(logoutRequestSchema, request);
    await db.transaction(async client => {
      await assertActorCurrent(client, actor);
      if (input.allDevices) {
        await client.query('UPDATE users SET auth_version = auth_version + 1, updated_at = now() WHERE id = $1', [actor.userId]);
        await client.query('DELETE FROM sessions WHERE user_id = $1', [actor.userId]);
      } else { await client.query('DELETE FROM sessions WHERE token_hash = $1', [actor.sessionHash]); }
    });
    reply.clearCookie(cookieName(config), cookieOptions(config));
    return { user: null, csrfToken: null };
  });
  app.post('/api/v1/auth/password', async (request, reply) => {
    requireOrigin(request);
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    const input = body(changePasswordRequestSchema, request);
    await db.transaction(async client => {
      await assertActorCurrent(client, actor);
      const user = (await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [actor.userId])).rows[0]!;
      if (!await verifyPassword(input.currentPassword, user.password_hash)) throw new ServiceError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
      const encoded = await hashPassword(input.newPassword);
      await client.query('UPDATE users SET password_hash = $2, auth_version = auth_version + 1, updated_at = now() WHERE id = $1', [actor.userId, encoded]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [actor.userId]);
    });
    reply.clearCookie(cookieName(config), cookieOptions(config));
    return { user: null, csrfToken: null };
  });
}
