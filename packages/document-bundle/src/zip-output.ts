import type { WriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  open,
  link,
  unlink,
  mkdir,
  rmdir,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import { check, aborted, BundleError, sanitize } from './errors.js';
import { checkedLimits, checkSize, fileLimit } from './limits.js';
import { serializeBundleJson } from './manifest.js';
import type {
  BundleFileSource,
  BundleOptions,
  BundleIdentity,
  BundleLimits,
  ValidatedBundle,
  ValidatedWebBundle,
} from './types.js';
/** Validate first, re-hash every streamed input, publish with atomic no-replace link. */
export async function writeValidatedBundle(
  input: BundleFileSource,
  destination: string,
  options: BundleOptions,
  validate: (input: BundleFileSource, options: BundleOptions) => Promise<ValidatedBundle | ValidatedWebBundle>,
  preserveManifest = false,
  streamFileLimit: (path: string, limits: BundleLimits) => number = fileLimit,
): Promise<BundleIdentity> {
  let handle: FileHandle | undefined,
    temp: string | undefined,
    staging: string | undefined;
  const streams = new Set<Readable>();
  let archive: yazl.ZipFile | undefined;
  let sink: WriteStream | undefined;
  const stop = (): void => {
    for (const stream of streams)
      stream.destroy(new BundleError('BUNDLE_ABORTED'));
    (archive?.outputStream as Readable | undefined)?.destroy(
      new BundleError('BUNDLE_ABORTED'),
    );
  };
  try {
    const limits = checkedLimits(options.limits),
      validated = await validate(input, options);
    aborted(options.signal);
    const stagingPath = join(
      dirname(destination),
      `.pagelingo-bundle-${randomUUID()}`,
    );
    await mkdir(stagingPath, { mode: 0o700 });
    staging = stagingPath;
    temp = join(staging, 'archive.zip');
    handle = await open(temp, 'wx', 0o600);
    archive = new yazl.ZipFile();
    const output = archive.outputStream as Readable;
    archive.on('error', (error: Error) => {
      output.destroy(error);
      for (const stream of streams) stream.destroy(error);
    });
    options.signal?.addEventListener('abort', stop, { once: true });
    let expanded = 0,
      compressed = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        try {
          aborted(options.signal);
          compressed += chunk.length;
          checkSize(compressed, limits.maxArchiveBytes);
          done(null, chunk);
        } catch (error) {
          done(sanitize(error, options.signal));
        }
      },
    });
    sink = handle.createWriteStream({ autoClose: false });
    // Attach rejection handling immediately, before adding entries can start pumping.
    const writing = pipeline(output, counter, sink);
    writing.catch(() => {});
    const manifestBody = Buffer.from(serializeBundleJson(validated.manifest));
    const manifestBytes = preserveManifest
      ? (await input.list()).find(file => file.path === 'manifest.json')?.bytes
      : manifestBody.length;
    check(manifestBytes !== undefined);
    checkSize(manifestBytes, limits.maxManifestBytes);
    const files = [
      {
        path: 'manifest.json',
        bytes: manifestBytes,
        sha256: preserveManifest ? validated.manifestSha256 : createHash('sha256').update(manifestBody).digest('hex'),
      },
      ...validated.files,
    ];
    for (const file of files) {
      archive.addReadStreamLazy(
        file.path,
        {
          size: file.bytes,
          mode: 0o100600,
          mtime: new Date('1980-01-01T00:00:00Z'),
          compress: true,
        },
        (callback) => {
          async function* checkedBody(): AsyncIterable<Uint8Array> {
            let bytes = 0;
            const hash = createHash('sha256');
            const body =
              file.path === 'manifest.json' && !preserveManifest
                ? (async function* () {
                    yield manifestBody;
                  })()
                : input.read(file.path);
            for await (const chunk of body) {
              aborted(options.signal);
              check(chunk instanceof Uint8Array);
              bytes += chunk.byteLength;
              expanded += chunk.byteLength;
              checkSize(bytes, streamFileLimit(file.path, limits));
              check(bytes <= file.bytes);
              checkSize(expanded, limits.maxExpandedBytes);
              hash.update(chunk);
              yield chunk;
            }
            aborted(options.signal);
            check(bytes === file.bytes && hash.digest('hex') === file.sha256);
          }
          const stream = Readable.from(checkedBody(), {
            objectMode: false,
            highWaterMark: 65536,
          });
          streams.add(stream);
          stream.once('close', () => streams.delete(stream));
          stream.on('error', (error: Error) => output.destroy(error));
          callback(null, stream);
        },
      );
    }
    archive.end();
    await writing;
    aborted(options.signal);
    await handle.sync();
    sink.destroy();
    await handle.close();
    handle = undefined;
    aborted(options.signal);
    // link() fails atomically with EEXIST. rename() would overwrite a raced-in ZIP.
    try {
      await link(temp, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new BundleError('BUNDLE_DESTINATION_EXISTS');
      throw error;
    }
    await unlink(temp);
    temp = undefined;
    return {
      packageId: validated.packageId,
      manifestSha256: validated.manifestSha256,
    };
  } catch (error) {
    for (const stream of streams) stream.destroy();
    (archive?.outputStream as Readable | undefined)?.destroy();
    throw sanitize(error, options.signal);
  } finally {
    options.signal?.removeEventListener('abort', stop);
    sink?.destroy();
    await handle?.close().catch(() => {});
    if (temp) await unlink(temp).catch(() => {});
    if (staging) await rmdir(staging).catch(() => {});
  }
}
