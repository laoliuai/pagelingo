import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createDocumentLinkRequestSchema, type DocumentLinkResult, type SaveOrganization } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Modal } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { Input } from '../../shared/ui/input';
import { Field } from '../../shared/ui/field';
import { OrganizationChoices } from './organization-choices';
export function LinkDialog() {
  const { user } = useSession();
  const cache = useQueryClient();
  const [organization, setOrganization] = useState<SaveOrganization>({collectionId:null,tagIds:[]});
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [skipTranslation, setSkipTranslation] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const key = useRef('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const close = () => {
    request.current?.abort();
    request.current = null;
    setOrganization({collectionId:null,tagIds:[]});
    setOpen(false);
    setUrl('');
    setTitle('');
    setSkipTranslation(false);
    setError('');
    setPending(false);
    key.current = '';
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const parsed = createDocumentLinkRequestSchema.safeParse({
      url,
      ...(organization.collectionId || organization.tagIds.length ? { organization } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      translationIntent: skipTranslation ? 'none' : 'auto',
    });
    if (!parsed.success) {
      setError('请输入不含账号密码的 HTTP 或 HTTPS 网页地址。');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    key.current ||= crypto.randomUUID();
    setPending(true);
    setError('');
    try {
      await apiRequest<DocumentLinkResult>('/api/v1/documents/links', {
        method: 'POST', body: parsed.data, idempotencyKey: key.current, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      await cache.invalidateQueries({ queryKey: [user!.id, 'documents'] });
      if (!controller.signal.aborted) close();
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (request.current === controller) setPending(false);
    }
  }
  return (
    <Modal
      title="添加链接"
      description="先保存链接。公开文章可在后台获取原文；仓库和论文页面保留为链接。"
      open={open}
      onOpenChange={value => value ? setOpen(true) : close()}
      trigger={<Button>添加链接</Button>}
    >
      <form onSubmit={submit}>
        <fieldset disabled={pending}>
          <Field label="网页地址">
            <Input required type="url" value={url} onChange={event => { setUrl(event.target.value); key.current = ''; }} />
          </Field>
          <Field label="链接标题">
            <Input maxLength={2000} value={title} onChange={event => { setTitle(event.target.value); key.current = ''; }} />
          </Field>
          <OrganizationChoices value={organization} onChange={value => { setOrganization(value); key.current = ''; }} />
          <label className="checkbox">
            <input type="checkbox" checked={skipTranslation} onChange={event => { setSkipTranslation(event.target.checked); key.current = ''; }} />
            本次不自动翻译
          </label>
          <p>默认遵循“自动翻译新保存的外文资料”偏好；开启后使用你的模型配置，可能产生费用。中文无需翻译，未配置 Key 时不启动模型任务，仍保存原文。</p>
          <p>勾选后仅跳过本次保存的自动翻译，不改变偏好或已接受的任务。</p>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <div className="form-actions">
          <Button type="button" onClick={close}>取消</Button>
          <Button primary type="submit" disabled={pending}>{pending ? '正在保存…' : '保存链接'}</Button>
        </div>
      </form>
    </Modal>
  );
}
