export type BundleErrorCode =
  | 'INVALID_BUNDLE'
  | 'BUNDLE_TOO_LARGE'
  | 'BUNDLE_MISSING_RESOURCE'
  | 'BUNDLE_ABORTED'
  | 'BUNDLE_UNSUPPORTED_SOURCE'
  | 'BUNDLE_DESTINATION_EXISTS';
const messages: Record<BundleErrorCode, string> = {
  INVALID_BUNDLE: 'Invalid document bundle',
  BUNDLE_TOO_LARGE: 'Document bundle exceeds configured limits',
  BUNDLE_MISSING_RESOURCE: 'Document bundle is missing a required resource',
  BUNDLE_UNSUPPORTED_SOURCE: 'Unsupported Web source projection configuration',
  BUNDLE_ABORTED: 'Document bundle operation was aborted',
  BUNDLE_DESTINATION_EXISTS: 'Document bundle destination already exists',
};
/** Stable, deliberately path/credential-free errors for CLI and service adapters. */
export class BundleError extends Error {
  constructor(readonly code: BundleErrorCode) {
    super(messages[code]);
    this.name = 'BundleError';
  }
}
export function check(
  value: unknown,
  code: BundleErrorCode = 'INVALID_BUNDLE',
): asserts value {
  if (!value) throw new BundleError(code);
}
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BundleError('BUNDLE_ABORTED');
}
export function sanitize(error: unknown, signal?: AbortSignal): BundleError {
  if (signal?.aborted) return new BundleError('BUNDLE_ABORTED');
  return error instanceof BundleError
    ? error
    : new BundleError('INVALID_BUNDLE');
}
