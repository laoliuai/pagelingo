import { createHash } from 'node:crypto';
import { stableJson } from '@pagelingo/translation-core';
import {
  documentBundleManifestSchema,
  type DocumentBundleManifest,
} from '@pagelingo/document-contracts';
import { check } from './errors.js';
import { PathRegistry } from './paths.js';
import { checkSize } from './limits.js';
import type { BundleLimits, FileInfo } from './types.js';
export const requiredBundlePaths = Object.freeze({
  source: 'source.pdf',
  ir: 'source-ir.json',
  translation: 'translation.json',
  inputManifest: 'provenance/input-manifest.json',
  parserConfig: 'provenance/parser-config.json',
});
/** UTF-8, SDK stableJson, no newline/BOM. Hash the returned bytes for file bindings. */
export function serializeBundleJson(value: unknown): Uint8Array {
  return Buffer.from(stableJson(value), 'utf8');
}
/** Frozen concatenation, without delimiters, as specified by Reader v1. */
export function deriveParseId(
  sourceSha256: string,
  inputManifestSha256: string,
  projectorVersion: string,
  configSha256: string,
): string {
  check(
    [sourceSha256, inputManifestSha256, configSha256].every((v) =>
      /^[a-f0-9]{64}$/.test(v),
    ) && projectorVersion.length > 0,
  );
  return (
    'p_' +
    createHash('sha256')
      .update(
        sourceSha256 + inputManifestSha256 + projectorVersion + configSha256,
      )
      .digest('hex')
  );
}
export function admitManifest(
  value: unknown,
  listed: FileInfo[],
  limits: BundleLimits,
): DocumentBundleManifest {
  const manifest = documentBundleManifestSchema.parse(value);
  check(
    manifest.originalFilename !== '.' &&
      manifest.originalFilename !== '..' &&
      !/[\\/\x00-\x1f\x7f]/.test(manifest.originalFilename),
  );
  const paths = new PathRegistry(limits.maxPathBytes);
  checkSize(manifest.files.length + 1, limits.maxFiles);
  paths.add('manifest.json');
  const available = new Map(listed.map((file) => [file.path, file]));
  for (const file of manifest.files) {
    paths.add(file.path);
    check(available.has(file.path), 'BUNDLE_MISSING_RESOURCE');
    check(file.bytes === available.get(file.path)!.bytes);
  }
  check(listed.length === manifest.files.length + 1);
  const members = new Map(manifest.files.map((f) => [f.path, f]));
  for (const path of Object.values(requiredBundlePaths))
    check(members.has(path), 'BUNDLE_MISSING_RESOURCE');
  for (const [path, role, mediaType] of [
    ['source.pdf', 'source', 'application/pdf'],
    ['source-ir.json', 'reader-ir', 'application/json'],
    ['translation.json', 'translation', 'application/json'],
    ['provenance/input-manifest.json', 'provenance', 'application/json'],
    ['provenance/parser-config.json', 'provenance', 'application/json'],
  ]) {
    const file = members.get(path)!;
    check(file.role === role && file.mediaType === mediaType);
  }
  check(
    members.get('source.pdf')!.sha256 === manifest.source.sha256 &&
      members.get('source.pdf')!.bytes === manifest.source.bytes,
  );
  check(
    members.get('source-ir.json')!.sha256 === manifest.readerIrSha256 &&
      members.get('translation.json')!.sha256 === manifest.translation.sha256,
  );
  check(
    members.get(requiredBundlePaths.inputManifest)!.sha256 ===
      manifest.parse.inputManifestSha256 &&
      members.get(requiredBundlePaths.parserConfig)!.sha256 ===
        manifest.parse.configSha256,
  );
  return manifest;
}
