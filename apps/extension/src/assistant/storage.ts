import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  conversationSchema,
  historyEvictions,
  type Conversation,
  type ConversationStore,
} from '@pagelingo/assistant-core';

interface StoredConversation {
  key: string;
  data: Conversation;
  bytes: number;
  updatedAt: number;
}
interface AssistantDatabase extends DBSchema {
  conversations: { key: string; value: StoredConversation };
}
export class ConversationConflictError extends Error {
  constructor() {
    super('此对话已在其他窗口更新，请重新载入后操作。');
  }
}
export const conversationLockName = (key: string) => `pagelingo-assistant:${key}`;
export async function activeConversationKeys(): Promise<Set<string>> {
  if (!globalThis.navigator?.locks) return new Set();
  const locks = await navigator.locks.query();
  return new Set(
    (locks.held ?? []).flatMap((lock) =>
      lock.name?.startsWith('pagelingo-assistant:') ? [lock.name.slice(20)] : [],
    ),
  );
}
export class AssistantHistory implements ConversationStore {
  private db: Promise<IDBPDatabase<AssistantDatabase>>;
  private limits: { count: number; bytes: number };
  constructor(
    options: { name?: string; count?: number; bytes?: number; activeKeys?: () => Promise<Set<string>> } = {},
  ) {
    this.limits = { count: options.count ?? 50, bytes: options.bytes ?? 64 * 1024 * 1024 };
    this.activeKeys = options.activeKeys ?? activeConversationKeys;
    this.db = openDB<AssistantDatabase>(options.name ?? 'pagelingo-assistant', 1, {
      upgrade(db) {
        db.createObjectStore('conversations', { keyPath: 'key' });
      },
      blocking: () => {
        void this.db.then((db) => db.close());
      },
    });
  }
  private activeKeys: () => Promise<Set<string>>;
  configure(count: number, bytes: number) {
    this.limits = { count, bytes };
  }
  async get(key: string): Promise<Conversation | undefined> {
    const record = await (await this.db).get('conversations', key);
    if (!record) return;
    let data = conversationSchema.parse(record.data);
    if (
      data.messages.some((m) => m.role === 'assistant' && m.status === 'streaming') &&
      !(await this.activeKeys()).has(key)
    ) {
      data.messages = data.messages.map((m) =>
        m.role === 'assistant' && m.status === 'streaming'
          ? { ...m, status: 'interrupted', error: '上次回答因侧栏关闭或刷新而中断，可点击重试。' }
          : m,
      );
      try {
        data = await this.save(data, data.version);
      } catch (e) {
        if (e instanceof ConversationConflictError) return this.get(key);
        throw e;
      }
    }
    return data;
  }
  async save(value: Conversation, expectedVersion: number): Promise<Conversation> {
    const data = conversationSchema.parse(value);
    const db = await this.db;
    const protectedKeys = await this.activeKeys();
    protectedKeys.add(data.key);
    const tx = db.transaction('conversations', 'readwrite');
    const done = tx.done;
    void done.catch(() => {});
    try {
      const old = await tx.store.get(data.key);
      if ((old?.data.version ?? 0) !== expectedVersion) throw new ConversationConflictError();
      const next = { ...data, version: expectedVersion + 1, updatedAt: Date.now() };
      const bytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
      if (bytes > this.limits.bytes)
        throw new Error('这篇文章的对话超过历史容量上限，请导出后清理或提高上限。');
      await tx.store.put({ key: next.key, data: next, bytes, updatedAt: next.updatedAt });
      const records = await tx.store.getAll();
      const real = records.filter((r) => r.data.messages.length > 0);
      const drafts = records.filter((r) => r.data.messages.length === 0);
      const evict = new Set(historyEvictions(real, this.limits, protectedKeys));
      for (const key of historyEvictions(
        drafts,
        { count: this.limits.count, bytes: this.limits.bytes },
        protectedKeys,
      ))
        evict.add(key);
      let total = records.filter((r) => !evict.has(r.key)).reduce((n, r) => n + r.bytes, 0);
      for (const record of [...records].sort((a, b) => a.updatedAt - b.updatedAt)) {
        if (total <= this.limits.bytes) break;
        if (protectedKeys.has(record.key) || evict.has(record.key)) continue;
        evict.add(record.key);
        total -= record.bytes;
      }
      for (const key of evict) await tx.store.delete(key);
      await done;
      return next;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already finished. */
      }
      throw error;
    }
  }
  async list(): Promise<Conversation[]> {
    return (await (await this.db).getAll('conversations'))
      .map((r) => conversationSchema.parse(r.data))
      .filter((c) => c.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async delete(key: string): Promise<void> {
    if ((await this.activeKeys()).has(key)) throw new Error('对话正在生成，请停止后删除。');
    await (await this.db).delete('conversations', key);
  }
  async clear(): Promise<void> {
    if ((await this.activeKeys()).size) throw new Error('有对话正在生成，请停止后清空历史。');
    await (await this.db).clear('conversations');
  }
  async close() {
    (await this.db).close();
  }
}
export function emptyConversation(document: {
  key: string;
  title: string;
  url?: string;
  revision: string;
}): Conversation {
  return {
    ...document,
    version: 0,
    updatedAt: Date.now(),
    messages: [],
    draft: { text: '', quotes: [], mode: 'auto' },
  };
}
