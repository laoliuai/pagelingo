import { ServiceError } from '../errors.js';
/** Same streaming PDF signature and byte policy for uploads and provider downloads. */
export async function* validatePdf(body: AsyncIterable<Uint8Array>, maxBytes: number): AsyncIterable<Uint8Array> {
  let bytes = 0, prefix = Buffer.alloc(0), recognized = false;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ServiceError(413, 'PDF_TOO_LARGE', 'PDF exceeds the upload limit');
    if (recognized) { yield chunk; continue; }
    const needed = Math.min(1024 - prefix.length, chunk.byteLength);
    prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
    if (prefix.includes(Buffer.from('%PDF-'))) {
      recognized = true; yield prefix; if (needed < chunk.byteLength) yield chunk.subarray(needed);
    } else if (prefix.length === 1024) throw new ServiceError(400, 'INVALID_PDF', 'PDF header was not found');
  }
  if (!recognized) throw new ServiceError(400, 'INVALID_PDF', 'PDF header was not found');
}
