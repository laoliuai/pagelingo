import { useEffect, useRef, useState } from 'react';
import { getDocument, PDFWorker, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import SourceWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type { PdfPageMetadata, PdfSourceRef } from '@pagelingo/document-contracts';
import { compatibleGeometry, SourceHighlight, type PdfGeometry } from '../reader/source-highlight';
import type { InteractionOrigin } from '../reader/window-state';
import { useSession } from '../../app/session';
import { Button } from '../../shared/ui/button';
import { isPdfSourceUrl } from './pdf-source-url';
import { Feedback } from '../../shared/ui/toast';

/** Only registered same-origin document or asset routes may select a source. */
export interface PdfSourceProps {
  sourceUrl: string; title: string; pageIndex?: number;
  onPageChange?: (pageIndex: number, origin: InteractionOrigin) => void;
  highlight?: PdfSourceRef; pageMetadata?: PdfPageMetadata; pageCount?: number;
  onInteraction?: (origin: InteractionOrigin) => void;
}
export function PdfSource({ sourceUrl, title, pageIndex: controlledPage, onPageChange, highlight, pageMetadata, pageCount, onInteraction }: PdfSourceProps) {
  const { clear } = useSession();
  const userUntil = useRef(0);
  const armScroll = () => { userUntil.current = performance.now() + 800; };
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [internalPage, setPageIndex] = useState(0);
  const pageIndex = controlledPage ?? internalPage;
  const changePage = (next: number) => { if (controlledPage === undefined) setPageIndex(next); onPageChange?.(next, 'user'); if (!onPageChange) onInteraction?.('user'); };
  const [scale, setScale] = useState(1);
  useEffect(() => { userUntil.current = 0; }, [pageIndex, scale]);
  useEffect(() => {
    const resetIntent = () => { userUntil.current = 0; };
    window.addEventListener('resize', resetIntent);
    return () => window.removeEventListener('resize', resetIntent);
  }, []);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [renderedFrame, setRenderedFrame] = useState<{
    document: PDFDocumentProxy;
    sourceUrl: string;
    pageIndex: number;
    scale: number;
    geometry: PdfGeometry;
  } | null>(null);
  const rendered =
    renderedFrame?.sourceUrl === sourceUrl &&
    renderedFrame?.document === document &&
    renderedFrame?.pageIndex === pageIndex &&
    renderedFrame?.scale === scale;
  const canvas = useRef<HTMLCanvasElement>(null);
  const safe = isPdfSourceUrl(sourceUrl);
  useEffect(() => {
    setDocument(null);
    setPageIndex(0);
    setError('');
    setRenderedFrame(null);
    if (!safe) {
      setError('原件地址无效。');
      return;
    }
    let disposed = false;
    const port = new SourceWorker();
    const worker = PDFWorker.create({ port });
    const parameters = {
      url: sourceUrl,
      worker,
      withCredentials: true,
      // Retain the explicit safe setting; PDF.js 6 no longer exposes evaluation.
      isEvalSupported: false,
      cMapUrl: '/assets/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/assets/pdfjs/standard_fonts/',
      wasmUrl: '/assets/pdfjs/wasm/',
      // Keep range requests single and bounded; do not prefetch unseen pages.
      rangeChunkSize: 64 * 1024,
      disableStream: true,
      disableAutoFetch: true,
    };
    const loadingTask = getDocument(parameters);
    void loadingTask.promise
      .then((pdf) => {
        if (!disposed) setDocument(pdf);
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        if (reason && typeof reason === 'object' && 'status' in reason && reason.status === 401)
          clear();
        else setError('原件加载失败。可下载原件，或重试加载。');
      });
    return () => {
      disposed = true;
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      // PDFWorker does not terminate a port supplied by its caller.
      void loadingTask
        .destroy()
        .catch(() => {})
        .finally(() => {
          worker.destroy();
          port.terminate();
        });
    };
  }, [sourceUrl, attempt, safe, clear]);
  useEffect(() => {
    const target = canvas.current;
    if (!document || !target || error) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    setRenderedFrame(null);
    void document
      .getPage(pageIndex + 1)
      .then((page) => {
        if (disposed) return;
        const viewport = page.getViewport({ scale });
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        renderTask = page.render({ canvas: target, viewport });
        return renderTask.promise.then(() => {
          if (!disposed) setRenderedFrame({ document, sourceUrl, pageIndex, scale, geometry: { pageIndex, pageCount: document.numPages, view: [...page.view], rotation: page.rotate, width: viewport.width, height: viewport.height, transform: [...viewport.transform], scale } });
        });
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        if (reason && typeof reason === 'object' && 'status' in reason && reason.status === 401)
          clear();
        else setError('原件加载失败。可下载原件，或重试加载。');
      });
    return () => {
      disposed = true;
      renderTask?.cancel();
      target.width = 0;
      target.height = 0;
    };
  }, [document, pageIndex, scale, clear, error]);
  return (
    <section className="pdf-source" aria-label={`${title} 原件`}>
      <div className="pdf-toolbar">
        <div className="pdf-paging">
          <Button
            aria-label="上一页"
            disabled={!document || pageIndex === 0 || !!error}
            onClick={() => changePage(pageIndex - 1)}
          >
            上一页
          </Button>
          <span className="mono">
            {document ? `第 ${pageIndex + 1} / ${document.numPages} 页` : 'PDF 原件'}
          </span>
          <Button
            aria-label="下一页"
            disabled={!document || pageIndex >= document.numPages - 1 || !!error}
            onClick={() => changePage(pageIndex + 1)}
          >
            下一页
          </Button>
        </div>
        <div className="pdf-tools">
          <label>
            缩放
            <select
              aria-label="缩放"
              value={scale}
              onChange={(event) => { setScale(Number(event.target.value)); onInteraction?.('user'); }}
              disabled={!document || !!error}
            >
              <option value="0.75">75%</option>
              <option value="1">100%</option>
              <option value="1.25">125%</option>
              <option value="1.5">150%</option>
              <option value="2">200%</option>
            </select>
          </label>
          {safe && (
            <a className="button" href={`${sourceUrl}?download=true`}>
              下载原件
            </a>
          )}
        </div>
      </div>
      <Feedback message={error} error />
      {error ? (
        <div className="pdf-error">
          <Button onClick={() => setAttempt((value) => value + 1)}>重试加载</Button>
        </div>
      ) : (
        <>
          {!rendered && (
            <p role="status" className="pdf-loading">
              正在加载原件…
            </p>
          )}
          {rendered && highlight?.pageIndex === pageIndex && <p className="pdf-location-status" role="status">{highlight.precision === 'page' ? '仅定位到原页；此段没有可信区域坐标。' : !compatibleGeometry(renderedFrame!.geometry, pageMetadata, pageCount) ? '页面几何信息不匹配，已仅定位到原页。' : '已定位到原页区域。'}</p>}
          <div className="pdf-scroll" tabIndex={0} aria-label="PDF 页面，可横向滚动"
            onWheel={armScroll} onTouchMove={armScroll}
            onPointerDown={event => { if (event.target === event.currentTarget) armScroll(); }}
            onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) armScroll(); }}
            onScroll={() => { if (performance.now() < userUntil.current) onInteraction?.('user'); }}>
            <div className="pdf-frame" style={{ position: 'relative', width: 'max-content', margin: '0 auto' }}>
            <canvas
              ref={canvas}
              role="img"
              aria-label={`PDF 第 ${pageIndex + 1} 页`}
              data-rendered={rendered}
            />
            {rendered && renderedFrame && <SourceHighlight reference={highlight} geometry={renderedFrame.geometry} metadata={pageMetadata} pageCount={pageCount} />}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
