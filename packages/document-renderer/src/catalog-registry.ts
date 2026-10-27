import type { ReaderBuild } from './chunking.js';
import { createStaticFilePlan, type GeneratedStaticFile, type OfflineMetadata, type TrustedAsset } from './static.js';
import { rendererVersion, rendererSha256, trustedStaticAssets } from './static-catalog.js';
import { createStaticFilePlan as createS2Plan } from './compat/s2-0.1.0/static.js';
import { rendererVersion as s2Version, rendererSha256 as s2Sha256, trustedStaticAssets as s2Assets } from './compat/s2-0.1.0/catalog.js';

export interface TrustedRendererCatalog {
  readonly version: string;
  readonly codeSha256: string;
  readonly trustedAssets: readonly TrustedAsset[];
  readonly generateFiles: (build: ReaderBuild, metadata: OfflineMetadata) => Iterable<GeneratedStaticFile>;
}
const current: TrustedRendererCatalog = Object.freeze({
  version: rendererVersion, codeSha256: rendererSha256, trustedAssets: trustedStaticAssets,
  generateFiles: (build: ReaderBuild, metadata: OfflineMetadata) => createStaticFilePlan(build, metadata).generatedFiles,
});
const publishedS2: TrustedRendererCatalog = Object.freeze({
  version: s2Version, codeSha256: s2Sha256, trustedAssets: s2Assets,
  generateFiles: (build: ReaderBuild, metadata: OfflineMetadata) => createS2Plan(build, metadata).generatedFiles,
});

/** Exact version AND code identity: there are no historical aliases or caller-provided catalogs. */
export function resolveTrustedCatalog(identity: { version: string; codeSha256: string }): TrustedRendererCatalog {
  const catalog = [current, publishedS2].find(catalog =>
    catalog.version === identity.version && catalog.codeSha256 === identity.codeSha256);
  if (!catalog) throw new Error('Untrusted renderer catalog');
  return catalog;
}
