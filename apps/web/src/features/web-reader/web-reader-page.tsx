import { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { webReaderDescriptorSchema, webCaptureManifestSchema, type WebSourceRef, type WebDocumentSummary, type WebReaderDescriptor, type WebReadingPosition, type WebReaderVersionList } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { WebReaderContent } from './web-reader-content';
import { useWebReadingProgress } from './use-web-reading-progress';
import { resolveWebPosition } from './resolve-web-position';
import type { ContentTarget, InteractionOrigin } from '../reader/window-state';
import '../reader/reader.css';
import './web-reader.css';
import { ReaderToc } from '../reader/reader-toc';
import { translationLabel } from '../library/import-status';
import { WebJobStatus } from './web-job-status';
import { SnapshotPreview } from './snapshot-preview';
export function WebReaderPage({ document, versionId }: { document: WebDocumentSummary; versionId?: string }) {
  const { user, epoch } = useSession();
  const [initialVersion] = useState(versionId ?? document.reader?.versionId);
  versionId ??= initialVersion;
  const query = useQuery({ queryKey: [user!.id, 'web-reader', document.id, versionId, epoch], queryFn: async ({ signal }) => webReaderDescriptorSchema.parse(await apiRequest(`/api/v1/documents/${document.id}/web-reader${versionId ? `?versionId=${versionId}` : ''}`, { signal })), staleTime: Infinity, gcTime: 0 });
  if (!query.data) return <><p role={query.error ? 'alert' : 'status'}>{query.error ? errorMessage(query.error) : '正在加载归档正文…'}</p>{query.error && <Button onClick={() => void query.refetch()}>重试阅读器</Button>}</>;
  return <WebReaderSession key={`${user!.id}/${epoch}/${query.data.versionId}`} descriptor={query.data} />;
}
function WebReaderSession({ descriptor }: { descriptor: WebReaderDescriptor }) {
  const { user } = useSession(); const [, setSearch] = useSearchParams();
  const progress = useWebReadingProgress(descriptor);
  const manifest = useQuery({ queryKey: [user!.id, 'web-manifest', descriptor.source.sourceVersionId], queryFn: async ({ signal }) => webCaptureManifestSchema.parse(await apiRequest(`/api/v1/documents/${descriptor.documentId}/web-snapshots/${descriptor.source.sourceVersionId}/manifest`, { signal })), staleTime: Infinity, gcTime: 0 });
  const [reference, setReference] = useState<WebSourceRef | undefined>(() => { const saved = resolveWebPosition(descriptor, descriptor.progress); const location = saved.blockId && descriptor.index.blockLocations[saved.blockId]; return saved.view === 'snapshot' && location ? { nodeId: location.nodeId, quote: '', prefix: '', suffix: '' } : undefined; });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [published, setPublished] = useState<string>();
  const onPublished = useCallback((id: string) => setPublished(id), []);
  const [position, setPosition] = useState(() => resolveWebPosition(descriptor, descriptor.progress));
  const [target, setTarget] = useState<ContentTarget>(() => ({ ...position, sequence: 0, origin: 'restore' }));
  const [versionPage, setVersionPage] = useState(1);
  const versions = useQuery({ queryKey: [user!.id, 'web-versions', descriptor.documentId, versionPage], queryFn: ({ signal }) => apiRequest<WebReaderVersionList>(`/api/v1/documents/${descriptor.documentId}/web-reader/versions?pageSize=20&page=${versionPage}`, { signal }) });
  const latest = published ?? (versionPage === 1 ? versions.data?.items[0]?.id : undefined);
  const change = (patch: Partial<WebReadingPosition>, origin: InteractionOrigin) => { const next = { ...position, ...patch }; setPosition(next); progress.change(next, origin); };
  return <section className="native-reader web-reader" aria-label="网页阅读器" data-version-id={descriptor.versionId} data-translation-status={descriptor.translationStatus}>
    <div className="reader-heading">
      <p className="reader-status">源语言：{descriptor.index.language.language === 'zh' ? '中文' : descriptor.index.language.language === 'en' ? '英语' : descriptor.index.language.sourceLanguage ?? '未确定'} · {translationLabel(descriptor.translationStatus)}{descriptor.index.generationKind === 'mock' ? ' · 模拟译文，仅供流程验证' : descriptor.index.generationKind === 'import' ? ' · 已导入译文' : ''}</p>
      <div className="reader-controls"><label>正文模式 <select aria-label="正文模式" value={position.contentMode} onChange={event => change({ contentMode: event.target.value as WebReadingPosition['contentMode'] }, 'user')}><option value="source">原文</option><option value="translation">译文</option><option value="bilingual">段落双语</option></select></label></div>
      <details className="reader-settings"><summary>来源信息</summary>{manifest.data && <p>{manifest.data.metadata.author ?? '作者未标注'} · 发布：{manifest.data.metadata.publishedAt ?? '未标注'} · 采集：{manifest.data.metadata.capturedAt} · 范围：{manifest.data.scope.kind} / {manifest.data.scope.completeWithinScope ? '范围内完整' : '范围内不完整'} <a href={`/api/v1/documents/${descriptor.documentId}/web-snapshots/${descriptor.source.sourceVersionId}/files/${encodeURIComponent(manifest.data.htmlFileId)}`} download>下载归档原件</a></p>}</details>
      <details className="reader-settings"><summary>版本与目录</summary><label>阅读版本 <select aria-label="阅读版本" value={descriptor.versionId} onChange={event => setSearch({ versionId: event.target.value })}>{!versions.data?.items.some(version => version.id === descriptor.versionId) && <option value={descriptor.versionId}>当前打开版本 · {translationLabel(descriptor.translationStatus)}</option>}{versions.data?.items.map(version => <option key={version.id} value={version.id}>{version.createdAt.slice(0, 19)} · {translationLabel(version.translationStatus)}</option>)}</select></label><Button onClick={() => void versions.refetch()}>刷新版本</Button><Button disabled={versionPage === 1} onClick={() => setVersionPage(page => page - 1)}>上一组版本</Button><Button disabled={!versions.data || versionPage * 20 >= versions.data.total} onClick={() => setVersionPage(page => page + 1)}>下一组版本</Button><ReaderToc index={descriptor.index} onSelect={id => { setReference(undefined); change({ view: 'content' }, 'user'); setTarget({ blockId: id, blockOffset: 0, sequence: Date.now(), origin: 'user' }); }} /></details>
      <WebJobStatus documentId={descriptor.documentId} descriptor={descriptor} selection={[...selection]} selectionMode={selectionMode} onSelectionMode={setSelectionMode} onPublished={onPublished} />
      {latest && latest !== descriptor.versionId && <p role="status">已有其他可读版本；当前段落保持不变。<Button onClick={() => setSearch({ versionId: latest })}>切换到新版本</Button></p>}
      {!!descriptor.warnings.length && <details className="reader-warnings"><summary>归档警告（{descriptor.warnings.length}）</summary><ul>{descriptor.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      {descriptor.restoreHint && <p role="status">来源已更新，无法唯一定位旧段落，已回到起点。旧版本位置仍保留。</p>}
      {progress.status === 'conflict' && <div role="alert">其他设备已保存新的阅读位置，自动保存已暂停。<Button onClick={() => void progress.continueHere()}>从当前位置继续</Button></div>}
      {progress.status === 'error' && <div role="alert">阅读位置保存失败。<Button onClick={() => void progress.continueHere()}>重试保存当前位置</Button></div>}
    </div>
    {reference && <Button onClick={() => { setReference(undefined); setTarget({ ...position, sequence: Date.now(), origin: 'restore' }); change({ view: 'content' }, 'user'); }}>返回正文</Button>}
    <div className="web-reading-body">{reference ? manifest.data ? <SnapshotPreview descriptor={descriptor} manifest={manifest.data} reference={reference} /> : <div role={manifest.error ? 'alert' : 'status'}>{manifest.error ? '快照信息读取失败，原文仍可阅读。' : '正在读取快照信息…'}{manifest.error && <Button onClick={() => void manifest.refetch()}>重试快照信息</Button>}</div> : <WebReaderContent descriptor={descriptor} mode={position.contentMode} selection={selection} onSelection={selectionMode ? (id, selected) => setSelection(current => { const next = new Set(current); if (selected) next.add(id); else next.delete(id); return next; }) : undefined} target={target} onLocate={references => { setReference(references[0]); const blockId = Object.keys(descriptor.index.blockLocations).find(id => descriptor.index.blockLocations[id].nodeId === references[0]?.nodeId) ?? position.blockId; change({ view: 'snapshot', blockId, blockOffset: 0 }, 'user'); }} onPositionChange={(value, origin) => change(value, origin)} />}</div>
  </section>;
}
