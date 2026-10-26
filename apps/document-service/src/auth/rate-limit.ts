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
