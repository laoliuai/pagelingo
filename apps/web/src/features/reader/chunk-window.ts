export type InteractionOrigin = 'user' | 'restore' | 'layout';
export interface ContentPosition { blockId: string | null; blockOffset: number }
export interface ContentTarget extends ContentPosition { sequence: number; origin: InteractionOrigin; chunkIndex?: number }
export interface WindowSnapshot<Chunk> { current: number; cachedResponses: number; chunks: readonly Chunk[]; loading: boolean; error: string }

/** A reader owns this cache. No chunk data enters the application's query cache. */
export class ChunkWindow<Chunk extends { id: string; parseId: string; sourceSha256: string }> {
  private responses = new Map<string, Chunk>();
  private listeners = new Set<() => void>();
  private scope = new AbortController();
  private serial = 0;
  private snapshot: WindowSnapshot<Chunk> = { current: 0, cachedResponses: 0, chunks: [], loading: true, error: '' };
  constructor(private readonly descriptor: { index: { chunks: readonly { id: string }[] }; parseId: string; source: { sha256: string } }, private readonly fetchChunk: (id: string, signal: AbortSignal) => Promise<Chunk>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  private publish(current: number, loading: boolean, error = '') {
    this.snapshot = { current, cachedResponses: this.responses.size, loading, error, chunks: this.descriptor.index.chunks.slice(Math.max(0, current - 1), current + 2).flatMap(chunk => this.responses.has(chunk.id) ? [this.responses.get(chunk.id)!] : []) };
    this.listeners.forEach(listener => listener());
  }
  select(current: number) {
    current = Math.max(0, Math.min(this.descriptor.index.chunks.length - 1, current));
    this.scope.abort(); this.scope = new AbortController(); const signal = this.scope.signal; const serial = ++this.serial;
    const selected = this.descriptor.index.chunks.slice(Math.max(0, current - 1), current + 2);
    const wanted = new Set(selected.map(chunk => chunk.id));
    for (const id of this.responses.keys()) if (!wanted.has(id)) this.responses.delete(id);
    this.publish(current, selected.some(chunk => !this.responses.has(chunk.id)));
    let error = '';
    let pending = selected.filter(chunk => !this.responses.has(chunk.id)).length;
    for (const chunk of selected) {
      if (this.responses.has(chunk.id)) continue;
      void this.fetchChunk(chunk.id, signal).then(data => {
        if (signal.aborted || serial !== this.serial) return;
        if (data.id !== chunk.id || data.parseId !== this.descriptor.parseId || data.sourceSha256 !== this.descriptor.source.sha256) throw new Error('Reader chunk identity mismatch');
        this.responses.set(chunk.id, data); this.publish(current, --pending > 0, error);
      }).catch(() => {
        if (!signal.aborted && serial === this.serial) { pending--; error = '正文加载失败，请重试。'; this.publish(current, pending > 0, error); }
      });
    }
  }
  dispose() { ++this.serial; this.scope.abort(); this.responses.clear(); this.publish(0, false); }
}
