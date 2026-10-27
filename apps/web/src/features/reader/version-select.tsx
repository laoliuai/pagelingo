import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readerVersionListSchema, type ReaderDescriptor } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { translationLabel } from '../library/import-status';

export function VersionSelect({ descriptor, onSelect }: { descriptor: ReaderDescriptor; onSelect: (id?: string) => void }) {
  const { user, epoch } = useSession(); const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: [user!.id, 'reader-versions', descriptor.documentId, epoch, page],
    queryFn: async ({ signal }) => readerVersionListSchema.parse(await apiRequest(`/api/v1/documents/${descriptor.documentId}/reader-versions?page=${page}`, { signal })), gcTime: 0 });
  const items = query.data?.items ?? [];
  return <>
    <label className="reader-version-label">阅读版本 <select aria-label="阅读版本" value={descriptor.versionId} onChange={event => onSelect(event.target.value || undefined)}>
      <option value="">当前版本</option>
      {!items.some(item => item.id === descriptor.versionId) && <option value={descriptor.versionId}>正在阅读的版本</option>}
      {items.map((item, index) => <option key={item.id} value={item.id}>{(page - 1) * 20 + index + 1} · {item.createdAt.slice(0, 16).replace('T', ' ')} · {translationLabel(item.translationStatus)}{item.parseCoverage === 'partial' ? ' · 解析不完整' : ''}</option>)}
    </select></label>
    {query.error && <Button onClick={() => void query.refetch()}>重试版本</Button>}
    {query.data && query.data.total > 20 && <span className="reader-version-pages"><Button disabled={page === 1} onClick={() => setPage(page - 1)}>较新版本</Button><span>{page} / {Math.ceil(query.data.total / 20)}</span><Button disabled={page * 20 >= query.data.total} onClick={() => setPage(page + 1)}>较早版本</Button></span>}
  </>;
}
