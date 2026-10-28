import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { readerDescriptorSchema, type PdfSourceRef, type ReaderDescriptor, type ReadingPosition } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { ReaderStatus } from '../library/import-status';
import { PdfSource } from '../library/pdf-source';
import { ReaderContent, type ContentMode } from './reader-content';
import { ReaderLayout, type ReaderView } from './reader-layout';
import { ReaderToc } from './reader-toc';
import { SourceLocator } from './source-locator';
import type { ContentPosition, ContentTarget, InteractionOrigin } from './window-state';
import { useReadingProgress } from './use-reading-progress';
import { pageChunkIndex, resolvePosition } from './resolve-position';
import { VersionSelect } from './version-select';
import './reader.css';
export interface ReaderPageProps {
  documentId: string; versionId?: string;
  onVersionSelect?: (versionId?: string) => void;
  onPositionChange?: (position: ReadingPosition, origin: InteractionOrigin) => void;
  /** Task 11 can supply a controlled restore without inventing user interaction. */
  restorePosition?: ReadingPosition;
}
export function ReaderPage({ documentId, versionId, onPositionChange, restorePosition, onVersionSelect }: ReaderPageProps) {
  const { user, epoch } = useSession();
  const query = useQuery({ queryKey: [user!.id, 'reader', documentId, versionId, epoch],
    queryFn: async ({ signal }) => readerDescriptorSchema.parse(await apiRequest(`/api/v1/documents/${documentId}/reader${versionId ? `?versionId=${versionId}` : ''}`, { signal })), staleTime: Infinity, gcTime: 0 });
  if (!query.data) return <><Feedback message={query.error ? errorMessage(query.error) : ''} error />{query.error ? <Button onClick={() => void query.refetch()}>重试阅读器</Button> : <p role="status">正在加载阅读器…</p>}</>;
  return <ReaderSession key={`${user!.id}/${epoch}/${query.data.versionId}`} descriptor={query.data} onPositionChange={onPositionChange} restorePosition={restorePosition} onVersionSelect={onVersionSelect} />;
}
function ReaderSession({ descriptor, onPositionChange, restorePosition, onVersionSelect }: { descriptor: ReaderDescriptor } & Pick<ReaderPageProps, 'onPositionChange' | 'restorePosition' | 'onVersionSelect'>) {
  const [, setSearch] = useSearchParams();
  const progress = useReadingProgress({ documentId: descriptor.documentId, descriptor });
  const [initialRestore] = useState(() => {
    if (restorePosition) return restorePosition;
    if (!descriptor.progress) return undefined;
    const resolved = resolvePosition(descriptor.index, descriptor.progress);
    return { ...descriptor.progress.position, ...resolved };
  });
  const effectiveRestore = restorePosition ?? initialRestore;
  const [view, setView] = useState<ReaderView>(() => window.innerWidth < 768 ? 'content' : 'split');
  const [mode, setMode] = useState<ContentMode>('translation'); const [large, setLarge] = useState(false);
  const [pageIndex, setPageIndex] = useState(0); const [highlight, setHighlight] = useState<PdfSourceRef>();
  const [references, setReferences] = useState<readonly PdfSourceRef[]>([]);
  const [contentPosition, setContentPosition] = useState<ContentPosition>({ blockId: null, blockOffset: 0 });
  const [target, setTarget] = useState<ContentTarget>();
  const emit = (origin: InteractionOrigin, patch: Partial<ReadingPosition> = {}) => { const position: ReadingPosition = { readerVersionId: descriptor.versionId, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, ...contentPosition, pdfPageIndex: pageIndex, view, contentMode: mode, ...patch }; progress.change(position, origin); onPositionChange?.(position, origin); };
  // Restore is explicit and identity bound; passive descriptor refetches cannot re-scroll.
  const [appliedRestore, setAppliedRestore] = useState<ReadingPosition>();
  if (effectiveRestore && effectiveRestore !== appliedRestore && effectiveRestore.readerVersionId === descriptor.versionId && effectiveRestore.parseId === descriptor.parseId && effectiveRestore.sourceVersionId === descriptor.source.sourceVersionId) {
    setAppliedRestore(effectiveRestore); setView(effectiveRestore.view); setMode(effectiveRestore.contentMode); setContentPosition({ blockId: effectiveRestore.blockId, blockOffset: effectiveRestore.blockOffset }); setPageIndex(Math.max(0, Math.min(descriptor.pages.length - 1, effectiveRestore.pdfPageIndex)));
    setTarget({ ...effectiveRestore, sequence: Date.now(), origin: 'restore', chunkIndex: effectiveRestore.blockId ? undefined : pageChunkIndex(descriptor.index, effectiveRestore.pdfPageIndex) });
  }
  return <section className="native-reader" aria-label="阅读器">
    <div className="reader-heading">
      <ReaderStatus reader={descriptor} />
      <div className="reader-controls">
        <label>阅读视图 <select aria-label="阅读视图" value={view} onChange={event => { const next = event.target.value as ReaderView; setView(next); emit('user', { view: next }); }}><option value="split">双屏阅读</option><option value="source">PDF 原件</option><option value="content">只看正文</option></select></label>
        <label>正文语言 <select aria-label="正文语言" value={mode} onChange={event => { const next = event.target.value as ContentMode; setMode(next); emit('user', { contentMode: next }); }}><option value="translation">译文</option><option value="source">结构化原文</option></select></label>
      </div>
      <details className="reader-settings" open={window.innerWidth >= 768 || undefined}><summary>阅读版本与字号</summary><div className="reader-controls">
        <VersionSelect descriptor={descriptor} onSelect={onVersionSelect ?? (id => setSearch(id ? { versionId: id } : {}))} />
        <label>字号 <select aria-label="正文字号" value={large ? 'large' : 'normal'} onChange={event => setLarge(event.target.value === 'large')}><option value="normal">标准 18</option><option value="large">大字 20</option></select></label>
      </div></details>
      {descriptor.restoreHint && <p role="status">版本已更新，已定位到原页。旧版本的阅读位置仍保留，可通过阅读版本回看。</p>}
      {progress.status === 'conflict' && <div role="alert">其他设备已保存新的阅读位置，自动保存已暂停。<Button onClick={() => void progress.continueHere()}>从当前位置继续</Button></div>}
      {progress.status === 'error' && <div role="alert">阅读位置保存失败，自动保存已暂停。<Button onClick={() => void progress.continueHere()}>重试保存当前位置</Button></div>}
      {progress.status === 'saving' && <span role="status" className="reader-message">正在保存阅读位置…</span>}
      {progress.status === 'saved' && <span role="status" className="reader-message">阅读位置已保存</span>}
      <ReaderToc index={descriptor.index} onSelect={id => { if (view === 'source') setView('content'); setTarget({ blockId: id, blockOffset: 0, sequence: Date.now(), origin: 'user' }); }} />
      {!!references.length && <SourceLocator references={references} onClose={() => setReferences([])} onSelect={reference => { setPageIndex(reference.pageIndex); setHighlight(reference); setView(window.innerWidth < 768 ? 'source' : 'split'); setReferences([]); emit('user', { pdfPageIndex: reference.pageIndex, view: window.innerWidth < 768 ? 'source' : 'split' }); }} />}
    </div>
    <ReaderLayout view={view} source={<PdfSource sourceUrl={`/api/v1/assets/${descriptor.source.assetId}/content`} title="PDF" onInteraction={origin => emit(origin)} pageIndex={pageIndex} onPageChange={(next, origin) => { setPageIndex(next); setHighlight(undefined); emit(origin, { pdfPageIndex: next }); }} highlight={highlight} pageMetadata={descriptor.pages[pageIndex]} pageCount={descriptor.pages.length} />}
      content={<ReaderContent descriptor={descriptor} mode={mode} large={large} visible={view !== 'source'} target={target} onLocate={setReferences} onPositionChange={(position, origin) => { setContentPosition(position); emit(origin, position); }} />} />
  </section>;
}
