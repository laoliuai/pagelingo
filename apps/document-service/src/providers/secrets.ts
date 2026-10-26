import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';

/** Internal envelope; never include this in a public DTO or job snapshot. */
export interface SealedSecret {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function masterKey(keyId: string, keyring: RuntimeConfig['keyring']): Uint8Array {
  if (!Object.hasOwn(keyring.keys, keyId) || keyring.keys[keyId]?.length !== 32) {
    throw new Error('Provider encryption key unavailable');
  }
  return keyring.keys[keyId]!;
}

function ownerAad(userId: string): Buffer {
  return Buffer.from(`pgl:provider:v1:${userId}`, 'utf8');
}

export function sealApiKey(value: string, userId: string, keyring: RuntimeConfig['keyring']): SealedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(keyring.activeKeyId, keyring), nonce, { authTagLength: 16 });
  cipher.setAAD(ownerAad(userId));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { keyId: keyring.activeKeyId, nonce, ciphertext, tag: cipher.getAuthTag() };
}

export function openApiKey(secret: SealedSecret, userId: string, keyring: RuntimeConfig['keyring']): string {
  if (secret.nonce.length !== 12 || secret.tag.length !== 16) throw new Error('Invalid provider secret');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(secret.keyId, keyring), secret.nonce, { authTagLength: 16 });
  decipher.setAAD(ownerAad(userId));
  decipher.setAuthTag(secret.tag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}
