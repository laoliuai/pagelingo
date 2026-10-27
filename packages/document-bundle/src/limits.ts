import {
  bundleLimitsSchema,
  type BundleLimits,
} from '@pagelingo/document-contracts';
import { check, sanitize } from './errors.js';
export function checkedLimits(limits: BundleLimits): BundleLimits {
  try {
    return bundleLimitsSchema.parse(limits);
  } catch (error) {
    throw sanitize(error);
  }
}
export function fileLimit(path: string, limits: BundleLimits): number {
  if (path === 'manifest.json') return limits.maxManifestBytes;
  if (path === 'source.pdf') return limits.maxPdfBytes;
  if (path === 'source-ir.json') return limits.maxIrBytes;
  if (path === 'translation.json') return limits.maxTranslationBytes;
  return path.startsWith('provenance/')
    ? limits.maxProvenanceFileBytes
    : limits.maxOtherFileBytes;
}
export function checkSize(bytes: number, max: number): void {
  check(Number.isSafeInteger(bytes) && bytes >= 0);
  check(bytes <= max, 'BUNDLE_TOO_LARGE');
}
/** Scan structural depth before JSON.parse/Zod can recurse into untrusted input. */
export function parseBoundedJson(bytes: Uint8Array, maxDepth: number): unknown {
  let depth = 0,
    quoted = false,
    escape = false;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const c of text) {
    if (quoted) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') {
      depth++;
      check(depth <= maxDepth, 'BUNDLE_TOO_LARGE');
    } else if (c === ']' || c === '}') {
      depth--;
      check(depth >= 0);
    }
  }
  return JSON.parse(text);
}
