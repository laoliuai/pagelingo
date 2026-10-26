import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { passwordSchema } from '@pagelingo/document-contracts';
import { ServiceError } from '../errors.js';

const parameters = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
let running = 0;
const waiting: Array<() => void> = [];

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (running >= 2) {
    if (waiting.length >= 8) throw new ServiceError(429, 'AUTH_BUSY', 'Authentication is busy', 1);
    await new Promise<void>(resolve => waiting.push(resolve));
  } else { running++; }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, parameters, (error, hash) => error ? reject(error) : resolve(hash));
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (!passwordSchema.safeParse(password).success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid password');
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$v1$131072$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!passwordSchema.safeParse(password).success) return false;
  const match = /^scrypt\$v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const actual = await derive(password, Buffer.from(match[1]!, 'hex'));
  return timingSafeEqual(actual, Buffer.from(match[2]!, 'hex'));
}

// A syntactically valid fixed-cost hash ensures unknown users perform the same scrypt work.
export const dummyPasswordHash = `scrypt$v1$131072$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
