import type { PoolClient } from 'pg';
import { ServiceError } from '../errors.js';

/** Lock IP first, then IP+username in the login transaction, including failure recording. */
export async function lockLoginWindow(client: PoolClient, ip: string, username: string) {
  const window = (await client.query(`SELECT to_timestamp(floor(extract(epoch from now()) / 900) * 900) AS start,
    ceil(900 - mod(extract(epoch from now()), 900))::int AS retry`)).rows[0];
  for (const [name, limit] of [['', 30], [username, 5]] as const) {
    const bucket = await client.query(`INSERT INTO auth_attempts (ip, username, window_start) VALUES ($1, $2, $3)
      ON CONFLICT (ip, username, window_start) DO UPDATE SET failures = auth_attempts.failures
      RETURNING failures`, [ip, name, window.start]);
    if (bucket.rows[0].failures >= limit) throw new ServiceError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts', window.retry);
  }
  return async () => {
    await client.query(`UPDATE auth_attempts SET failures = failures + 1
      WHERE ip = $1 AND username IN ('', $2) AND window_start = $3`, [ip, username, window.start]);
  };
}

export interface RateLimitWindow {
  scope: string;
  subject: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Atomically consume one request in a database-clock fixed window. Call inside a
 * transaction; rollback also rolls back the reservation. To count attempts even
 * if subsequent work fails, commit this reservation before starting that work.
 * Lock account rows before reserving quotas; acquire multiple quotas in scope /
 * subject order. Login failure counting deliberately uses lockLoginWindow instead.
 */
export async function consumeRateLimit(client: PoolClient, input: RateLimitWindow): Promise<void> {
  const window = (await client.query<{ start: Date; retry: number }>(`WITH clock AS (
    SELECT extract(epoch FROM clock_timestamp()) AS seconds
  ) SELECT to_timestamp(floor(seconds / $1) * $1) AS start,
    greatest(1, ceil($1 - mod(seconds, $1)))::int AS retry FROM clock`, [input.windowSeconds])).rows[0]!;
  const reserved = await client.query(`INSERT INTO rate_limit_windows
    (scope, subject, window_seconds, window_start, used) VALUES ($1, $2, $3, $4, 1)
    ON CONFLICT (scope, subject, window_seconds, window_start)
    DO UPDATE SET used = rate_limit_windows.used + 1 WHERE rate_limit_windows.used < $5
    RETURNING used`, [input.scope, input.subject, input.windowSeconds, window.start, input.limit]);
  if (!reserved.rowCount) throw new ServiceError(429, 'RATE_LIMITED', 'Too many requests', window.retry);
}
