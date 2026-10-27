import { useRef, useState, type ReactNode } from 'react';
export type ReaderView = 'split' | 'source' | 'content';
export function ReaderLayout({ view, source, content }: { view: ReaderView; source: ReactNode; content: ReactNode }) {
  const [width, setWidth] = useState(50); const root = useRef<HTMLDivElement>(null);
  const update = (value: number) => setWidth(Math.round(Math.min(70, Math.max(30, value))));
  return <div ref={root} className={`reader-layout reader-view-${view}`} style={{ gridTemplateColumns: view === 'split' ? `minmax(0, ${width}fr) 10px minmax(0, ${100 - width}fr)` : 'minmax(0, 1fr)' }}>
    <div className="reader-source-pane" hidden={view === 'content'}>{source}</div>
    {view === 'split' && <div className="reader-resizer" role="separator" aria-label="调整分栏" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={width} tabIndex={0}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = root.current!.getBoundingClientRect(); update((event.clientX - box.left) / box.width * 100); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={event => { const next = event.key === 'Home' ? 30 : event.key === 'End' ? 70 : event.key === 'ArrowLeft' ? width - 5 : event.key === 'ArrowRight' ? width + 5 : null; if (next !== null) { event.preventDefault(); update(next); } }} />}
    <div className="reader-content-pane" hidden={view === 'source'}>{content}</div>
  </div>;
}
