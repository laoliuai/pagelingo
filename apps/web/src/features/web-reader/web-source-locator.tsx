import type { WebReaderDescriptor, WebSourceRef } from '@pagelingo/document-contracts';
/** Only registered source nodes locate a preview. Never guess from a repeated quote. */
export function locateWebSource(descriptor: WebReaderDescriptor, reference: WebSourceRef) {
  const location = Object.hasOwn(descriptor.snapshots.nodeLocations, reference.nodeId) ? descriptor.snapshots.nodeLocations[reference.nodeId] : undefined;
  const preview = location && descriptor.snapshots.previews.find(item => item.id === location.previewId && item.nodeIds.includes(reference.nodeId));
  return preview && location ? { preview, anchorId: location.anchorId } : null;
}
