import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScanLine } from 'lucide-react';
import { createPortal } from 'react-dom';
import { renderWebChunk } from '@pagelingo/document-renderer';
import type { WebSourceRef, WebReaderChunk, WebReaderDescriptor } from '@pagelingo/document-contracts';
import { Button } from '../../shared/ui/button';
import { type ContentPosition, type ContentTarget, type InteractionOrigin } from '../reader/window-state';
import { WebReaderWindow } from './web-reader-window';
export type ContentMode = 'source' | 'translation' | 'bilingual';
export interface ReaderContentProps {
  descriptor: WebReaderDescriptor;
  mode: ContentMode;
  onLocate: (references: readonly WebSourceRef[]) => void;
  onPositionChange?: (position: ContentPosition, origin: InteractionOrigin) => void;
  target?: ContentTarget;
  selection?: ReadonlySet<string>;
  onSelection?: (id: string, selected: boolean) => void;
  large?: boolean;
  visible?: boolean;
}
const TrustedChunk = memo(function TrustedChunk({ chunk, descriptor, mode, selection, onSelection }: { chunk: WebReaderChunk; descriptor: WebReaderDescriptor; mode: ContentMode; selection?: ReadonlySet<string>; onSelection?: (id: string, selected: boolean) => void }) {
  const rendered = useMemo(() => renderWebChunk(chunk, { mode, resolveAsset: id => {
    const asset = descriptor.assetMap[id]; if (!asset || !/^[a-f0-9-]{36}$/.test(asset)) throw new Error('Missing owned Reader asset');
    return `/api/v1/documents/${descriptor.documentId}/web-reader/versions/${descriptor.versionId}/assets/${asset}`;
  } }), [chunk, descriptor, mode]);
  const root = useRef<HTMLDivElement>(null); const [blocks, setBlocks] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => { setBlocks([...root.current!.querySelectorAll<HTMLElement>('[data-block-id]')]); }, [rendered]);
  return <div data-reader-chunk={chunk.id}>
    <div ref={root} onErrorCapture={event => { if (event.target instanceof HTMLImageElement) { event.target.hidden = true; const warning = document.createElement('p'); warning.setAttribute('role', 'status'); warning.textContent = '归档图片无法解码或已缺失：' + event.target.alt; event.target.after(warning); } }} dangerouslySetInnerHTML={{ __html: rendered }} />
    {blocks.map(block => createPortal(<>{onSelection && chunk.blocks.find(entry => entry.source.id === block.dataset.blockId)?.source.type === 'text' && <label className="block-select"><input aria-label="选择翻译段落" type="checkbox" checked={selection?.has(block.dataset.blockId!) ?? false} onChange={event => onSelection(block.dataset.blockId!, event.target.checked)} />翻译此段</label>}<button className="block-locate" data-locate-block={block.dataset.blockId} aria-label="定位快照" title="定位归档快照"><ScanLine size={15} aria-hidden="true" /></button></>, block, block.dataset.blockId))}

  </div>;
});
export function WebReaderContent({ descriptor, mode, onLocate, onPositionChange, target, selection, onSelection, large = false, visible = true }: ReaderContentProps) {
  const store = useMemo(() => new WebReaderWindow(descriptor), [descriptor.documentId, descriptor.versionId, descriptor.parseId, descriptor.source.sha256]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const root = useRef<HTMLDivElement>(null);
  const [tailSpace, setTailSpace] = useState(0);
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const resize = new ResizeObserver(() => setTailSpace(element.clientHeight));
    resize.observe(element); return () => resize.disconnect();
  }, []);
  const [input, setInput] = useState('1');
  const pendingTarget = useRef<ContentTarget | null>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const userUntil = useRef(0);
  const onPosition = useRef(onPositionChange); onPosition.current = onPositionChange;
  const indices = useMemo(() => new Map(descriptor.index.chunks.map((chunk, i) => [chunk.id, i])), [descriptor]);
  const jump = (next: ContentTarget) => {
    userUntil.current = 0; anchor.current = null; pendingTarget.current = next;
    const id = next.blockId && descriptor.index.blockLocations[next.blockId]?.chunkId;
    const current = next.chunkIndex ?? (id ? indices.get(id) : 0) ?? 0;
    store.select(current); setInput(String(current + 1));
  };
  useEffect(() => { store.select(0); return () => store.dispose(); }, [store]);
  useEffect(() => { if (target) jump(target); }, [target, store]);
  useLayoutEffect(() => {
    const element = root.current; if (!element || !visible || !element.clientHeight) return;
    const destination = pendingTarget.current;
    if (destination) {
      if (state.loading) return;
      // A newly visible pane can precede ResizeObserver. Commit enough tail before scrolling.
      if (tailSpace < element.clientHeight) { setTailSpace(element.clientHeight); return; }
      const id = destination.blockId ?? descriptor.index.chunks[state.current]?.blockIds[0];
      const block = id ? element.querySelector<HTMLElement>(`[data-block-id="${id}"]`) : null;
      if (!block) return;
      userUntil.current = 0;
      const viewportTop = element.getBoundingClientRect().top;
      const before = block.getBoundingClientRect(); if (!before.height) return;
      element.scrollTop += before.top - viewportTop + before.height * destination.blockOffset;
      const actualOffset = Math.max(0, Math.min(1, (viewportTop - block.getBoundingClientRect().top) / before.height));
      // A clamped assignment is not a restore. Keep the target for the next geometry update.
      if (Math.abs(actualOffset - destination.blockOffset) * before.height > 1) return;
      pendingTarget.current = null;
      onPosition.current?.({ blockId: id ?? null, blockOffset: actualOffset }, destination.origin);
    } else if (anchor.current) {
      const block = element.querySelector<HTMLElement>(`[data-block-id="${anchor.current.id}"]`);
      if (block) { userUntil.current = 0; element.scrollTop += block.getBoundingClientRect().top - anchor.current.top; }
      if (!state.loading) anchor.current = null;
    }
  }, [state, descriptor, visible, tailSpace]);
  useLayoutEffect(() => { userUntil.current = 0; }, [mode, large]);
  useEffect(() => {
    const resetIntent = () => { userUntil.current = 0; };
    window.addEventListener('resize', resetIntent);
    return () => window.removeEventListener('resize', resetIntent);
  }, []);
  const onScroll = () => {
    if (!root.current) return;
    const origin: InteractionOrigin = performance.now() < userUntil.current ? 'user' : 'layout';
    if (pendingTarget.current && origin !== 'user') return;
    // A deliberate scroll supersedes a jump still waiting for its neighbours.
    if (origin === 'user') pendingTarget.current = null;
    const top = root.current.getBoundingClientRect().top;
    const block = [...root.current.querySelectorAll<HTMLElement>('[data-block-id]')].find(node => node.getBoundingClientRect().bottom > top + 1);
    if (!block) return;
    const rect = block.getBoundingClientRect(); const id = block.dataset.blockId!;
    onPosition.current?.({ blockId: id, blockOffset: Math.max(0, Math.min(1, (top - rect.top) / rect.height)) }, origin);
    const current = indices.get(descriptor.index.blockLocations[id]?.chunkId);
    if (origin === 'user' && (state.loading || current !== state.current)) anchor.current = { id, top: rect.top };
    if (origin === 'user' && current !== undefined && current !== state.current) {
      store.select(current); setInput(String(current + 1));
    }
  };
  const arm = () => { userUntil.current = performance.now() + 800; };
  return <div className="reader-body">
    <form className="reader-chunk-nav" onSubmit={event => { event.preventDefault(); jump({ blockId: null, blockOffset: 0, chunkIndex: Math.max(0, Math.min(descriptor.index.chunks.length - 1, Number(input) - 1)), sequence: Date.now(), origin: 'user' }); }}>
      <Button type="button" disabled={state.current === 0} onClick={() => jump({ blockId: null, blockOffset: 0, chunkIndex: state.current - 1, sequence: Date.now(), origin: 'user' })}>上一片</Button>
      <label>正文分片 <input aria-label="正文分片" type="number" min="1" max={descriptor.index.chunks.length} value={input} onChange={event => setInput(event.target.value)} /></label><span>/ {descriptor.index.chunks.length}</span><Button type="submit">跳转正文</Button>
      <Button disabled={state.current >= descriptor.index.chunks.length - 1} onClick={() => jump({ blockId: null, blockOffset: 0, chunkIndex: state.current + 1, sequence: Date.now(), origin: 'user' })}>下一片</Button>
    </form>
    <div ref={root} className={`reader-content${large ? ' reader-large' : ''}`} tabIndex={0} aria-label="正文，可独立滚动" data-cached-chunks={state.cachedResponses}
      onWheel={arm} onTouchMove={arm} onPointerDown={event => { if (event.target === event.currentTarget) arm(); }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) arm(); }} onScroll={onScroll}
      onClick={event => {
        const element = event.target instanceof Element ? event.target : null;
        const button = element?.closest<HTMLElement>('[data-locate-block]');
        if (button) {
          const entry = state.chunks.flatMap(chunk => chunk.blocks).find(block => block.source.id === button.dataset.locateBlock);
          if (entry) onLocate(entry.source.sourceRefs);
        }
        const link = element?.closest<HTMLElement>('[data-block-link]'); const id = link?.dataset.blockLink;
        if (id) { event.preventDefault(); if (Object.hasOwn(descriptor.index.blockLocations, id)) jump({ blockId: id, blockOffset: 0, sequence: Date.now(), origin: 'user' }); }
      }}>
      {state.loading && <p role="status" className="reader-message">正在加载正文…</p>}
      {state.error && <div className="reader-message" role="alert">{state.error}<Button onClick={() => store.select(state.current)}>重试正文</Button></div>}
      {state.chunks.map(chunk => <TrustedChunk key={chunk.id} chunk={chunk} descriptor={descriptor} mode={mode} selection={selection} onSelection={onSelection} />)}
      <div aria-hidden="true" style={{ height: tailSpace, flexShrink: 0 }} />
    </div>
  </div>;
}
