import type { PendingCaptureResource, CaptureLimits, SanitizedSnapshot, SnapshotInput } from '@pagelingo/document-contracts';
import { domEnvironment } from './purify.js';
import { sanitizeSnapshot } from './sanitize.js';
export function sanitizeBrowserSnapshot(input: SnapshotInput, limits?: CaptureLimits, resources?: readonly PendingCaptureResource[]): SanitizedSnapshot {
  return sanitizeSnapshot(input, { ...domEnvironment(window), limits, resources });
}
export * from './index.js';
