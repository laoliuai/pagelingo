import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { AssistantHistory, emptyConversation } from '../../src/assistant/storage';
const databases: AssistantHistory[] = [];
const make = (count = 2, activeKeys = async () => new Set<string>()) => {
  const db = new AssistantHistory({ name: crypto.randomUUID(), count, activeKeys });
  databases.push(db);
  return db;
};
const conversation = (key: string) => ({
  ...emptyConversation({ key, title: key, revision: '1' }),
  messages: [{ id: 'u', role: 'user' as const, text: 'question', quotes: [], createdAt: 1 }],
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
it('persists drafts and quotes without adding empty drafts to the history list', async () => {
  const db = make();
  const c = emptyConversation({ key: 'web:a', title: 'Article', revision: '1' });
  c.draft.text = 'unfinished question';
  await db.save(c, 0);
  expect((await db.get(c.key))?.draft.text).toBe('unfinished question');
  expect(await db.list()).toEqual([]);
});
it('enforces the URL history limit and retains newest conversations', async () => {
  const db = make();
  for (const key of ['a', 'b', 'c']) await db.save(conversation(key), 0);
  expect((await db.list()).map((c) => c.key).sort()).toEqual(['b', 'c']);
});
it('rejects stale multi-window writes instead of losing newer history', async () => {
  const db = make();
  const c = await db.save(conversation('a'), 0);
  c.draft.text = 'new';
  await db.save(c, c.version);
  await expect(db.save({ ...c, draft: { ...c.draft, text: 'stale' } }, c.version)).rejects.toThrow(
    '其他窗口',
  );
  expect((await db.get('a'))?.draft.text).toBe('new');
});
it('recovers unfinished streaming messages after a crashed or closed sidebar', async () => {
  const db = make();
  const c = conversation('a');
  const value = {
    ...c,
    messages: [
      ...c.messages,
      {
        id: 'a',
        role: 'assistant' as const,
        text: 'partial answer',
        status: 'streaming' as const,
        createdAt: 2,
      },
    ],
  };
  await db.save(value, 0);
  const got = await db.get('a');
  expect(got?.messages[1]).toMatchObject({ text: 'partial answer', status: 'interrupted' });
});
it('protects active conversations during eviction and deletion', async () => {
  const db = make(1, async () => new Set(['a']));
  await db.save(conversation('a'), 0);
  await db.save(conversation('b'), 0);
  expect((await db.list()).map((c) => c.key).sort()).toEqual(['a', 'b']);
  await expect(db.delete('a')).rejects.toThrow('正在生成');
});
it('enforces byte capacity and leaves the old record intact if one conversation exceeds it', async () => {
  const db = new AssistantHistory({
    name: crypto.randomUUID(),
    count: 50,
    bytes: 1500,
    activeKeys: async () => new Set(),
  });
  databases.push(db);
  for (const key of ['a', 'b', 'c']) {
    const c = conversation(key);
    c.messages[0].text = 'x'.repeat(800);
    await db.save(c, 0);
  }
  expect((await db.list()).map((c) => c.key)).toEqual(['c']);
  const old = (await db.get('c'))!;
  old.messages[0].text = 'y'.repeat(2500);
  await expect(db.save(old, old.version)).rejects.toThrow('容量上限');
  expect((await db.get('c'))?.messages[0].text).toBe('x'.repeat(800));
});
