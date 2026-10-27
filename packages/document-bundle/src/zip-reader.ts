import { open as openFd, close as closeFd, constants } from 'node:fs';
import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import * as yauzl from 'yauzl';
import type { BundleLimits } from '@pagelingo/document-contracts';
import { aborted, check, sanitize } from './errors.js';
import { checkedLimits, checkSize, fileLimit } from './limits.js';
import { PathRegistry } from './paths.js';
import type { ArchiveEntry, BundleFileSource, FileInfo } from './types.js';

async function openZip(
  path: string,
  limits: BundleLimits,
  signal?: AbortSignal,
): Promise<yauzl.ZipFile> {
  aborted(signal);
  const fd = await new Promise<number>((resolve, reject) =>
    openFd(path, constants.O_RDONLY | constants.O_NOFOLLOW, (error, fd) =>
      error ? reject(error) : resolve(fd),
    ),
  );
  let ownedByZip = false;
  try {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.fromFd(
        fd,
        {
          lazyEntries: true,
          strictFileNames: true,
          validateEntrySizes: true,
          autoClose: true,
        },
        (e, z) => (e ? reject(e) : resolve(z!)),
      ),
    );
    ownedByZip = true;
    try {
      checkSize(zip.fileSize, limits.maxArchiveBytes);
      checkSize(zip.entryCount, limits.maxFiles);
      aborted(signal);
      return zip;
    } catch (error) {
      zip.close();
      throw error;
    }
  } catch (error) {
    if (!ownedByZip) closeFd(fd, () => {});
    throw error;
  }
}
function metadata(
  entry: yauzl.Entry,
  paths: PathRegistry,
  limits: BundleLimits,
): FileInfo {
  paths.add(entry.fileName);
  check(
    (entry.generalPurposeBitFlag & 0x41) === 0 &&
      [0, 8].includes(entry.compressionMethod),
  );
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  check(
    (mode === 0 || mode === 0x8000) &&
      (entry.externalFileAttributes & 0x10) === 0,
  );
  checkSize(entry.uncompressedSize, fileLimit(entry.fileName, limits));
  checkSize(entry.compressedSize, limits.maxArchiveBytes);
  return { path: entry.fileName, bytes: entry.uncompressedSize };
}
class Session {
  failure: unknown;
  active?: Readable;
  private readonly onError = (error: Error): void => {
    this.failure = error;
    this.active?.destroy(error);
  };
  private readonly onAbort = (): void => {
    this.active?.destroy(sanitize(undefined, this.signal));
    this.zip.close();
  };
  constructor(
    readonly zip: yauzl.ZipFile,
    readonly signal?: AbortSignal,
  ) {
    zip.on('error', this.onError);
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }
  async next(): Promise<yauzl.Entry | null> {
    aborted(this.signal);
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.zip.off('entry', entry);
        this.zip.off('end', end);
        this.zip.off('error', error);
        this.signal?.removeEventListener('abort', abort);
      };
      const entry = (value: yauzl.Entry): void => {
        cleanup();
        resolve(value);
      };
      const end = (): void => {
        cleanup();
        resolve(null);
      };
      const error = (value: Error): void => {
        cleanup();
        reject(value);
      };
      const abort = (): void => {
        cleanup();
        reject(sanitize(undefined, this.signal));
      };
      this.zip.once('entry', entry);
      this.zip.once('end', end);
      this.zip.once('error', error);
      this.signal?.addEventListener('abort', abort, { once: true });
      this.zip.readEntry();
    });
  }
  async *body(
    entry: yauzl.Entry,
    limit: number,
    account: (n: number) => void,
  ): AsyncIterable<Uint8Array> {
    aborted(this.signal);
    if (this.failure) throw this.failure;
    const stream = await new Promise<Readable>((resolve, reject) =>
      this.zip.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s!))),
    );
    this.active = stream;
    let bytes = 0,
      crc = 0;
    try {
      aborted(this.signal);
      for await (const chunk of stream) {
        aborted(this.signal);
        check(chunk instanceof Uint8Array);
        bytes += chunk.byteLength;
        checkSize(bytes, limit);
        check(bytes <= entry.uncompressedSize);
        account(chunk.byteLength);
        crc = crc32(chunk, crc);
        yield chunk;
      }
      aborted(this.signal);
      check(bytes === entry.uncompressedSize && crc === entry.crc32);
    } finally {
      this.active = undefined;
      stream.destroy();
    }
  }
  close(): void {
    this.active?.destroy();
    this.signal?.removeEventListener('abort', this.onAbort);
    this.zip.close();
  }
}
/** Sequential, no extraction. Consume each content fully exactly once before advancing. */
export async function* readArchive(
  path: string,
  inputLimits: BundleLimits,
  signal?: AbortSignal,
): AsyncIterable<ArchiveEntry> {
  let session: Session | undefined;
  try {
    const limits = checkedLimits(inputLimits);
    session = new Session(await openZip(path, limits, signal), signal);
    const paths = new PathRegistry(limits.maxPathBytes);
    let expanded = 0,
      declared = 0,
      count = 0;
    while (true) {
      const entry = await session.next();
      if (!entry) break;
      checkSize(++count, limits.maxFiles);
      const info = metadata(entry, paths, limits);
      declared += info.bytes;
      checkSize(declared, limits.maxExpandedBytes);
      let used = false,
        complete = false;
      const current = session;
      const content = {
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          check(!used);
          used = true;
          try {
            for await (const chunk of current.body(
              entry,
              fileLimit(info.path, limits),
              (n) => {
                expanded += n;
                checkSize(expanded, limits.maxExpandedBytes);
              },
            ))
              yield chunk;
            complete = true;
          } catch (error) {
            throw sanitize(error, signal);
          }
        },
      };
      yield { ...info, content };
      check(complete);
    }
  } catch (error) {
    throw sanitize(error, signal);
  } finally {
    session?.close();
  }
}
/** Central-directory index only; each read opens and closes its own ZIP handle. */
export function createArchiveFileSource(
  path: string,
  inputLimits: BundleLimits,
  signal?: AbortSignal,
): BundleFileSource {
  const limits = checkedLimits(inputLimits);
  let indexPromise: Promise<Map<string, yauzl.Entry>> | undefined;
  const index = (): Promise<Map<string, yauzl.Entry>> =>
    (indexPromise ??= (async () => {
      let session: Session | undefined;
      try {
        session = new Session(await openZip(path, limits, signal), signal);
        const paths = new PathRegistry(limits.maxPathBytes),
          entries = new Map<string, yauzl.Entry>();
        let total = 0;
        while (true) {
          const entry = await session.next();
          if (!entry) break;
          const info = metadata(entry, paths, limits);
          entries.set(info.path, entry);
          checkSize(entries.size, limits.maxFiles);
          total += info.bytes;
          checkSize(total, limits.maxExpandedBytes);
        }
        return entries;
      } catch (error) {
        throw sanitize(error, signal);
      } finally {
        session?.close();
      }
    })());
  return {
    async list() {
      aborted(signal);
      return [...(await index()).values()].map((e) => ({
        path: e.fileName,
        bytes: e.uncompressedSize,
      }));
    },
    async *read(name) {
      let session: Session | undefined;
      try {
        const entry = (await index()).get(name);
        check(entry, 'BUNDLE_MISSING_RESOURCE');
        session = new Session(await openZip(path, limits, signal), signal);
        yield* session.body(entry, fileLimit(name, limits), () => {});
      } catch (error) {
        throw sanitize(error, signal);
      } finally {
        session?.close();
      }
    },
  };
}
