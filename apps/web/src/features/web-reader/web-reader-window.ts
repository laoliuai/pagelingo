import { webReaderChunkSchema, type WebReaderChunk, type WebReaderDescriptor } from '@pagelingo/document-contracts';
import { ChunkWindow } from '../reader/chunk-window';
import { apiRequest } from '../../shared/api-client';
export class WebReaderWindow extends ChunkWindow<WebReaderChunk> {
  constructor(descriptor: WebReaderDescriptor) {
    super(descriptor, async (id, signal) => webReaderChunkSchema.parse(await apiRequest(`/api/v1/documents/${descriptor.documentId}/web-reader/versions/${descriptor.versionId}/chunks/${id}`, { signal })));
  }
}
