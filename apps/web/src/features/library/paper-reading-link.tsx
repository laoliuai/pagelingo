import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DocumentSummary } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest } from '../../shared/api-client';

type Relation = { fromDocumentId: string; toDocumentId: string };

/** The paper's HTML version is the article saved beside its PDF; only that one reads and translates in the browser. */
export function PaperReadingLink({ documentId }: { documentId: string }) {
  const { user, epoch } = useSession();
  const reading = useQuery({
    queryKey: [user!.id, 'paper-reading', documentId, epoch],
    queryFn: async ({ signal }) => {
      const { items } = await apiRequest<{ items: Relation[] }>(`/api/v1/documents/${documentId}/relations`, { signal });
      const related = items.map(item => item.fromDocumentId === documentId ? item.toDocumentId : item.fromDocumentId);
      const documents = await Promise.all(related.map(id => apiRequest<DocumentSummary>(`/api/v1/documents/${id}`, { signal })));
      return documents.find(document => document.kind === 'article' && document.url.startsWith('https://arxiv.org/html/')) ?? null;
    },
  });
  if (!reading.data) return null;
  return <p><Link className="button primary" to={`/library/${reading.data.id}`}>打开网页阅读版</Link> 可翻译，支持原文、译文和中英对照</p>;
}
