import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BundleImport, DocumentSummary, SaveOrganization } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { Modal } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Feedback } from '../../shared/ui/toast';
import { activeImport, ImportStatus, ReaderStatus } from './import-status';
import { useBundleImport } from './use-bundle-import';

import { OrganizationChoices } from './organization-choices';
interface BundleImportDialogProps {
  targetDocument?: DocumentSummary;
  onImported: (result: BundleImport) => void;
}
export function BundleImportDialog(props: BundleImportDialogProps) {
  const { user, epoch } = useSession();
  // A known target and retained File belong only to this owner/document context.
  return <BundleImportScope key={`${user!.id}:${epoch}:${props.targetDocument?.id ?? 'library'}`} {...props} />;
}
function BundleImportScope({ targetDocument, onImported }: BundleImportDialogProps) {
  const [organization, setOrganization] = useState<SaveOrganization>({collectionId:null,tagIds:[]});
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileChoice, setFileChoice] = useState(0);
  const state = useBundleImport(open, targetDocument, onImported);
  const active = activeImport(state.result);
  const oversized = !!file && !!state.limits.data && file.size > state.limits.data.maxArchiveBytes;
  const terminal = !!state.result && !active;
  const restoredUploadable = state.restored && (active || state.result?.status === 'failed');
  const priorTarget = restoredUploadable && !!targetDocument;
  useEffect(() => {
    if (!state.restored) return;
    // A previous selection must never be silently bound to an unknown past target.
    setFile(null);
    setFileChoice(value => value + 1);
  }, [state.result?.id, state.restored]);
  function startCurrentImport() {
    if (!state.selectFile()) return;
    setFile(null);
    setFileChoice(value => value + 1);
  }
  return (
    <Modal title="导入阅读包" open={open} onOpenChange={setOpen}
      description={restoredUploadable ? '正在查看当前账号此前的导入任务。任务目标以创建时为准。' : targetDocument ? '为此 PDF 导入本地生成的完整阅读包。原件保持不变，仅当前账号可见。' : '导入本地生成的完整阅读包 ZIP。原件和阅读内容仅当前账号可见。'}
      trigger={<Button>导入阅读包</Button>}>
      <form onSubmit={event => { event.preventDefault(); if (file && !oversized && !priorTarget) void state.submit(file, organization.collectionId || organization.tagIds.length ? organization : undefined); }}>
        <Field label="阅读包 ZIP">
          <Input key={fileChoice} type="file" accept=".zip,application/zip" disabled={state.busy || state.admissionUnknown || priorTarget || (active && state.result?.status !== 'created')}
            onChange={event => { if (state.selectFile()) setFile(event.target.files?.[0] ?? null); }} />
        </Field>
        {!targetDocument && !state.result && <fieldset disabled={state.busy || state.classificationLocked}><OrganizationChoices value={organization} onChange={setOrganization} />{state.classificationLocked && <p className="muted">本次分类随导入请求保留，重试使用相同选择。</p>}</fieldset>}
        {file && <p className="muted">已选择：{file.name}</p>}
        {state.limits.data && <p className="muted">服务器大小限制：ZIP ≤ {formatBytes(state.limits.data.maxArchiveBytes)}；原 PDF ≤ {formatBytes(state.limits.data.maxPdfBytes)}；解压后 ≤ {formatBytes(state.limits.data.maxExpandedBytes)}，最多 {state.limits.data.maxFiles} 个文件。</p>}
        {state.limits.isPending && <p role="status">正在读取服务器限额…</p>}
        {state.limits.isError && <Feedback message="无法读取服务器限额，请检查网络后重新打开。" error />}
        {restoredUploadable && <p className="muted">此前的导入任务：目标以创建时为准。{active
          ? targetDocument ? '如需导入当前 PDF，请先取消此前任务，再重新选择阅读包。' : '等待任务完成，或取消后重新导入。'
          : targetDocument ? '此前任务已失败。请为当前 PDF 新建导入并重新选择阅读包，原任务记录保留。' : '此前任务已失败。请重新选择阅读包，开始新的导入。'}</p>}
        {state.result && <ImportStatus result={state.result} />}
        {state.busy && <p className="muted">正在导入，等待服务器确认。关闭窗口后仍可从最近导入查看。</p>}
        {state.result?.status === 'completed' && <p className="muted">导入完成只表示阅读包已校验并保存，解析与翻译状态见下方。</p>}
        {state.descriptor.data && <ReaderStatus reader={state.descriptor.data} />}
        {state.descriptor.isError && <><Feedback message="阅读包已保存，暂时无法读取版本状态。请重试查看。" error /><Button type="button" onClick={() => void state.descriptor.refetch()}>重试查看状态</Button></>}
        <Feedback message={oversized ? '文件超出服务器大小限制，请选择较小的阅读包。' : state.error} error />
        <div className="form-actions">
          {priorTarget && state.result?.status === 'failed' && <Button type="button" onClick={startCurrentImport}>为当前 PDF 新建导入</Button>}
          {active && <Button type="button" onClick={() => void state.cancel()}>取消导入</Button>}
          {!priorTarget && (!terminal || state.result?.status === 'failed') && <Button primary type="submit" disabled={!file || oversized || state.busy || !state.limits.data || (active && state.result?.status !== 'created')}>
            {state.busy ? '正在导入…' : state.error ? '重试导入' : '开始导入'}
          </Button>}
          {state.result?.status === 'completed' && <Link className="button" to={`/library/${state.result.documentId}`} onClick={() => setOpen(false)}>查看资料</Link>}
        </div>
      </form>
      {state.recent.data && state.recent.data.length > 0 && !active && !state.busy && <div className="recent-imports">
        <h3>最近导入</h3>
        {state.recent.data.slice(0, 5).map(item => <Button key={item.id} onClick={() => state.restore(item)}>{item.createdAt.slice(0, 16).replace('T', ' ')} · {recentLabel(item)}</Button>)}
      </div>}
      {state.recent.isError && <Feedback message="最近导入暂不可用。请检查网络后重新打开，避免重复导入。" error />}
    </Modal>
  );
}
function formatBytes(bytes: number) {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MiB`;
}
function recentLabel(item: BundleImport) {
  return { created: '等待上传', receiving: '上传中', validating: '校验中', completed: '已导入', failed: '失败', cancelled: '已取消' }[item.status];
}
