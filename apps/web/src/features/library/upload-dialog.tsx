import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentSummary } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest } from '../../shared/api-client';
import { Modal } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Feedback } from '../../shared/ui/toast';
export function UploadDialog() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const key = useRef('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function close() {
    request.current?.abort();
    request.current = null;
    setOpen(false);
    setFile(null);
    setTitle('');
    setError('');
    setPending(false);
    key.current = '';
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || pending) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    const body = new FormData();
    body.append('title', title.trim() || file.name);
    body.append('file', file);
    key.current ||= crypto.randomUUID();
    try {
      await apiRequest<DocumentSummary>('/api/v1/documents/pdf', {
        method: 'POST',
        body,
        signal: controller.signal,
        idempotencyKey: key.current,
      });
      if (request.current !== controller) return;
      await queryClient.invalidateQueries({ queryKey: [user!.id, 'documents'] });
      if (controller.signal.aborted || request.current !== controller) return;
      close();
    } catch (error) {
      if (controller.signal.aborted || request.current !== controller) return;
      setError(
        error instanceof ApiError && error.code === 'DOCUMENT_IN_TRASH'
          ? '资料已在回收站，请先恢复。'
          : error instanceof ApiError && error.code === 'INVALID_PDF'
          ? '请选择有效的 PDF 文件。'
          : error instanceof ApiError && error.status === 413
            ? '文件超出服务器大小限制，请选择较小的 PDF。'
            : '上传未确认，请重试。重试会保留本次上传标识。',
      );
    } finally {
      if (request.current === controller) setPending(false);
    }
  }
  return (
    <Modal
      title="上传 PDF"
      description="原件仅对当前账号可见。保存后可直接阅读 PDF，也可在资料详情导入本地生成的阅读包。"
      open={open}
      onOpenChange={(value) => (value ? setOpen(true) : close())}
      trigger={<Button primary>上传 PDF</Button>}
    >
      <form onSubmit={submit}>
        <fieldset disabled={pending}>
          <Field label="PDF 文件">
            <Input
              type="file"
              accept=".pdf,application/pdf"
              required
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                setFile(next);
                setTitle(next?.name ?? '');
                setError('');
                key.current = '';
              }}
            />
          </Field>
          <Field label="资料标题">
            <Input
              maxLength={500}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                key.current = '';
              }}
            />
          </Field>
        </fieldset>
        {pending && (
          <p role="status" className="muted">
            正在上传，等待服务器确认…
          </p>
        )}
        <Feedback message={error} error />
        {error === '资料已在回收站，请先恢复。' && <Link to="/trash">前往回收站恢复</Link>}
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消上传
          </Button>
          <Button primary type="submit" disabled={!file || pending}>
            {pending ? '正在上传…' : error ? '重试上传' : '保存原文'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
