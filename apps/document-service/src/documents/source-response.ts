import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ServiceError } from '../errors.js';
import { parseByteRange } from '../storage/byte-range.js';
import type { ObjectStore } from '../storage/object-store.js';
import type { DocumentRow } from './repository.js';

/** The caller must resolve the owner-scoped document before entering this function. */
export async function sendSource(request: FastifyRequest, reply: FastifyReply, store: ObjectStore, asset: DocumentRow, download: boolean, authorize?: () => Promise<unknown>) {
  return sendStoredAsset(request, reply, store, asset, { mediaType: 'application/pdf', filename: asset.original_filename, fallbackFilename: 'document.pdf', download, authorize });
}

/** Resolve owner/document/version and the display whitelist before passing internal storage metadata. */
export async function sendStoredAsset(request: FastifyRequest, reply: FastifyReply, store: ObjectStore,
  asset: { bytes: string; object_key: string; sha256: string },
  options: { mediaType: string; filename: string; fallbackFilename: string; download: boolean; authorize?: () => Promise<unknown> }) {
  reply.header('Cache-Control', 'no-store');
  const size = Number(asset.bytes);
  try { if ((await store.stat(asset.object_key)).bytes !== size) throw new Error('Invalid stored size'); }
  catch { throw new ServiceError(404, 'NOT_FOUND', 'Original file not found'); }
  await options.authorize?.();
  let range;
  try { range = parseByteRange(request.headers.range, size); }
  catch (error) { reply.header('Content-Range', `bytes */${size}`); throw error; }
  const iterator = request.method === 'HEAD' ? undefined : store.read(asset.object_key, range)[Symbol.asyncIterator]();
  let first: IteratorResult<Uint8Array> | undefined;
  try { if (iterator) first = await iterator!.next(); await options.authorize?.(); }
  catch (error) { await iterator?.return?.(); throw error; }
  // Readable owns the pre-opened iterator even if it is destroyed before its first read.
  // An unstarted async-generator wrapper does not execute its finally on return().
  let returned: Promise<unknown> | undefined;
  const close = () => returned ??= Promise.resolve(iterator?.return?.());
  const ownedIterator: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      try {
        if (first) { const value = first; first = undefined; if (value.done) await close(); return value; }
        const next = await iterator!.next();
        if (next.done) await close(); else await options.authorize?.();
        return next;
      } catch (error) { await close(); throw error; }
    },
    async return() { await close(); return { done: true as const, value: undefined }; },
  };
  const stream = request.method === 'HEAD' ? Readable.from([]) : Readable.from(ownedIterator);
  try {
    const encoded = encodeURIComponent(options.filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.header('Content-Type', options.mediaType);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', `${options.download ? 'attachment' : 'inline'}; filename="${options.fallbackFilename}"; filename*=UTF-8''${encoded}`);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('ETag', `"${asset.sha256}"`);
    reply.header('Content-Length', range ? range.end - range.start + 1 : size);
    if (range) { reply.code(206); reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`); }
    return reply.send(stream);
  } catch (error) { stream.destroy(); await close(); throw error; }
}
