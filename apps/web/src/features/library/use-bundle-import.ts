import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArxivSourceRevision, BundleImport, BundleLimits, DocumentSummary, ReaderDescriptor, SaveOrganization, CreateBundleImportRequest } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { ApiError, apiRequest, uploadBundleContent } from '../../shared/api-client';
import { activeImport } from './import-status';

export function importError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : typeof error === 'string' ? error : '';
  switch (code) {
    case 'SOURCE_VERSION_MISMATCH':
    case 'SOURCE_MISMATCH': return '阅读包与此 PDF 原件不匹配。请选择由同一原件生成的包。';
    case 'BUNDLE_TOO_LARGE': return '阅读包超出服务器大小限制。请缩小阅读包后重新导出。';
    case 'BUNDLE_MISSING_RESOURCE': return '阅读包缺少资源。请重新导出完整 ZIP。';
    case 'INVALID_BUNDLE': return '阅读包校验失败。请检查文件完整性并重新导出。';
    case 'BUNDLE_IDENTITY_CONFLICT': return '阅读包标识与已有内容冲突。请重新导出新包。';
    case 'BUNDLE_IMPORT_BUSY':
    case 'BUNDLE_BUSY': return '已有导入正在进行。请查看最近导入，完成或取消后再试。';
    case 'BUNDLE_ABORTED': return '上传连接中断。请重新选择文件并重试。';
    case 'BUNDLE_LEASE_EXPIRED':
    case 'BUNDLE_UPLOAD_TIMEOUT':
    case 'BUNDLE_VALIDATION_TIMEOUT':
    case 'BUNDLE_IMPORT_EXPIRED': return '导入已超时。请重新选择文件后重试。';
    default: return '导入尚未确认。请检查网络并重试；会先查询服务器状态，保留本次导入标识。';
  }
}
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
// These create-route responses prove this key did not admit a row. Other errors
// (including transport/5xx/conflict/retirement) cannot release its pinned input.
const rejectedAdmission = (error: unknown) => error instanceof ApiError && (
  (error.status === 400 && error.code === 'INVALID_REQUEST') ||
  (error.status === 404 && error.code === 'NOT_FOUND') ||
  (error.status === 409 && error.code === 'BUNDLE_IMPORT_BUSY')
);

