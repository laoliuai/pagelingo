import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  resolveTrustedCatalog,
  createStaticFilePlan,
  type ReaderBuild,
} from '@pagelingo/document-renderer';
import type { DocumentBundleManifest } from '@pagelingo/document-contracts';
import { createDirectoryFileSource } from './file-source.js';
import { check } from './errors.js';
import { checkSize, fileLimit } from './limits.js';
import type { BundleLimits } from './types.js';
const require = createRequire(import.meta.url);
export async function validateStaticFiles(
  manifest: DocumentBundleManifest,
  build: ReaderBuild,
  limits: BundleLimits,
  checkpoint: () => Promise<void>,
): Promise<Set<string>> {
  const catalog = resolveTrustedCatalog(manifest.renderer);
  const plan = createStaticFilePlan(build, {
    title: manifest.title,
    originalFilename: manifest.originalFilename,
  }, catalog);
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  const allowed = new Set<string>();
  let total = 0;
  for (const asset of plan.trustedAssets) {
    await checkpoint();
    const file = files.get(asset.path);
    check(file, 'BUNDLE_MISSING_RESOURCE');
    const role = asset.path.startsWith('licenses/') ? 'license' : 'asset';
    check(
      file.role === role &&
        file.mediaType === asset.mediaType &&
        file.bytes === asset.bytes &&
        file.sha256 === asset.sha256,
    );
    const root = dirname(
      require.resolve(`${asset.source.package}/package.json`),
    );
    const source = createDirectoryFileSource(root, limits);
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of source.read(asset.source.path)) {
      bytes += chunk.byteLength;
      checkSize(bytes, fileLimit(asset.path, limits));
      hash.update(chunk);
    }
    check(bytes === asset.bytes && hash.digest('hex') === asset.sha256);
    allowed.add(asset.path);
    total += bytes;
    checkSize(total, limits.maxExpandedBytes);
  }
  // Iterator.next() performs bounded synchronous rendering. Yield before and after
  // each file so abort/deadline changes are observable between bounded chunks.
  const iterator = plan.generatedFiles[Symbol.iterator]();
  while (true) {
    await checkpoint();
    const next = iterator.next();
    await checkpoint();
    if (next.done) break;
    const generated = next.value,
      body = Buffer.from(generated.content, 'utf8');
    checkSize(body.length, fileLimit(generated.path, limits));
    total += body.length;
    checkSize(total, limits.maxExpandedBytes);
    const file = files.get(generated.path);
    check(file, 'BUNDLE_MISSING_RESOURCE');
    check(
      file.role === 'render' &&
        file.mediaType === generated.mediaType &&
        file.bytes === body.length &&
        file.sha256 === createHash('sha256').update(body).digest('hex'),
    );
    allowed.add(generated.path);
  }
  return allowed;
}
