import { useMemo, useState } from 'react';
import type { ReaderIndex } from '@pagelingo/document-contracts';
import { Button } from '../../shared/ui/button';
export function ReaderToc({ index, onSelect }: { index: ReaderIndex; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(() => window.innerWidth >= 768); const [expanded, setExpanded] = useState(new Set<string>()); const [page, setPage] = useState(0);
  const entries = useMemo(() => {
    const parents = new Map(index.toc.map(entry => [entry.nodeId, entry.parentId]));
    return index.toc.filter(entry => {
      let parent = entry.parentId;
      while (parent) {
        if (!expanded.has(parent)) return false;
        parent = parents.get(parent) ?? null;
      }
      return true;
    });
  }, [index.toc, expanded]);
  const visible = entries.slice(page * 200, page * 200 + 200);
  return <div className="reader-toc"><Button aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起目录' : '展开目录'}</Button>{open && <nav aria-label="阅读目录">
    {visible.map(entry => <div key={entry.nodeId} data-toc-entry style={{ paddingLeft: Math.min(entry.depth - 1, 5) * 10 }}><button onClick={() => onSelect(entry.blockId)}>{entry.title}</button>{index.toc.some(child => child.parentId === entry.nodeId) && <button aria-label={`${expanded.has(entry.nodeId) ? '收起' : '展开'}章节 ${entry.title}`} onClick={() => { setPage(0); setExpanded(previous => { const next = new Set(previous); if (next.has(entry.nodeId)) next.delete(entry.nodeId); else next.add(entry.nodeId); return next; }); }}>{expanded.has(entry.nodeId) ? '−' : '+'}</button>}</div>)}
    {entries.length > 200 && <div className="reader-toc-pages"><Button disabled={page === 0} onClick={() => setPage(page - 1)}>上一组目录</Button><span>{page + 1} / {Math.ceil(entries.length / 200)}</span><Button disabled={(page + 1) * 200 >= entries.length} onClick={() => setPage(page + 1)}>下一组目录</Button></div>}
    {!entries.length && <p>此文档没有章节目录。</p>}
  </nav>}</div>;
}