export function useBundleImport(open: boolean, targetDocument: DocumentSummary | undefined, onImported: (result: BundleImport) => void, targetRevision?: ArxivSourceRevision) {
  const { user } = useSession();
  const client = useQueryClient();
  const [result, setResult] = useState<BundleImport | null>(null);
  const resultRef = useRef<BundleImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef('');
  const admittedRequest = useRef<CreateBundleImportRequest | null>(null);
  const [classificationLocked,setClassificationLocked] = useState(false);
  const locked = useRef(false);
  const cancelling = useRef(false);
  const content = useRef<AbortController | null>(null);
  const lifetime = useRef(new AbortController());
  const acknowledged = useRef(new Set<string>());
  const createdHere = useRef(new Set<string>());
  const limits = useQuery({
    queryKey: [user!.id, 'bundle-import-limits'], enabled: open,
    queryFn: ({ signal }) => apiRequest<BundleLimits>('/api/v1/bundle-imports/limits', { signal }),
  });
  const recent = useQuery({
    queryKey: [user!.id, 'bundle-imports'], enabled: open,
    queryFn: ({ signal }) => apiRequest<BundleImport[]>('/api/v1/bundle-imports', { signal }),
  });
  const accept = useCallback((next: BundleImport) => {
    if (lifetime.current.signal.aborted) return;
    const previous = resultRef.current;
    if (previous?.id === next.id) {
      if (previous.epoch > next.epoch) return;
      if (previous.epoch === next.epoch && !activeImport(previous) && activeImport(next)) return;
    }
    resultRef.current = next;
    setError('');
    setResult(next);
    client.setQueryData<BundleImport[]>([user!.id, 'bundle-imports'], previous =>
      [next, ...(previous ?? []).filter(item => item.id !== next.id)].slice(0, 20));
  }, [client, user!.id]);
  useEffect(() => {
    const active = recent.data?.find(activeImport);
    // A recent row cannot identify our unacknowledged create. Replay its original key first.
    if (active && !result && admittedRequest.current === null) accept(active);
  }, [recent.data, result, accept]);
  useEffect(() => {
    if (!activeImport(result)) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await apiRequest<BundleImport>(`/api/v1/bundle-imports/${result!.id}`, { signal: controller.signal });
        if (!cancelling.current) accept(next);
      } catch (error) {
        if (!aborted(error)) setError(importError(error));
      }
    };
    const timer = setInterval(() => void poll(), 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [result?.id, result?.status, accept]);
  useEffect(() => {
    if (result?.status !== 'completed' || acknowledged.current.has(result.id)) return;
    acknowledged.current.add(result.id);
    void client.invalidateQueries({ queryKey: [user!.id, 'documents'] });
    void client.invalidateQueries({ queryKey: [user!.id, 'document', result.documentId] });
    onImported(result);
  }, [result, client, user, onImported]);
  useEffect(() => {
    const controller = lifetime.current;
    return () => { controller.abort(); content.current?.abort(); };
  }, []);
  const descriptor = useQuery({
    queryKey: [user!.id, 'imported-reader', result?.documentId, result?.readerVersionId],
    enabled: result?.status === 'completed' && !!result.documentId && !!result.readerVersionId,
    queryFn: ({ signal }) => apiRequest<ReaderDescriptor>(`/api/v1/documents/${result!.documentId}/reader?versionId=${result!.readerVersionId}`, { signal }),
  });
  function selectFile(): boolean {
    // A missing create ACK is not permission to abandon the admitted input.
    // Check the refs too: a queued file-change event may precede the disabled UI.
    if (busy || locked.current || (admittedRequest.current !== null && resultRef.current === null)) return false;
    if (activeImport(resultRef.current)) { setError(''); return true; }
    key.current = ''; admittedRequest.current=null; setClassificationLocked(false);
    resultRef.current = null;
    setResult(null);
    setError('');
    return true;
  }
  async function submit(file: File, organization?: SaveOrganization) {
    if (locked.current || !limits.data || file.size > limits.data.maxArchiveBytes) return;
    // Restored uploadable tasks lack a target in the DTO; never infer this detail's PDF.
    if (targetDocument && result && !createdHere.current.has(result.id)) return;
    locked.current = true; setBusy(true); setError('');
    const signal = lifetime.current.signal;
    let admissionWasRejected = false;
    try {
      let current = result;
      // A retry always reconciles server state before sending more bytes.
      if (current) current = await apiRequest<BundleImport>(`/api/v1/bundle-imports/${current.id}`, { signal });
      if (!current) {
        key.current ||= crypto.randomUUID();
        admittedRequest.current ??= targetDocument ? {
          targetDocumentId: targetDocument.id,
          ...(targetRevision?.sourceVersionId ? {
            targetSourceVersionId: targetRevision.sourceVersionId,
            targetPaperVersion: targetRevision.version,
          } : {}),
        } : (organization ? { organization: structuredClone(organization) } : {});
        setClassificationLocked(true);
        try {
          current = await apiRequest<BundleImport>('/api/v1/bundle-imports', {
            method: 'POST', body: admittedRequest.current,
            idempotencyKey: key.current, signal,
          });
        } catch (error) {
          if (rejectedAdmission(error)) {
            admissionWasRejected = true;
            key.current = ''; admittedRequest.current = null; setClassificationLocked(false);
          }
          throw error;
        }
        createdHere.current.add(current.id);
      }
      accept(current);
      if (current.status !== 'created' && current.status !== 'failed') return;
      const controller = new AbortController(); content.current = controller;
      try {
        const next = await uploadBundleContent<BundleImport>(current.id, file, AbortSignal.any([signal, controller.signal]));
        if (!cancelling.current) accept(next);
      } catch (error) {
        if (aborted(error) || cancelling.current) return;
        // A missing acknowledgement is not a failed ingestion. GET before any retry.
        try {
          const recovered = await apiRequest<BundleImport>(`/api/v1/bundle-imports/${current.id}`, { signal });
          if (!cancelling.current) accept(recovered);
          if (recovered.status === 'completed') return;
        } catch (recoveryError) { if (aborted(recoveryError)) return; }
        setError(importError(error));
      }
    } catch (error) {
      if (!aborted(error)) {
        setError(admissionWasRejected ? '服务器未接受本次导入。请核对分类和目标资料后重试，或重新选择阅读包。' : importError(error));
        void recent.refetch();
      }
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    if (!result || cancelling.current) return;
    cancelling.current = true; setError('');
    try {
      const next = await apiRequest<BundleImport>(`/api/v1/bundle-imports/${result.id}/cancel`, { method: 'POST', body: {}, signal: lifetime.current.signal });
      accept(next);
      // Server's terminal answer wins even if publication completed during cancellation.
      content.current?.abort();
    } catch (error) {
      if (aborted(error)) return;
      // Completion wins the race. Re-read the server's terminal result before stopping local IO.
      if (error instanceof ApiError && error.code === 'BUNDLE_IMPORT_COMPLETED') {
        try {
          const confirmed = await apiRequest<BundleImport>(`/api/v1/bundle-imports/${result.id}`, { signal: lifetime.current.signal });
          accept(confirmed);
          if (!activeImport(confirmed)) content.current?.abort();
          return;
        } catch (recoveryError) { if (aborted(recoveryError)) return; }
      }
      setError('取消尚未确认，请检查网络后重试取消。');
    } finally { cancelling.current = false; }
  }
  return { result, busy, classificationLocked, admissionUnknown: classificationLocked && result === null, error: result?.status === 'failed' ? importError(result.errorCode) : error,
    limits, recent, descriptor, submit, cancel, selectFile, restore: (next: BundleImport) => {
      if (locked.current || (admittedRequest.current !== null && resultRef.current === null)) return;
      accept(next);
    }, restored: !!result && !createdHere.current.has(result.id) };
}
