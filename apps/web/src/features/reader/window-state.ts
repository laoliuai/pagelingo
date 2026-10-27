import type { ReaderChunk, ReaderDescriptor } from '@pagelingo/document-contracts';
import { apiRequest } from '../../shared/api-client';
import { ChunkWindow } from './chunk-window';
export type { ContentPosition, ContentTarget, InteractionOrigin } from './chunk-window';
export class ReaderWindow extends ChunkWindow<ReaderChunk> {
  constructor(descriptor: ReaderDescriptor) {
    super(descriptor, (id, signal) => apiRequest(`/api/v1/documents/${descriptor.documentId}/readers/${descriptor.versionId}/chunks/${id}`, { signal }));
  }
}
