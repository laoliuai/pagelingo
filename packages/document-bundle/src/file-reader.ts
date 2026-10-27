import { createHash } from 'node:crypto';
import { aborted, check, sanitize } from './errors.js';
import { checkSize, fileLimit } from './limits.js';
import type { BundleFileSource, BundleLimits, FileInfo } from './types.js';
export interface FileDigest {
  bytes: number;
  sha256: string;
  body?: Buffer;
  prefix: Buffer;
}
/** Buffers only explicitly requested single JSON/image files, never the archive. */
export async function digestFile(
  source: BundleFileSource,
  info: FileInfo,
  limits: BundleLimits,
  account: (bytes: number) => void,
  collect: boolean,
  signal?: AbortSignal,
): Promise<FileDigest> {
  const hash = createHash('sha256'),
    chunks: Buffer[] = [];
  let bytes = 0,
    prefix = Buffer.alloc(0);
  try {
    aborted(signal);
    for await (const chunk of source.read(info.path)) {
      aborted(signal);
      check(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      checkSize(bytes, fileLimit(info.path, limits));
      account(chunk.byteLength);
      hash.update(chunk);
      if (prefix.length < 1024)
        prefix = Buffer.concat([
          prefix,
          Buffer.from(chunk.subarray(0, 1024 - prefix.length)),
        ]);
      if (collect) chunks.push(Buffer.from(chunk));
    }
    aborted(signal);
    check(bytes === info.bytes);
    return {
      bytes,
      sha256: hash.digest('hex'),
      prefix,
      ...(collect ? { body: Buffer.concat(chunks, bytes) } : {}),
    };
  } catch (error) {
    throw sanitize(error, signal);
  }
}
