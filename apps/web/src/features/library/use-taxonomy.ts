import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { useSession } from '../../app/session';
import { apiRequest } from '../../shared/api-client';
export interface TaxonomyItem { id: string; name: string }
export interface TaxonomyPage { items: TaxonomyItem[]; nextCursor: string | null }
export function useTaxonomy(kind: 'collections' | 'tags', q = '') {
  const { user, epoch } = useSession();
  return useInfiniteQuery({ queryKey: [user!.id, 'taxonomy', epoch, kind, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiRequest<TaxonomyPage>(`/api/v1/capture-options?${new URLSearchParams({ kind, q, ...(pageParam ? { cursor: pageParam } : {}) })}`, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
}

/** Selected identities are bounded by the organization contract, independent of a search page. */
export function useSelectedTaxonomy(kind: 'collections' | 'tags', ids: string[]) {
  const { user, epoch } = useSession();
  const bounded = [...new Set(ids)].filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).slice(0,32);
  return useQueries({ queries: bounded.map(id => ({ queryKey: [user!.id,'taxonomy-item',epoch,kind,id],
    queryFn: ({ signal }: { signal: AbortSignal }) => apiRequest<TaxonomyItem>(`/api/v1/${kind}/${id}`, {signal}),
  })) }).flatMap(query => query.data ? [query.data] : []);
}
