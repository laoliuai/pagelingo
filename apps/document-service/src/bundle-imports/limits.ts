import { bundleLimitsOverrideSchema, defaultBundleLimits, type BundleLimits } from '@pagelingo/document-contracts';
export function readBundleLimits(raw: string | undefined, maxPdfBytes: number): BundleLimits {
  try {
    return { ...defaultBundleLimits, ...bundleLimitsOverrideSchema.parse(raw === undefined ? {} : JSON.parse(raw)), maxPdfBytes };
  } catch { throw new Error('Invalid PAGELINGO_BUNDLE_LIMITS_JSON'); }
}
