import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createDocumentLinkRequestSchema, type CreateDocumentLinkRequest, type DocumentLinkResult, type SaveOrganization } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { Modal } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { Input } from '../../shared/ui/input';
import { Field } from '../../shared/ui/field';
import { OrganizationChoices } from './organization-choices';
interface LinkDialogProps { discoveredFromDocumentId?: string; initialUrl?: string; initialTitle?: string; triggerLabel?: string; openRequest?: number; onDismiss?: (retained: boolean) => void }
export function LinkDialog(props: LinkDialogProps) {
  const { user, epoch } = useSession();
  return <LinkDialogScope key={`${user!.id}:${epoch}:${props.discoveredFromDocumentId ?? ''}:${props.initialUrl ?? ''}`} {...props} />;
}
function LinkDialogScope({ discoveredFromDocumentId, initialUrl = '', initialTitle = '', triggerLabel, openRequest, onDismiss }: LinkDialogProps) {
  const { user, epoch } = useSession();
  const cache = useQueryClient();
  const [organization, setOrganization] = useState<SaveOrganization>({ collectionId: null, tagIds: [] });
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle);
  const [skipTranslation, setSkipTranslation] = useState(false);
  const [error, setError] = useState('');
  const [inTrash, setInTrash] = useState(false);
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [saved, setSaved] = useState<DocumentLinkResult | null>(null);
  const admission = useRef<{ key: string; body: CreateDocumentLinkRequest } | null>(null);
  const admittedResult = useRef<DocumentLinkResult | null>(null);
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => {
    if (openRequest === undefined) return;
    if (!admission.current) setSaved(null);
    openRef.current = true;
    setOpen(true);
  }, [openRequest]);
  function close() {
    openRef.current = false;
    setOpen(false);
    const retained = pending || admission.current !== null;
    onDismiss?.(retained);
    if (retained) return;
    setOrganization({ collectionId: null, tagIds: [] });
    setUrl(initialUrl); setTitle(initialTitle); setSkipTranslation(false); setError(''); setSaved(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || saved) return;
    const parsed = createDocumentLinkRequestSchema.safeParse({
      url,
      ...(organization.collectionId || organization.tagIds.length ? { organization } : {}),
      ...(discoveredFromDocumentId ? { discoveredFromDocumentId } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      translationIntent: skipTranslation ? 'none' : 'auto',
    });
    if (!parsed.success) { setError('请输入不含账号密码的 HTTP 或 HTTPS 网页地址。'); return; }
    admission.current ??= { key: crypto.randomUUID(), body: structuredClone(parsed.data) };
    setPending(true); setError(''); setInTrash(false);
    try {
      const result = admittedResult.current ?? await apiRequest<DocumentLinkResult>('/api/v1/documents/links', {
        method: 'POST', body: admission.current.body, idempotencyKey: admission.current.key, signal: lifetime.current.signal,
      });
      admittedResult.current = result;
      if (discoveredFromDocumentId && result.documentId !== discoveredFromDocumentId) {
        await apiRequest('/api/v1/document-relations', {
          method: 'POST', signal: lifetime.current.signal,
          body: { fromDocumentId: result.documentId, toDocumentId: discoveredFromDocumentId, kind: 'discovered-from' },
        });
      }
      admission.current = null;
      admittedResult.current = null;
      setUnknown(false);
      await cache.invalidateQueries({ queryKey: [user!.id, 'documents'] });
      if (lifetime.current.signal.aborted) return;
      setSaved(result);
      if (discoveredFromDocumentId) {
        await cache.invalidateQueries({ queryKey: [user!.id, 'relations', discoveredFromDocumentId, epoch] });
        if (!openRef.current) onDismiss?.(false);
      } else {
        setOpen(false); setUrl(''); setTitle(''); setOrganization({ collectionId: null, tagIds: [] }); setSkipTranslation(false);
      }
    } catch (error) {
      if (!lifetime.current.signal.aborted) {
        const rejected = !admittedResult.current && error instanceof ApiError && (
          (error.status === 400 && error.code === 'INVALID_REQUEST') ||
          (error.status === 404 && error.code === 'NOT_FOUND') ||
          (error.status === 409 && error.code === 'DOCUMENT_IN_TRASH')
        );
        const trashed = rejected && error instanceof ApiError && error.code === 'DOCUMENT_IN_TRASH';
        setInTrash(trashed);
        if (rejected) admission.current = null;
        setUnknown(!rejected);
        setError(trashed ? '资料已在回收站，请先恢复。' : rejected ? '服务器未接受本次链接，请核对地址和分类后重试。' : `${errorMessage(error)} 保存尚未确认，重试保留本次链接与分类。`);
      }
    } finally { if (!lifetime.current.signal.aborted) setPending(false); }
  }
  return <><Modal title={discoveredFromDocumentId ? '收藏发现的链接' : '添加链接'}
    description="保存你选择的公开链接。仓库固定 README commit，论文固定版本；外链由你逐条选择，不自动收集。"
    open={open} onOpenChange={value => {
      if (value) { if (!admission.current) setSaved(null); openRef.current = true; setOpen(true); }
      else close();
    }}
    trigger={<Button>{triggerLabel ?? (discoveredFromDocumentId ? '收藏发现的链接' : '添加链接')}</Button>}>
    <form onSubmit={submit}>
      <fieldset disabled={pending || unknown || !!saved}>
        <Field label="网页地址"><Input required type="url" value={url} onChange={event => setUrl(event.target.value)} /></Field>
        <Field label="链接标题"><Input maxLength={2000} value={title} onChange={event => setTitle(event.target.value)} /></Field>
        <OrganizationChoices value={organization} onChange={setOrganization} />
        <label className="checkbox"><input type="checkbox" checked={skipTranslation} onChange={event => setSkipTranslation(event.target.checked)} />本次不自动翻译</label>
        <p>默认遵循自动翻译偏好，可能使用你的模型配置产生费用。论文下载不启动 PDF 推理。分类仅用于新资料，已有资料保留原分类。</p>
      </fieldset>
      {error && <p role="alert">{error}{inTrash && <> <Link to="/trash">前往回收站恢复</Link></>}</p>}
      {saved && <p role="status">所选资料已保存，已有资料保留原有组织。<Link to={`/library/${saved.documentId}`}>查看已保存资料</Link></p>}
      <div className="form-actions"><Button type="button" onClick={close}>关闭</Button>{!saved && <Button primary type="submit" disabled={pending}>{pending ? '正在保存…' : unknown ? '重试本次保存' : '保存链接'}</Button>}</div>
    </form>
  </Modal>
    {!discoveredFromDocumentId && saved && !open && <p role="status">
      链接已保存，已有资料保留原有组织。<Link to={`/library/${saved.documentId}`}>查看已保存资料</Link>
    </p>}
  </>;
}
