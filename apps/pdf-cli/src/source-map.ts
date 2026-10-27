import type {
  PdfSourceRef,
  PdfPageMetadata,
} from '@pagelingo/document-contracts';
import type {
  VerifiedP0Run,
  VerifiedPreview,
  SourceBinding,
} from './local-run.js';
export interface SourceContext {
  pageIndex: number;
  parsedPageIndex: number;
  blockIndex?: number;
  sourceId?: string;
}
export function mapSource(
  run: VerifiedP0Run,
  preview: VerifiedPreview,
  page: PdfPageMetadata,
  context: SourceContext,
): {
  ref: PdfSourceRef;
  lineage: Omit<SourceBinding, 'blockId' | 'semanticFile' | 'semanticPointer'>;
} {
  const fallback = (warning: string, rawRef?: string) => ({
    ref: { pageIndex: context.pageIndex, precision: 'page' } as PdfSourceRef,
    lineage: {
      precision: 'page' as const,
      warning,
      ...(rawRef ? { rawRef } : {}),
      ...(context.sourceId ? { sourceId: context.sourceId } : {}),
    },
  });
  const rp = run.raw.pages.findIndex(
    (p) => p.page_idx === context.parsedPageIndex,
  );
  const rb =
    run.raw.pages[rp]?.blocks.findIndex(
      (b) => b.index === context.blockIndex,
    ) ?? -1;
  const rawRef = rb >= 0 ? `#/pages/${rp}/blocks/${rb}` : undefined;
  const ep = preview.layout.pages.findIndex(
    (p) => p.sourcePageIndex === context.pageIndex,
  );
  const evidence = preview.layout.pages[ep];
  const sourceId =
    context.sourceId ??
    (context.blockIndex !== undefined
      ? `${run.metadata.runId}/p${context.pageIndex}/b${context.blockIndex}`
      : undefined);
  if (
    context.sourceId &&
    context.blockIndex !== undefined &&
    context.sourceId !==
      `${run.metadata.runId}/p${context.pageIndex}/b${context.blockIndex}` &&
    !context.sourceId.startsWith(
      `${run.metadata.runId}/p${context.pageIndex}/b${context.blockIndex}/c`,
    )
  )
    return fallback('source-identity-conflict', rawRef);
  const eb = evidence?.blocks.findIndex((b) => b.id === sourceId) ?? -1;
  if (eb < 0 || !evidence)
    return fallback('source-binding-unavailable', rawRef);
  if (
    evidence.blocks.filter((block) => block.id === sourceId).length !== 1 ||
    preview.layout.pages.filter(
      (item) => item.sourcePageIndex === context.pageIndex,
    ).length !== 1
  )
    return fallback('source-evidence-conflict', rawRef);
  const block = evidence.blocks[eb];
  if (
    preview.layout.coordinateSpace !==
      'normalized-displayed-crop-box-top-left' ||
    evidence.parsedPageIndex !== context.parsedPageIndex ||
    evidence.rotation !== page.rotation ||
    Math.abs(evidence.width - page.displayWidth) > 0.02 ||
    Math.abs(evidence.height - page.displayHeight) > 0.02 ||
    evidence.cropBox.length !== 4 ||
    evidence.cropBox.some(
      (v, i) => Math.abs(v - page.displayCropBox[i]) > 0.02,
    ) ||
    page.cropBox.some((v, i) => v !== page.displayCropBox[i])
  )
    return fallback('source-coordinate-uncalibrated', rawRef);
  const box = block.bbox;
  if (
    block.ambiguousCharacterRanges?.length ||
    box.length !== 4 ||
    box.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
    box[0] >= box[2] ||
    box[1] >= box[3]
  )
    return fallback('source-evidence-conflict', rawRef);
  return {
    ref: {
      pageIndex: context.pageIndex,
      precision: 'bbox',
      bbox: box as [number, number, number, number],
    },
    lineage: {
      precision: 'bbox',
      sourceId,
      ...(rawRef ? { rawRef } : {}),
      evidencePointer: `#/pages/${ep}/blocks/${eb}`,
    },
  };
}
