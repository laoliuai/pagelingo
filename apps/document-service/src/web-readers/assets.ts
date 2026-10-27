import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { ObjectStore } from '../storage/object-store.js';
import type { WebAssetRow } from './repository.js';
import { ServiceError } from '../errors.js';
export const webNotFound = () => new ServiceError(404, 'NOT_FOUND', 'Web document artifact not found');
/** Only registered immutable objects enter this bounded integrity-checked reader. */
export async function readWebAsset(store: ObjectStore, asset: WebAssetRow): Promise<Buffer> {
  const size = Number(asset.bytes); if (!Number.isSafeInteger(size) || size < 0) throw webNotFound();
  try {
    if ((await store.stat(asset.object_key)).bytes !== size) throw webNotFound();
    const hash = createHash('sha256'); const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of store.read(asset.object_key)) { count += chunk.byteLength; if (count > size) throw webNotFound(); hash.update(chunk); chunks.push(Buffer.from(chunk)); }
    if (count !== size || hash.digest('hex') !== asset.sha256) throw webNotFound();
    return Buffer.concat(chunks);
  } catch { throw webNotFound(); }
}
export function sendWebAsset(reply: FastifyReply, asset: { bytes: Buffer; mediaType: string; id: string }, raw = false) {
  const attachment = raw || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mediaType);
  reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Length', asset.bytes.length);
  if (attachment) reply.header('Content-Disposition', 'attachment; filename="archived-file"');
  return reply.type(attachment ? 'application/octet-stream' : asset.mediaType).send(asset.bytes);
}
