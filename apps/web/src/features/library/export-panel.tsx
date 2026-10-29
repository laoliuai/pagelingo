import './export-panel.css';
import { useEffect, useRef, useState } from 'react';
import { webExportSchema, type WebExport } from '@pagelingo/document-contracts';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
/** Mounted in the owner/auth/document scope, outside the replaceable Reader body. */
export function ExportPanel({ documentId,readerVersionId }: { documentId: string; readerVersionId: string }) {
  const [receipt,setReceipt] = useState<WebExport>();
  const [pending,setPending] = useState<{ key: string; body: { readerVersionId: string } }>();
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [pollRound,setPollRound] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { const scope = new AbortController(); controller.current = scope; return () => scope.abort(); },[]);
  const base = `/api/v1/documents/${documentId}/web-exports`;
  async function submit(action: { key: string; body: { readerVersionId: string } } = { key: crypto.randomUUID(),body: { readerVersionId } }) {
    const signal = controller.current!.signal;
    setPending(action); setBusy(true); setError('');
    try {
      const result = webExportSchema.parse(await apiRequest(base,{ method: 'POST',body: action.body,idempotencyKey: action.key,signal }));
      if (signal.aborted) return;
      setReceipt(result); setPending(undefined); setPollRound(0);
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (!receipt || !['queued','running'].includes(receipt.status) || pollRound >= 80) return;
    const scope = new AbortController();
    const timer = setTimeout(() => {
      void apiRequest(`${base}/${receipt.id}`,{ signal: scope.signal }).then(value => {
        setReceipt(webExportSchema.parse(value)); setError('');
      }).catch(reason => { if (!scope.signal.aborted) setError(errorMessage(reason)); }).finally(() => { if (!scope.signal.aborted) setPollRound(round => round + 1); });
    },1500);
    return () => { clearTimeout(timer); scope.abort(); };
  },[base,receipt,pollRound]);
  const labels = { queued: '正在排队',running: '正在生成',completed: '离线包已生成，24 小时内可下载',failed: '导出失败，原资料仍保留',cancelled: '导出已取消',expired: '离线包已过期，请生成新包' };
  return <details className="export-panel"><summary>离线下载</summary>
    <p>导出当前选择的阅读版本，保留归档原件与已有译文。</p>
    <Button disabled={busy || !!pending || !!receipt && ['queued','running'].includes(receipt.status)} onClick={() => void submit()}>生成新的离线包</Button>
    {pending && <><p>上次提交尚未确认；重试会使用原先选择的版本。</p><Button disabled={busy} onClick={() => void submit(pending)}>重试本次导出</Button></>}
    {receipt && <p role="status">{labels[receipt.status]}{receipt.readerVersionId !== readerVersionId ? '（另一个已选择的历史版本）' : ''}</p>}
    {receipt?.errorCode === 'EXPORT_ORIGINALS_UNAVAILABLE' && <p role="alert">保留的原始材料或入站身份无法完整验证，暂不能生成完整离线包。已有阅读版本仍可使用。</p>}
    {receipt?.errorCode === 'BUNDLE_UNSUPPORTED_SOURCE' && <p role="alert">此来源使用尚不支持的历史投影配置，无法生成离线包。原件与阅读版本仍可使用。</p>}
    {receipt?.status === 'completed' && <a href={`${base}/${receipt.id}/file`} download>下载离线包</a>}
    {receipt && ['queued','running'].includes(receipt.status) && pollRound >= 80 && <Button onClick={() => setPollRound(0)}>继续查询导出状态</Button>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
