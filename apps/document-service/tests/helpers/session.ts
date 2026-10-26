import type { FastifyInstance } from 'fastify';
import type { PublicUser } from '@pagelingo/document-contracts';

export async function login(app: FastifyInstance, username: string, password: string): Promise<{ cookie: string; csrfToken: string; user: PublicUser }> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5174' }, payload: { username, password } });
  if (response.statusCode !== 200) throw new Error(`Test login failed: ${response.statusCode}`);
  const raw = response.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0];
  if (!cookie) throw new Error('Test login did not set a session cookie');
  return { cookie, ...response.json() };
}
