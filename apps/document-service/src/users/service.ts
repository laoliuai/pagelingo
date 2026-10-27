import { createUserRequestSchema, resetPasswordRequestSchema, updateUserRequestSchema } from '@pagelingo/document-contracts';
import type { CreateUserRequest, PublicUser } from '@pagelingo/document-contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { assertActorCurrent } from '../auth/guards.js';
import type { Actor } from '../auth/guards.js';
import { hashPassword } from '../auth/passwords.js';
import { consumeRateLimit } from '../auth/rate-limit.js';
import { publicUser } from '../auth/sessions.js';
import type { UserRow } from '../auth/sessions.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { auditUserChange, insertUser, listUsers, lockManagedAccounts, updateActive, updatePassword } from './repository.js';
import { revokeOwnerDevices } from '../devices/repository.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
  return parsed.data;
}
function requireAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new ServiceError(403, 'FORBIDDEN', 'Administrator access required');
}
function targetUser(rows: UserRow[], id: string): UserRow {
  const row = rows.find(user => user.id === id);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', 'User not found');
  return row;
}
function resetTarget(rows: UserRow[], id: string): void {
  if (targetUser(rows, id).role !== 'user') throw new ServiceError(403, 'FORBIDDEN', 'Only ordinary users can have their password reset');
}

export function createUsersService(db: Database) {
  async function authorized<T>(actor: Actor, targetId: string | undefined, fn: (client: PoolClient, rows: UserRow[]) => Promise<T>): Promise<T> {
    return db.transaction(async client => {
      // Global management lock -> actor/target rows in UUID order -> sessions -> quotas.
      // Auth-only flows lock one user then sessions and never acquire the global lock.
      const rows = await lockManagedAccounts(client, targetId ? [actor.userId, targetId] : [actor.userId]);
      await assertActorCurrent(client, actor);
      requireAdmin(actor);
      return fn(client, rows);
    });
  }
  return {
    async list(actor: Actor): Promise<PublicUser[]> {
      return authorized(actor, undefined, async client => (await listUsers(client)).map(publicUser));
    },
    async create(actor: Actor, input: CreateUserRequest): Promise<PublicUser> {
      requireAdmin(actor);
      const parsed = parse(createUserRequestSchema, input);
      const encoded = await hashPassword(parsed.password);
      try {
        return await authorized(actor, undefined, async client => {
          const row = await insertUser(client, parsed.username, encoded);
          await auditUserChange(client, actor.userId, row.id, 'create');
          return publicUser(row);
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
            'constraint' in error && error.constraint === 'users_username_key') {
          throw new ServiceError(409, 'USERNAME_EXISTS', 'Username already exists');
        }
        throw error;
      }
    },
    async setActive(actor: Actor, userId: string, active: boolean): Promise<PublicUser> {
      requireAdmin(actor);
      const id = parse(z.uuid(), userId).toLowerCase();
      const input = parse(updateUserRequestSchema, { active });
      return authorized(actor, id, async (client, rows) => {
        const target = targetUser(rows, id);
        if (!input.active && target.active && target.role === 'admin') {
          const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active")).rows[0]!.n;
          if (count <= 1) throw new ServiceError(409, 'LAST_ADMIN', 'The last active administrator cannot be disabled');
        }
        const row = await updateActive(client, id, input.active);
        if (!input.active) await revokeOwnerDevices(client, id);
        await auditUserChange(client, actor.userId, id, input.active ? 'enable' : 'disable');
        return publicUser(row);
      });
    },
    async resetPassword(actor: Actor, userId: string, newPassword: string): Promise<void> {
      requireAdmin(actor);
      const id = parse(z.uuid(), userId).toLowerCase();
      const input = parse(resetPasswordRequestSchema, { newPassword });
      // Commit attempts before hashing, including absent or forbidden targets. Never
      // let a hash failure or a later authorization failure refund the quota.
      const targetError = await authorized(actor, id, async (client, rows) => {
        await consumeRateLimit(client, { scope: 'admin-password-reset', subject: actor.userId, limit: 5, windowSeconds: 60 });
        try { resetTarget(rows, id); return null; }
        catch (error) { if (error instanceof ServiceError) return error; throw error; }
      });
      if (targetError) throw targetError;
      const encoded = await hashPassword(input.newPassword);
      await authorized(actor, id, async (client, rows) => {
        resetTarget(rows, id);
        await updatePassword(client, id, encoded);
        await revokeOwnerDevices(client, id);
        await auditUserChange(client, actor.userId, id, 'reset-password');
      });
    },
  };
}
