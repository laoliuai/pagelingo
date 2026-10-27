import { readingProgressSchema, type ReaderDescriptor, type ReadingPosition } from '@pagelingo/document-contracts';
import { useInteractionProgress } from './use-interaction-progress';
export function useReadingProgress({ documentId, descriptor, onConflict }: { documentId: string; descriptor: ReaderDescriptor; onConflict?: () => void }) {
  return useInteractionProgress<ReadingPosition>({ path: `/api/v1/documents/${documentId}/progress`, descriptor, parseProgress: readingProgressSchema.parse, onConflict });
}
