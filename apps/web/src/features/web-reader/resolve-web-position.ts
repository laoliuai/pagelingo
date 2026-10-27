import type { WebReaderDescriptor, WebReadingProgress, WebReadingPosition } from '@pagelingo/document-contracts';
export function resolveWebPosition(descriptor: WebReaderDescriptor, saved: WebReadingProgress | null): WebReadingPosition {
  const position = saved?.position;
  const valid = position?.readerVersionId === descriptor.versionId && position.sourceVersionId === descriptor.source.sourceVersionId && position.parseId === descriptor.parseId;
  return { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId,
    blockId: valid && position.blockId && Object.hasOwn(descriptor.index.blockLocations, position.blockId) ? position.blockId : null,
    blockOffset: valid ? position.blockOffset : 0, view: valid ? position.view : 'content', contentMode: valid ? position.contentMode : 'source' };
}
