import type { PdfPageMetadata, PdfSourceRef } from '@pagelingo/document-contracts';
export interface PdfGeometry { pageIndex: number; pageCount: number; view: readonly number[]; rotation: number; width: number; height: number; transform: readonly number[]; scale: number }
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.01;
export function compatibleGeometry(actual: PdfGeometry, metadata?: PdfPageMetadata, pageCount?: number): boolean {
  return !!metadata && actual.pageIndex === metadata.pageIndex && (pageCount === undefined || actual.pageCount === pageCount) &&
    actual.rotation === metadata.rotation && actual.view.length === 4 && actual.view.every((value, i) => close(value, metadata.displayCropBox[i])) &&
    close(actual.width / actual.scale, metadata.displayWidth) && close(actual.height / actual.scale, metadata.displayHeight) &&
    actual.transform.length === 6 && actual.transform.every((value, i) => close(value / actual.scale, metadata.pdfToDisplay[i]));
}
export function SourceHighlight({ reference, geometry, metadata, pageCount }: { reference?: PdfSourceRef; geometry: PdfGeometry; metadata?: PdfPageMetadata; pageCount?: number }) {
  if (!reference || reference.precision !== 'bbox' || reference.pageIndex !== geometry.pageIndex || !compatibleGeometry(geometry, metadata, pageCount)) return null;
  const [x0, y0, x1, y1] = reference.bbox;
  return <div className="source-highlight" aria-label="原页定位区域" style={{ position: 'absolute', pointerEvents: 'none', border: '2px solid var(--accent)', background: 'color-mix(in srgb, var(--accent) 18%, transparent)', left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }} />;
}
