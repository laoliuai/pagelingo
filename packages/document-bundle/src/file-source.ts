import { constants } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BundleLimits } from '@pagelingo/document-contracts';
import { aborted, check, sanitize } from './errors.js';
import { checkedLimits, checkSize, fileLimit } from './limits.js';
import { PathRegistry, validatePath } from './paths.js';
import type { BundleFileSource, FileInfo } from './types.js';

// Pin each ancestor before opening its child. O_NOFOLLOW on only the final file
// does not protect against an attacker replacing an intermediate directory.
function fdPath(handle: FileHandle): string {
  check(process.platform === 'linux');
  return `/proc/self/fd/${handle.fd}`;
}
async function openDirectory(path: string): Promise<FileHandle> {
  const parts = resolve(path).split('/').filter(Boolean);
  let handle = await open(
    '/',
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of parts) {
      const child = await open(
        `${fdPath(handle)}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = child;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function openMember(root: string, path: string): Promise<FileHandle> {
  let dir = await openDirectory(root);
  const parts = path.split('/');
  try {
    for (const part of parts.slice(0, -1)) {
      const child = await open(
        `${fdPath(dir)}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await dir.close();
      dir = child;
    }
    // NONBLOCK ensures a raced-in FIFO cannot stall the operation before fstat.
    const file = await open(
      `${fdPath(dir)}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      check((await file.stat()).isFile());
      return file;
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  } finally {
    await dir.close();
  }
}
/** Linux local adapter: reject all symlinks, including root ancestors, under races. */
export function createDirectoryFileSource(
  root: string,
  inputLimits: BundleLimits,
  signal?: AbortSignal,
): BundleFileSource {
  const limits = checkedLimits(inputLimits);
  return {
    async list() {
      let dir: FileHandle | undefined;
      try {
        aborted(signal);
        dir = await openDirectory(root);
        const files: FileInfo[] = [],
          paths = new PathRegistry(limits.maxPathBytes);
        let total = 0;
        const visit = async (
          handle: FileHandle,
          prefix: string,
        ): Promise<void> => {
          for (const entry of await readdir(fdPath(handle), {
            withFileTypes: true,
          })) {
            aborted(signal);
            const path = prefix + entry.name;
            validatePath(path, limits.maxPathBytes);
            if (entry.isDirectory()) {
              const child = await open(
                `${fdPath(handle)}/${entry.name}`,
                constants.O_RDONLY |
                  constants.O_DIRECTORY |
                  constants.O_NOFOLLOW,
              );
              try {
                await visit(child, `${path}/`);
              } finally {
                await child.close();
              }
            } else {
              check(entry.isFile());
              paths.add(path);
              const file = await open(
                `${fdPath(handle)}/${entry.name}`,
                constants.O_RDONLY |
                  constants.O_NOFOLLOW |
                  constants.O_NONBLOCK,
              );
              try {
                const stat = await file.stat();
                check(stat.isFile());
                checkSize(stat.size, fileLimit(path, limits));
                total += stat.size;
                checkSize(total, limits.maxExpandedBytes);
                files.push({ path, bytes: stat.size });
                checkSize(files.length, limits.maxFiles);
              } finally {
                await file.close();
              }
            }
          }
        };
        await visit(dir, '');
        return files.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
      } catch (error) {
        throw sanitize(error, signal);
      } finally {
        await dir?.close();
      }
    },
    async *read(path) {
      let file: FileHandle | undefined;
      try {
        aborted(signal);
        validatePath(path, limits.maxPathBytes);
        file = await openMember(root, path);
        const stat = await file.stat();
        checkSize(stat.size, fileLimit(path, limits));
        const stream = file.createReadStream({
          autoClose: false,
          highWaterMark: 65536,
        });
        const onAbort = (): void => {
          stream.destroy(sanitize(undefined, signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        let bytes = 0;
        try {
          for await (const chunk of stream) {
            aborted(signal);
            bytes += chunk.byteLength;
            checkSize(bytes, fileLimit(path, limits));
            checkSize(bytes, limits.maxExpandedBytes);
            yield chunk;
          }
          aborted(signal);
          check(bytes === stat.size);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          stream.destroy();
        }
      } catch (error) {
        throw sanitize(error, signal);
      } finally {
        await file?.close();
      }
    },
  };
}
/** Small generated inputs; bytes are copied so later caller mutations cannot alter a read. */
export function createMemoryFileSource(
  files: ReadonlyMap<string, Uint8Array>,
  inputLimits: BundleLimits,
): BundleFileSource {
  const limits = checkedLimits(inputLimits),
    paths = new PathRegistry(limits.maxPathBytes);
  let total = 0;
  checkSize(files.size, limits.maxFiles);
  const copy = new Map<string, Buffer>();
  for (const [path, body] of files) {
    paths.add(path);
    checkSize(body.byteLength, fileLimit(path, limits));
    total += body.byteLength;
    checkSize(total, limits.maxExpandedBytes);
    copy.set(path, Buffer.from(body));
  }
  return {
    async list() {
      return [...copy].map(([path, body]) => ({ path, bytes: body.length }));
    },
    async *read(path) {
      validatePath(path, limits.maxPathBytes);
      const body = copy.get(path);
      check(body, 'BUNDLE_MISSING_RESOURCE');
      yield Buffer.from(body);
    },
  };
}
