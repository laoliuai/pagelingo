import { webCaptureResultSchema, type WebCaptureResult } from '@pagelingo/document-contracts';
import type { ArchiveEntry } from './database';
import { hostPermission } from './binding';

export type ArchivePayload = Pick<ArchiveEntry, 'partition' | 'id' | 'draft' | 'request' | 'linkRequest' | 'grant' | 'resources' | 'warnings'>;
export type ArchiveHeader = Omit<ArchiveEntry, 'draft' | 'request' | 'linkRequest' | 'grant' | 'resources'> & {
  title: string; completeWithinScope: boolean | null; permissionOrigins: string[];
};
const boundedWarnings = (warnings: string[]) => warnings.slice(0, 20).map(warning => warning.slice(0, 500));
function boundedReceipt(result: WebCaptureResult | undefined): WebCaptureResult | undefined {
  if (!result) return undefined;
  // Validate BEFORE dropping receipt arrays or truncating warnings; normalization must never
  // turn malformed legacy data into a seemingly complete, valid acknowledgement.
  const valid = webCaptureResultSchema.safeParse(result).success;
  return { id: result.id.slice(0, 36), captureId: result.captureId.slice(0, 36), status: result.status,
    documentId: result.documentId?.slice(0, 36) ?? null, sourceVersionId: result.sourceVersionId?.slice(0, 36) ?? null,
    readerVersionId: result.readerVersionId?.slice(0, 36) ?? null, jobId: result.jobId?.slice(0, 36) ?? null,
    saveStatus: result.saveStatus, errorCode: result.errorCode?.slice(0, 2000) ?? null,
    receivedFileIds: [], missingFileIds: valid ? result.missingFileIds.slice(0, 1) : ['invalid-local-receipt'],
    warnings: boundedWarnings(result.warnings), createdAt: result.createdAt.slice(0, 64), updatedAt: result.updatedAt.slice(0, 64) };
}
export function splitArchiveEntry(entry: ArchiveEntry): { header: ArchiveHeader; payload: ArchivePayload } {
  const { draft, request, linkRequest, grant, resources, warnings, ...status } = entry;
  return {
    header: { ...status, title: (draft?.metadata.title ?? linkRequest?.title ?? linkRequest?.url ?? '').slice(0, 2000),
      completeWithinScope: draft?.snapshot.scope.completeWithinScope ?? null,
      permissionOrigins: [...new Set(draft?.pendingResources.flatMap(resource => resource.url?.startsWith('https:') && !('missingReason' in resource && resource.missingReason) ? [hostPermission(resource.url)] : []) ?? [])].slice(0, 16),
      warnings: boundedWarnings(warnings), error: status.error?.slice(0, 2000),
      result: boundedReceipt(status.result) },
    payload: { partition: entry.partition, id: entry.id, draft, request, linkRequest, grant, resources, warnings },
  };
}
export function joinArchiveEntry(header: ArchiveHeader, payload?: ArchivePayload): ArchiveEntry {
  return { ...header, resources: [], ...payload };
}
