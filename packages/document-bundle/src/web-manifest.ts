import { defaultCaptureLimits, webDocumentBundleManifestSchema, type WebDocumentBundleManifest } from '@pagelingo/document-contracts';
import { check } from './errors.js';
import { checkSize, fileLimit } from './limits.js';
import { PathRegistry } from './paths.js';
import type { BundleLimits, FileInfo } from './types.js';
export function admitWebManifest(value: unknown, listed: FileInfo[], limits: BundleLimits): WebDocumentBundleManifest {
  const manifest = webDocumentBundleManifestSchema.parse(value);
  const paths = new PathRegistry(limits.maxPathBytes), available = new Map(listed.map(f => [f.path, f]));
  paths.add('manifest.json'); checkSize(manifest.files.length + 1, limits.maxFiles);
  for (const file of manifest.files) {
    paths.add(file.path); const actual = available.get(file.path);
    check(actual, 'BUNDLE_MISSING_RESOURCE'); check(actual.bytes === file.bytes);
  }
  check(listed.length === manifest.files.length + 1);
  const members = new Map(manifest.files.map(f => [f.path, f]));
  const required = [
    ['source/manifest.json', 'source', manifest.source.manifestSha256],
    ['source-ir.json', 'reader-ir', manifest.parse.readerIrSha256],
    ...(manifest.translation ? [['translation.json', 'translation', manifest.translation.sha256]] : []),
  ];
  for (const [path, role, hash] of required) {
    const file = members.get(path); check(file, 'BUNDLE_MISSING_RESOURCE');
    check(file.role === role && file.mediaType === 'application/json' && file.sha256 === hash);
  }
  check(manifest.translation !== null || !members.has('translation.json'));
  check(members.has('render/index.html'), 'BUNDLE_MISSING_RESOURCE');
  return manifest;
}

/** Web bytes retain their capture ceilings even when bundle JSON budgets are larger. */
export function webFileLimit(path: string, limits: BundleLimits): number {
  return path === 'source-ir.json' || path.startsWith('source/') || path.startsWith('originals/')
    ? Math.min(defaultCaptureLimits.maxIrBytes, fileLimit(path, limits))
    : fileLimit(path, limits);
}
