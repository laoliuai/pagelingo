import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentOrganization, PatchDocumentOrganization, SaveOrganization } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, errorMessage } from '../../shared/api-client';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Button } from '../../shared/ui/button';
import { OrganizationChoices } from './organization-choices';
import { RelationsPanel } from './relations-panel';
export function OrganizationPanel({ documentId, children }: { documentId: string; children?: ReactNode }) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState('');
  const { user, epoch } = useSession();
  const query = useQuery({ queryKey: [user!.id, 'organization', documentId, epoch], enabled: open,
    queryFn: ({ signal }) => apiRequest<DocumentOrganization>(`/api/v1/documents/${documentId}/organization`, { signal }), staleTime: Infinity });
  return <details className="management-panel" onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setActivated(true); }}>
    <summary>管理资料</summary>
    {query.isPending && open && <p role="status">正在加载资料信息…</p>}
    {query.error && <p role="alert">{errorMessage(query.error)}<Button onClick={() => void query.refetch()}>重试资料信息</Button></p>}
    {notice && <p role="status">{notice}</p>}
    {conflict && <p role="alert">{conflict}</p>}
    {query.data && <OrganizationEditor
      key={`${documentId}:${epoch}:${query.data.revision}`}
      initial={query.data} notify={setNotice} conflict={setConflict}
      reload={async () => { await query.refetch(); }}
    />}
    {activated && children}
    {activated && <RelationsPanel documentId={documentId} />}
  </details>;
}
function OrganizationEditor({ initial, reload, notify, conflict }: { initial: DocumentOrganization; reload: () => Promise<void>; notify: (value:string)=>void; conflict: (value:string)=>void }) {
  const { user } = useSession(); const cache = useQueryClient(); const navigate = useNavigate();
  const [title, setTitle] = useState(initial.title), [note, setNote] = useState(initial.note), [status, setStatus] = useState(initial.readingStatus);
  const [choice, setChoice] = useState<SaveOrganization>({ collectionId: initial.collectionId, tagIds: initial.tagIds });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const patch: PatchDocumentOrganization = { expectedRevision: initial.revision,
    ...(title !== initial.title ? { title } : {}), ...(note !== initial.note ? { note } : {}), ...(status !== initial.readingStatus ? { readingStatus: status } : {}),
    ...(choice.collectionId !== initial.collectionId ? { collectionId: choice.collectionId } : {}),
    ...(JSON.stringify([...choice.tagIds].sort()) !== JSON.stringify([...initial.tagIds].sort()) ? { tagIds: choice.tagIds } : {}),
  };
  async function save() {
    setBusy(true); setError(''); conflict(''); notify('');
    try {
      await apiRequest(`/api/v1/documents/${initial.documentId}/organization`, { method: 'PATCH', body: patch });
      notify('资料信息已保存');
      await reload();
      await cache.invalidateQueries({ queryKey: [user!.id, 'documents'] });
      await cache.invalidateQueries({ queryKey: [user!.id, 'document', initial.documentId] });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reload();
        conflict('资料已被其他操作更新，已重新加载当前信息。请核对后重新编辑。');
      } else setError(errorMessage(error));
    } finally { setBusy(false); }
  }
  async function trash() {
    setBusy(true); setError('');
    try { await apiRequest(`/api/v1/documents/${initial.documentId}/trash`, { method: 'POST', body: { expectedEpoch: initial.lifecycleEpoch } }); await cache.cancelQueries({ queryKey: [user!.id] }); cache.removeQueries({ predicate: q => q.queryKey[0] === user!.id && q.queryKey.includes(initial.documentId) }); await cache.invalidateQueries({ queryKey: [user!.id, 'documents'] }); navigate('/library'); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return <form className="organization-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy}>
      <Field label="资料标题"><Input required value={title} onChange={event => setTitle(event.target.value)} /></Field>
      {title !== initial.title && title.length > 500 && <p role="alert">新标题请限制在 500 字以内。</p>}
      <Field label="收藏备注"><textarea maxLength={10000} rows={3} value={note} onChange={event => setNote(event.target.value)} /></Field>
      <Field label="阅读状态">
        <select value={status} onChange={event => setStatus(event.target.value as typeof status)}>
          <option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option>
        </select>
      </Field>
      <OrganizationChoices value={choice} onChange={setChoice} />
      <div className="form-actions">
        <Button primary disabled={Object.keys(patch).length === 1 || (title !== initial.title && title.length > 500)}>保存资料信息</Button>
        <Button type="button" onClick={() => void trash()}>移入回收站</Button>
      </div>
      <p className="muted">回收站保留 30 天，可恢复。阅读状态仅在这里手动更改。</p>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </form>;
}
