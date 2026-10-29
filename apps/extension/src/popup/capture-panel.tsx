import type { SaveOrganization } from '@pagelingo/document-contracts';
import { sourceLinkKind } from '../archive/source-link';
import { CaptureOptions } from './capture-options';
import { useEffect, useState } from 'react';
import { archiveCommand, useArchiveStatus, type ArchiveSummary } from '../archive/ui';
const labels: Record<ArchiveSummary['state'], string> = { permission: '等待资源授权', pending: '正在保存…', retry: '等待重试', manual: '需要手动重试', completed: '已确认保存', cancelled: '已取消' };
function savedLabel(item: ArchiveSummary) {
  return item.saveStatus === 'original-saved' ? '原文已保存' : item.saveStatus === 'partial-resources' ? '原文已保存，部分资源缺失' : item.saveStatus === 'link-only' ? '链接已保存' : labels[item.state];
}
export function CapturePanel({ tabId }: { tabId?: number }) {
  const { status, error: readError, epoch } = useArchiveStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [selection, setSelection] = useState<{ generation: string; value: SaveOrganization } | null>(null);
  const organization = selection && selection.generation === status.binding?.generation
    ? selection.value : { collectionId: null, tagIds: [] };
  useEffect(() => {
    setSelection(null);
    setError('');
    setBusy(false);
    setShowAll(false);
  }, [status.binding?.ownerId, status.binding?.generation]);
  const [sourceKind, setSourceKind] = useState<'github' | 'arxiv' | null>(null);
  useEffect(() => {
    let disposed = false;
    setSourceKind(null);
    if (tabId !== undefined) void chrome.tabs.get(tabId).then(tab => {
      if (!disposed) setSourceKind(sourceLinkKind(tab.url ?? ''));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [tabId]);
  function run(command: unknown, permission?: Promise<boolean>) {
    const version = epoch.current;
    setBusy(true);
    setError('');
    void (async () => {
      if (permission && !await permission) throw new Error('资源访问未获授权；可选择不授权继续保存。');
      if (version !== epoch.current) return;
      await archiveCommand(command);
    })().catch(error => {
      if (version === epoch.current) setError(error instanceof Error ? error.message : '保存失败。');
    }).finally(() => {
      if (version === epoch.current) setBusy(false);
    });
  }
  return <section className="card capture-panel" aria-label="保存资料">
    <h2>保存到资料站点</h2>
    {status.binding ? <>
      <p className="hint archive-origin">{status.username} · {status.binding.siteOrigin}</p>
      <CaptureOptions key={status.binding.generation} binding={status.binding} value={organization} onChange={value => setSelection({ generation: status.binding!.generation, value })} />
      <button className="primary full" disabled={busy || tabId === undefined} onClick={() => run({ type: 'archive:capture', tabId, expectedBinding: status.binding, ...(organization.collectionId || organization.tagIds.length ? { organization } : {}) })}>{sourceKind === 'github' ? '保存仓库固定 README' : sourceKind === 'arxiv' ? '保存论文固定版本' : '保存当前页面原文'}</button>
      <p className="hint">
        {sourceKind === 'github'
          ? '由站点保存固定 README。自动翻译遵循站点偏好，使用模型配置时可能产生费用。'
          : sourceKind === 'arxiv' ? '由站点保存固定论文版本，不启动 PDF 解析或翻译。'
            : '保存原文不调用模型，可复用已验证的现有译文。'}
        关闭面板后继续上传。站点确认后清理本地载荷；取消仍保留，可移除本地记录。
      </p>
      {status.items.slice(0, showAll ? undefined : 10).map(item => <article key={item.id} className="archive-item">
        <strong>{item.title}</strong><p role="status">{savedLabel(item)}</p>
        {item.completeWithinScope !== null && <p className="hint">{item.completeWithinScope ? '所选正文范围完整' : '所选正文范围不完整'}</p>}
        {item.state === 'permission' && <>
          <p className="hint">以下资源主机需要授权。请保持来源页面打开；未获取的资源会明确标记缺失。</p>
          <ul>{item.permissionOrigins.map(origin => <li key={origin} className="archive-origin">{origin.replace(/\/\*$/, '')}</li>)}</ul>
          <button disabled={busy} onClick={() => run({ type: 'archive:retry', id: item.id }, chrome.permissions.request({ origins: item.permissionOrigins }))}>授权资源并保存</button>
          <button disabled={busy} onClick={() => run({ type: 'archive:retry', id: item.id })}>不授权，继续保存</button>
        </>}
        {['retry','manual'].includes(item.state) && <button disabled={busy} onClick={() => run({ type: 'archive:retry', id: item.id })}>重试保存</button>}
        {!['completed','cancelled'].includes(item.state) && <button disabled={busy} onClick={() => run({ type: 'archive:cancel', id: item.id })}>取消保存</button>}
        {['completed','cancelled','manual'].includes(item.state) && <button disabled={busy} onClick={() => run({ type: 'archive:remove-local', id: item.id })}>移除本地记录</button>}
        {item.error && <p className="error">{item.error.includes('DOCUMENT_IN_TRASH') ? <>资料已在回收站，请先恢复。<a href={`${status.binding!.siteOrigin}/trash`} target="_blank" rel="noreferrer">前往回收站恢复</a></> : item.error}</p>}
        {item.warnings.length > 0 && <details><summary>保存说明（{item.warnings.length}）</summary><ul>{item.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      </article>)}
      {status.items.length > 10 && <button onClick={() => setShowAll(!showAll)}>{showAll ? '收起历史记录' : '显示最近 50 条记录（更早记录仍保留）'}</button>}
    </> : <><p className="hint">先在设置中连接你的资料站点。</p><button onClick={() => { void chrome.runtime.openOptionsPage(); }}>连接站点 ↗</button></>}
    {(error || readError) && <p role="alert" className="error">{error || readError}</p>}
  </section>;
}
