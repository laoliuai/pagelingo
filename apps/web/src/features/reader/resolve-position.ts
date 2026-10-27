import type { ReaderIndex, ReadingProgress } from '@pagelingo/document-contracts';

export interface ResolvedPosition {
  chunkId: string | null;
  blockId: string | null;
  blockOffset: number;
  pdfPageIndex: number;
  fallbackReason?: 'version-updated-source-page';
}
/** Prefer a chunk starting on this page over an earlier block with cross-page references. */
export function pageChunkIndex(index: ReaderIndex, page: number): number {
  const starting = index.chunks.findIndex(chunk => chunk.pageIndices[0] === page);
  return starting >= 0 ? starting : Math.max(0, index.chunks.findIndex(chunk => chunk.pageIndices.includes(page)));
}
/** Resolve only the server's validated index; immutable source data stays on the server. */
export function resolvePosition(index: ReaderIndex, saved: ReadingProgress | null): ResolvedPosition {
  const position = saved?.position;
  const page = position?.pdfPageIndex ?? 0;
  const location = position?.parseId === index.parseId && position.blockId
    ? index.blockLocations[position.blockId] : undefined;
  if (location) return { chunkId: location.chunkId, blockId: position!.blockId, blockOffset: position!.blockOffset, pdfPageIndex: page };
  return { chunkId: index.chunks[pageChunkIndex(index, page)]?.id ?? null,
    blockId: null, blockOffset: 0, pdfPageIndex: page,
    ...(position && (position.parseId !== index.parseId || position.blockId !== null) ? { fallbackReason: 'version-updated-source-page' as const } : {}) };
}
