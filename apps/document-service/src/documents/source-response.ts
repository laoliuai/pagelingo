import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ServiceError } from '../errors.js';
import { parseByteRange } from '../storage/byte-range.js';
import type { ObjectStore } from '../storage/object-store.js';
import type { DocumentRow } from './repository.js';

/** The caller must resolve the owner-scoped document before entering this function. */
export async function sendSource(request: FastifyRequest, reply: FastifyReply, store: ObjectStore, asset: DocumentRow, download: boolean) {
  reply.header('Cache-Control', 'no-store');
  const size = Number(asset.bytes);
  try { if ((await store.stat(asset.object_key)).bytes !== size) throw new Error('Invalid stored size'); }
  catch { throw new ServiceError(404, 'NOT_FOUND', 'Original file not found'); }
  let range;
  try { range = parseByteRange(request.headers.range, size); }
  catch (error) { reply.header('Content-Range', `bytes */${size}`); throw error; }
  const encoded = encodeURIComponent(asset.original_filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  reply.header('Content-Type', 'application/pdf');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="document.pdf"; filename*=UTF-8''${encoded}`);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('ETag', `"${asset.sha256}"`);
  reply.header('Content-Length', range ? range.end - range.start + 1 : size);
  if (range) { reply.code(206); reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`); }
  if (request.method === 'HEAD') return reply.send(Readable.from([]));
  return reply.send(Readable.from(store.read(asset.object_key, range)));
}
