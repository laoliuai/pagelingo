import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bundlePathSchema, type BundleFile, type BundleLimits } from '@pagelingo/document-contracts';
import { BundleError, createDirectoryFileSource } from '@pagelingo/document-bundle';
import { createStaticFilePlan, type ReaderBuild, type OfflineMetadata } from '@pagelingo/document-renderer';

const require = createRequire(import.meta.url);
export const body = async function* (bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; };

/** Materialize one bounded file at a time; the complete book is never buffered. */
export class OfflineWriter {
  readonly files: BundleFile[] = [];
  private total = 0;
  private paths = new Set<string>();
  constructor(private root: string, private limits: BundleLimits, private signal?: AbortSignal) {}

  async write(path: string, mediaType: string, role: BundleFile['role'], chunks: AsyncIterable<Uint8Array>, expected?: { bytes?: number; sha256: string }): Promise<BundleFile> {
    this.signal?.throwIfAborted();
    bundlePathSchema.parse(path);
    if (this.paths.has(path.toLowerCase())) throw new BundleError('INVALID_BUNDLE');
    this.paths.add(path.toLowerCase());
    if (this.paths.size > this.limits.maxFiles) throw new BundleError('BUNDLE_TOO_LARGE');
    const limit = path === 'source.pdf' ? this.limits.maxPdfBytes
      : path === 'source-ir.json' ? this.limits.maxIrBytes
      : path === 'translation.json' ? this.limits.maxTranslationBytes
      : path === 'manifest.json' ? this.limits.maxManifestBytes
      : role === 'provenance' ? this.limits.maxProvenanceFileBytes : this.limits.maxOtherFileBytes;
    await mkdir(dirname(join(this.root, path)), { recursive: true, mode: 0o700 });
    const handle = await open(join(this.root, path), 'wx', 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of chunks) {
        this.signal?.throwIfAborted();
        bytes += chunk.byteLength; this.total += chunk.byteLength;
        if (bytes > limit || this.total > this.limits.maxExpandedBytes) throw new BundleError('BUNDLE_TOO_LARGE');
        hash.update(chunk);
        // FileHandle.write may perform a short write.
        for (let offset = 0; offset < chunk.byteLength;) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
      }
      const sha256 = hash.digest('hex');
      if (expected && (sha256 !== expected.sha256 || expected.bytes !== undefined && bytes !== expected.bytes)) throw new BundleError('INVALID_BUNDLE');
      await handle.sync();
      const file = { path, mediaType, role, bytes, sha256 };
      if (path !== 'manifest.json') this.files.push(file);
      return file;
    } finally { await handle.close(); }
  }

  async staticFiles(build: ReaderBuild, metadata: OfflineMetadata): Promise<{ version: string; codeSha256: string }> {
    const plan = createStaticFilePlan(build, metadata);
    for (const asset of plan.trustedAssets) {
      const root = dirname(require.resolve(`${asset.source.package}/package.json`));
      const source = createDirectoryFileSource(root, this.limits, this.signal);
      await this.write(asset.path, asset.mediaType, asset.path.startsWith('licenses/') ? 'license' : 'asset', source.read(asset.source.path), asset);
    }
    for (const file of plan.generatedFiles) await this.write(file.path, file.mediaType, 'render', body(Buffer.from(file.content, 'utf8')));
    return { version: plan.rendererVersion, codeSha256: plan.rendererSha256 };
  }
}
