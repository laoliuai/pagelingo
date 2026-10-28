import { useEffect, useRef, useState } from 'react';
import type { SourceRefreshRequest } from '@pagelingo/document-contracts';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';

export function SourceRefresh({ documentId, kind, onAccepted }: {
  documentId: string; kind: 'github' | 'arxiv'; onAccepted: () => Promise<void>;
}) {
  const [ref, setRef] = useState('');
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState('');
  const admission = useRef<{ key: string; body: SourceRefreshRequest } | null>(null);
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  async function refresh() {
    if (busy) return;
    admission.current ??= { key: crypto.randomUUID(), body: {
      ...(ref.trim() ? { ref: ref.trim() } : {}), translationIntent: kind === 'arxiv' || skip ? 'none' : 'auto',
    } };
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/v1/documents/${documentId}/source-refresh`, {
        method: 'POST', body: admission.current.body, idempotencyKey: admission.current.key,
        signal: lifetime.current.signal,
      });
      admission.current = null;
      setUnknown(false);
      await onAccepted();
    } catch (error) {
      if (!lifetime.current.signal.aborted) {
        const rejected = error instanceof ApiError && error.status === 400 && error.code === 'INVALID_REQUEST';
        if (rejected) admission.current = null;
        setUnknown(!rejected);
        setError(rejected ? '版本引用无效，请核对后重新更新。' : `${errorMessage(error)} 本次更新尚未确认，请重试同一次操作。`);
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  return <div className="source-refresh">
    <Field label="来源版本引用">
      <Input value={ref} maxLength={200} disabled={busy || unknown} placeholder={kind === 'github' ? '默认分支，或填写 ref / commit' : '最新版本，或填写 2401.12345v2'} onChange={event => setRef(event.target.value)} />
    </Field>
    {kind === 'github' && <label className="checkbox"><input type="checkbox" checked={skip} disabled={busy || unknown} onChange={event => setSkip(event.target.checked)} />本次更新不自动翻译</label>}
    <p className="muted">仅点击更新才获取新版本。现有原文与已打开的阅读版本保留。{kind === 'arxiv' && '下载论文不启动 PDF 解析或翻译。'}</p>
    <Button disabled={busy} onClick={() => void refresh()}>{busy ? '正在提交更新…' : unknown ? '重试本次更新' : '获取新来源版本'}</Button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
