type Waiting = { start(): void; cancel(): void };

/** One shared instance can enforce a provider limit across documents/applications. */
export class ConcurrencyScheduler {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Waiting[]>();
  private readonly cooldowns = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限必须为正整数。');
  }
  /** Delay new requests for an endpoint without occupying an active slot. */
  deferUntil(key: string, deadline: number): void {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, deadline));
    this.drain(key);
  }
  run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const queue = this.queues.get(key) ?? [];
      this.queues.set(key, queue);
      const item: Waiting = {
        start: () => {
          signal?.removeEventListener('abort', item.cancel);
          this.active.set(key, (this.active.get(key) ?? 0) + 1);
          void Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => {
            this.active.set(key, this.active.get(key)! - 1);
            this.drain(key);
          });
        },
        cancel: () => {
          const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1);
          reject(signal?.reason); this.drain(key);
        },
      };
      signal?.addEventListener('abort', item.cancel, { once: true });
      queue.push(item); this.drain(key);
    });
  }
  private drain(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(key); }
    const queue = this.queues.get(key);
    const remaining = (this.cooldowns.get(key) ?? 0) - Date.now();
    if (remaining <= 0) this.cooldowns.delete(key);
    if (!queue) return;
    if (remaining > 0 && queue.length) {
      this.timers.set(key, setTimeout(() => { this.timers.delete(key); this.drain(key); }, Math.min(remaining, 2_147_483_647)));
      return;
    }
    while ((this.active.get(key) ?? 0) < this.limit && queue.length) queue.shift()!.start();
    if (!queue.length && !this.active.get(key)) { this.queues.delete(key); this.active.delete(key); }
  }
}
